Yes — this is a solid idea, and AWS’s recent rollout makes it much more practical now because Lambda response streaming is available in all commercial AWS Regions, supports the `InvokeWithResponseStream` API, and is positioned by AWS for latency-sensitive LLM workloads.  I’d frame it as a lightweight “LLM gateway” rather than a full LiteLLM clone: OpenAI-compatible surface area first, model-name-based routing second, and async observability/logging through SQS into DynamoDB so the hot path stays fast. [aws.amazon](https://aws.amazon.com/about-aws/whats-new/2026/04/aws-lambda-response-streaming/)

## Product shape

Build a serverless API that accepts an OpenAI-style request, resolves the requested `model` to a provider adapter, invokes the upstream LLM, streams tokens back to the caller, and emits an async audit event to SQS for persistence and analytics. [docs.aws.amazon](https://docs.aws.amazon.com/lambda/latest/api/API_InvokeWithResponseStream.html)

Keep v1 narrow:
- `POST /v1/chat/completions`
- `GET /v1/models`
- Optional `POST /v1/responses` later if you want a newer OpenAI-style API surface. [docs.litellm](https://docs.litellm.ai/docs/router_architecture)

## Why this architecture

Lambda streaming now works in all commercial AWS Regions, and AWS documents it as suitable for LLM apps because it reduces time-to-first-byte by sending partial responses incrementally.  For managed runtimes, response streaming is supported on Node.js, while other languages need a custom runtime or Lambda Web Adapter, so Node.js is the easiest v1 choice. [docs.aws.amazon](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)

Using SQS between request handling and log persistence is the right separation because Lambda can stay focused on low-latency serving while a separate consumer handles retries, backpressure, and DynamoDB writes.  Also, API Gateway REST can now stream Lambda responses, and the integration uses the streaming invoke path rather than normal buffered invocation. [dev](https://dev.to/pabloalbaladejo/observable-ai-streaming-on-aws-part-1-api-gateway-rest-with-lambda-595a)

## Recommended AWS stack

| Layer | Choice | Why |
|---|---|---|
| Public API | API Gateway REST API | Supports Lambda response streaming for REST APIs.  [aws.amazon](https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-response-streaming-rest-apis/) |
| Compute | Lambda, Node.js 22 | Managed runtime support for response streaming.  [docs.aws.amazon](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html) |
| Routing config | SSM Parameter Store or DynamoDB config table | Lets you change model routing without redeploying; DynamoDB fits if you want per-tenant overrides.  [aws.amazon](https://aws.amazon.com/blogs/database/build-scalable-event-driven-architectures-with-amazon-dynamodb-and-aws-lambda/) |
| Queue | SQS standard queue | Decouples request path from persistence and analytics.  [docs.aws.amazon](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html) |
| Persistence | DynamoDB | Cheap, fast, natural for request log records and tenant-scoped queries.  [aws.amazon](https://aws.amazon.com/blogs/database/build-scalable-event-driven-architectures-with-amazon-dynamodb-and-aws-lambda/) |
| Secrets | AWS Secrets Manager | Store provider API keys cleanly. |
| Metrics | CloudWatch + EMF | Native low-friction ops metrics. |
| Auth | API key first, Cognito/JWT later | Keep v1 simple. |

## Core design

Use a thin hexagonal layout so Copilot can fill in adapters fast:

```text
apps/
  gateway/
    src/
      handlers/
        chatCompletions.ts
        listModels.ts
      core/
        router.ts
        registry.ts
        policy.ts
        schemas.ts
        stream.ts
      providers/
        openai.ts
        anthropic.ts
        bedrock.ts
        gemini.ts
      logging/
        auditEvent.ts
        sqsPublisher.ts
      config/
        modelMap.ts
      auth/
        apiKey.ts
      util/
        ids.ts
        errors.ts
        time.ts
infra/
  cdk/
```

Key interfaces:

```ts
type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string };

type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  user?: string;
  metadata?: Record<string, string>;
};

type ProviderChunk =
  | { type: "delta"; text: string }
  | { type: "message_start"; id: string }
  | { type: "message_end"; finish_reason?: string }
  | { type: "usage"; input_tokens?: number; output_tokens?: number };

interface ProviderAdapter {
  supports(model: string): boolean;
  invoke(req: NormalizedRequest, ctx: RequestContext): Promise<NormalizedResponse>;
  stream(req: NormalizedRequest, ctx: RequestContext): AsyncGenerator<ProviderChunk>;
}
```

## Routing model

LiteLLM’s router value is mostly in model abstraction, fallbacks, and load balancing, so copy only those essentials first. [docs.litellm](https://docs.litellm.ai/docs/routing-load-balancing)

Use a config-driven routing table like:

```json
{
  "gpt-4o": {
    "targets": [
      { "provider": "openai", "model": "gpt-4o", "weight": 100 }
    ],
    "fallbacks": ["claude-sonnet-4", "bedrock/us.anthropic.claude-sonnet-4"]
  },
  "claude-sonnet-4": {
    "targets": [
      { "provider": "anthropic", "model": "claude-sonnet-4-20250514", "weight": 100 }
    ]
  },
  "fast": {
    "targets": [
      { "provider": "openai", "model": "gpt-4o-mini", "weight": 60 },
      { "provider": "bedrock", "model": "amazon.nova-lite-v1:0", "weight": 40 }
    ],
    "fallbacks": ["gpt-4o-mini"]
  }
}
```

Routing rules for v1:
- Exact alias match first.
- If unknown model, either reject with `400` or map through a default fallback alias such as `default-chat`; be explicit because hidden fallback behavior can confuse users. [mintlify](https://www.mintlify.com/BerriAI/litellm/features/fallbacks)
- Support weighted target selection.
- Support simple failover on retryable upstream errors: 429, 500, 502, 503, timeout.
- Do not support every provider-specific parameter in v1; normalize a safe subset.

## Request flow

1. Client sends OpenAI-style chat request.
2. API Gateway forwards to Lambda streaming integration.
3. Lambda authenticates caller and validates schema.
4. Router resolves alias to provider target.
5. Provider adapter starts upstream stream.
6. Lambda converts provider events to SSE or OpenAI-style chunk format.
7. In parallel, Lambda emits a compact audit envelope to SQS.
8. Log-writer Lambda consumes SQS and upserts full record into DynamoDB. [aws.amazon](https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-response-streaming-rest-apis/)

## Streaming format

Prefer SSE for the external wire format because it is simple and works well for chat token streaming. API Gateway response streaming is explicitly useful for protocols such as SSE in AWS guidance. [aws.amazon](https://aws.amazon.com/blogs/compute/building-responsive-apis-with-amazon-api-gateway-response-streaming/)

Example outbound chunks:

```text
event: message.start
data: {"id":"req_123","model":"gpt-4o"}

event: delta
data: {"content":"Hello"}

event: delta
data: {"content":" world"}

event: message.end
data: {"finish_reason":"stop"}

event: usage
data: {"input_tokens":123,"output_tokens":45}

event: done
data: [DONE]
```

For OpenAI compatibility, you can instead emit `chat.completion.chunk` JSON lines shaped like OpenAI responses. Keep your internal stream events provider-agnostic, then add a formatter layer.

## DynamoDB schema

Use one main table for request logs.

**Table: `llm_gateway_requests`**
- PK: `tenantId`
- SK: `ts#requestId`
- GSI1PK: `requestId`
- GSI1SK: `createdAt`
- GSI2PK: `modelAlias`
- GSI2SK: `createdAt`
- GSI3PK: `provider#status`
- GSI3SK: `createdAt`

Suggested item:

```json
{
  "tenantId": "t_default",
  "requestId": "req_01...",
  "createdAt": "2026-04-11T06:20:00Z",
  "modelAlias": "fast",
  "resolvedProvider": "openai",
  "resolvedModel": "gpt-4o-mini",
  "stream": true,
  "status": "completed",
  "latencyMs": 1820,
  "ttfbMs": 320,
  "inputTokens": 120,
  "outputTokens": 48,
  "estimatedCostUsd": 0.00192,
  "userId": "u_123",
  "metadata": { "traceId": "..." },
  "errorCode": null
}
```

For payload storage:
- Store request/response bodies only if needed.
- If storing prompts/completions, consider truncation or S3 offload for large bodies.
- Add TTL for cost control on verbose logs.

## SQS event contract

Publish one compact event from the serving Lambda, and let the consumer enrich if needed.

```json
{
  "version": 1,
  "type": "llm.request.completed",
  "requestId": "req_01",
  "tenantId": "t_default",
  "createdAt": "2026-04-11T06:20:00Z",
  "modelAlias": "fast",
  "provider": "openai",
  "providerModel": "gpt-4o-mini",
  "stream": true,
  "status": "completed",
  "latencyMs": 1820,
  "ttfbMs": 320,
  "inputTokens": 120,
  "outputTokens": 48,
  "error": null,
  "userId": "u_123",
  "metadata": { "traceId": "abc" }
}
```

Use a DLQ for the log consumer, and make DynamoDB writes idempotent with `requestId` as a uniqueness key. SQS-triggered Lambda guidance from AWS is centered on proper queue config, retries, and partial batch handling, which fits this flow well. [docs.aws.amazon](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)

## API surface

### `POST /v1/chat/completions`
Request:
```json
{
  "model": "fast",
  "messages": [
    { "role": "system", "content": "You are concise." },
    { "role": "user", "content": "Explain DynamoDB streams briefly." }
  ],
  "stream": true,
  "temperature": 0.2,
  "user": "u_123",
  "metadata": { "app": "demo" }
}
```

Response modes:
- `stream=false`: buffered JSON
- `stream=true`: SSE stream

### `GET /v1/models`
Return exposed aliases, not raw provider credentials or hidden internal targets.

```json
{
  "data": [
    { "id": "fast", "object": "model", "owned_by": "gateway" },
    { "id": "gpt-4o", "object": "model", "owned_by": "gateway" },
    { "id": "claude-sonnet-4", "object": "model", "owned_by": "gateway" }
  ]
}
```

## What to ship in v1

Keep the first milestone brutally small:

- OpenAI-compatible `chat.completions`
- Streaming + non-streaming
- 2 providers only, maybe OpenAI and Bedrock
- Alias routing
- Basic fallback
- SQS async logs
- DynamoDB request records
- API key auth
- CloudWatch metrics

Skip for now:
- Tool calling normalization
- Image/audio endpoints
- Per-token live billing precision
- Complex rate limiting
- Multi-tenant admin UI
- Full LiteLLM config parity

## CDK resources

Ask Copilot to generate:

- `RestApi`
- `Lambda` for gateway
- `Lambda` for log consumer
- `SQS` queue + DLQ
- `DynamoDB` table + GSIs
- `SecretsManager` secrets for provider keys
- IAM policies:
  - gateway Lambda: `sqs:SendMessage`, secrets read, CloudWatch logs
  - log Lambda: `dynamodb:PutItem/UpdateItem`, SQS consume
  - optional Bedrock invoke permissions if using Bedrock streaming, which AWS examples show as separate permissions for `InvokeModel` and `InvokeModelWithResponseStream`. [dev](https://dev.to/pabloalbaladejo/observable-ai-streaming-on-aws-part-1-api-gateway-rest-with-lambda-595a)

If using API Gateway REST streaming, the integration needs `ResponseTransferMode: STREAM` and the streaming invocation URI ending with `/response-streaming-invocations`. [dev](https://dev.to/pabloalbaladejo/observable-ai-streaming-on-aws-part-1-api-gateway-rest-with-lambda-595a)

## Implementation notes for Node Lambda

AWS docs say Lambda response streaming works on Node.js managed runtimes and custom runtimes.  So the gateway Lambda should be Node-first and use `awslambda.streamifyResponse(...)` style handling for the stream path, or equivalent patterns supported by the runtime examples. [blog.theserverlessterminal](https://blog.theserverlessterminal.com/streaming-responses-via-aws-lambda)

High-level handler shape:

```ts
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const req = parseIncoming(event);
  const ctx = buildContext(event);

  const result = await router.resolve(req.model);

  writeHeaders(responseStream, {
    statusCode: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no"
    }
  });

  const started = Date.now();
  let firstChunkAt: number | undefined;
  let usage = {};

  try {
    for await (const chunk of provider.stream(req, ctx)) {
      if (!firstChunkAt) firstChunkAt = Date.now();
      usage = mergeUsage(usage, chunk);
      responseStream.write(formatSse(chunk));
    }

    responseStream.write("event: done\ndata: [DONE]\n\n");
    await publishAuditEvent({
      status: "completed",
      latencyMs: Date.now() - started,
      ttfbMs: firstChunkAt ? firstChunkAt - started : null,
      usage
    });
  } catch (err) {
    responseStream.write(formatSseError(err));
    await publishAuditEvent({
      status: "failed",
      latencyMs: Date.now() - started,
      error: serializeError(err)
    });
  } finally {
    responseStream.end();
  }
});
```

## Error policy

Define this before coding or Copilot will invent messy behavior.

Retry and fail over on:
- 429
- 408
- connection reset
- provider 5xx
- upstream timeout

Do not fail over on:
- invalid API key
- malformed request
- unsupported parameter
- content policy rejection unless you explicitly want cross-provider bypass

Return stable error shape:

```json
{
  "error": {
    "message": "Model alias not configured: foo",
    "type": "invalid_request_error",
    "code": "model_not_found"
  }
}
```

## Observability

Track at least:
- request count
- stream count
- success rate
- fallback count
- per-provider latency
- TTFB
- token totals
- estimated cost
- DynamoDB write failures
- SQS queue depth / DLQ count

Add a `traceId` to every request and propagate it into:
- response header
- SQS event
- CloudWatch structured logs
- DynamoDB item

## Security and governance

- Secrets only in Secrets Manager.
- Per-tenant API keys in DynamoDB or a separate auth store.
- Optional allowlist: tenant can only access certain aliases.
- Prompt/completion body logging should be configurable because many teams will not want raw prompts stored.
- Consider encrypting sensitive fields client-side or storing only hashes/samples.

## Copilot-ready build order

Tell Copilot to implement this in phases.

### Phase 1
- CDK stack with API Gateway REST streaming, gateway Lambda, SQS, DynamoDB, log Lambda. [aws.amazon](https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-response-streaming-rest-apis/)
- `POST /v1/chat/completions`
- OpenAI provider adapter only
- SSE streaming
- Async audit event to SQS
- Log consumer writes DynamoDB

### Phase 2
- Add Bedrock adapter with streaming permissions and normalized event translation. [dev](https://dev.to/pabloalbaladejo/observable-ai-streaming-on-aws-part-1-api-gateway-rest-with-lambda-595a)
- Add alias routing table and weighted targets
- Add fallback policy
- Add `GET /v1/models`

### Phase 3
- API key auth + tenant scoping
- metrics and cost estimation
- request validation hardening
- idempotency and DLQ replay tooling

## Prompt you can give Copilot

Use this almost verbatim:

```text
Build a TypeScript monorepo for a serverless LLM gateway on AWS.

Goal:
- OpenAI-compatible API surface for /v1/chat/completions
- Request body contains model alias, and the gateway routes to the correct provider/model
- Support both stream=true and stream=false
- For stream=true, use AWS Lambda response streaming with API Gateway REST response streaming and return SSE
- Log request outcome asynchronously by sending an event to SQS
- A separate Lambda consumes SQS and writes structured request records to DynamoDB
- Use Node.js 22 Lambda runtime and AWS CDK

Architecture:
- API Gateway REST API
- Gateway Lambda with response streaming
- SQS queue + DLQ
- Log writer Lambda
- DynamoDB table for request logs
- Secrets Manager for provider API keys
- CloudWatch structured logs and metrics

Implement these modules:
1. core/router.ts
   - resolve model alias to target provider/model
   - support weighted targets
   - support fallback chain on retryable errors

2. providers/openai.ts
   - implement non-streaming and streaming chat completion calls
   - normalize provider chunks to internal stream events

3. handlers/chatCompletions.ts
   - validate OpenAI-style request
   - invoke router
   - if stream=true, write SSE chunks to Lambda response stream
   - if stream=false, return JSON
   - emit audit event to SQS in both success and failure paths

4. handlers/listModels.ts
   - return public model aliases

5. logging/sqsPublisher.ts
   - publish compact audit events with requestId, tenantId, modelAlias, provider, timings, usage, status, and error

6. logging/logConsumer.ts
   - consume SQS batch safely
   - idempotently write to DynamoDB
   - support partial batch failure response

7. infra/cdk
   - define all AWS resources
   - configure API Gateway REST integration for Lambda response streaming
   - set Integration.ResponseTransferMode=STREAM
   - use the response-streaming-invocations URI
   - least-privilege IAM

Data model:
- DynamoDB PK=tenantId, SK=ts#requestId
- GSI on requestId
- GSI on modelAlias + createdAt
- store status, latencyMs, ttfbMs, token usage, provider info, and metadata

Requirements:
- strong typing with zod
- structured JSON logging
- no framework unless it helps streaming compatibility
- unit-test router and provider normalization
- keep provider interface generic so Anthropic and Bedrock can be added next
- keep all code production-ready and minimal
```

## Suggested repo tasks

Give Copilot these individual issues too:
- “Create zod schemas for OpenAI-compatible chat request/response”
- “Implement SSE formatter for internal stream events”
- “Implement retryable error classifier”
- “Implement weighted alias resolver”
- “Implement SQS audit publisher”
- “Implement DynamoDB idempotent upsert for request logs”
- “Create CDK REST API Gateway streaming integration escape hatch”
- “Add OpenAI adapter with stream/non-stream support”

## Practical recommendation

If your goal is “serverless LiteLLM replacement,” the winning angle is not feature parity; it is **simple deploy, fast streaming, and AWS-native observability**. Lambda’s broader regional support plus streaming through `InvokeWithResponseStream` and API Gateway REST makes that positioning credible now. [aws.amazon](https://aws.amazon.com/about-aws/whats-new/2026/04/aws-lambda-response-streaming/)

If you want, I can turn this next into a **full technical spec + folder tree + TypeScript interface skeletons** that you can paste directly into Copilot Chat.