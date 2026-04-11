# Architecture

## AWS Stack

| Layer | Service | Reason |
|-------|---------|--------|
| Public API | API Gateway REST API | Supports `ResponseTransferMode=STREAM` for SSE; Nov 2025 GA |
| Compute — serving | Lambda, Node.js 22 | Managed runtime with `streamifyResponse` support |
| Compute — logging | Lambda, Node.js 22 | SQS consumer; isolated from hot path |
| Queue | SQS Standard + DLQ | Decouples request path from persistence; built-in retry |
| Persistence | DynamoDB (on-demand) | Fast, cheap, natural for request-log records |
| Secrets | Secrets Manager | Provider API keys; cached at Lambda cold start |
| Metrics | CloudWatch EMF | Native, zero additional cost |
| Auth (v1) | API key in header | Simple; Cognito/JWT deferred |

---

## Component Diagram

```
Client
  │  POST /v1/chat/completions
  ▼
API Gateway REST API (streaming integration)
  │  InvokeWithResponseStream
  ▼
Gateway Lambda  ────────────────────────────────────────────
  │   ┌──────────────────────────────────────────────────┐
  │   │  1. Validate request (Zod)                       │
  │   │  2. Auth check (API key)                         │
  │   │  3. Resolve alias → provider + model             │
  │   │  4. Get API key from Secrets Manager (cached)    │
  │   │  5. Stream from upstream provider (OpenAI, etc.) │
  │   │  6. Forward SSE chunks to response stream        │
  │   │  7. Publish audit event to SQS (fire & forget)   │
  │   └──────────────────────────────────────────────────┘
  │
  ├──► OpenAI API (or Bedrock, Anthropic)
  │
  └──► SQS Audit Queue
              │
              ▼
        Log Consumer Lambda
              │
              ▼
        DynamoDB: llm_gateway_requests
```

---

## Folder Structure

```
apps/
  gateway/
    src/
      handlers/
        chatCompletions.ts    # Main streaming Lambda handler
        listModels.ts          # GET /v1/models handler
      core/
        router.ts              # Alias resolution + weighted target selection
        schemas.ts             # Zod request/response schemas
        stream.ts              # SSE formatter + usage accumulator
      providers/
        types.ts               # ProviderAdapter interface + shared types
        registry.ts            # Lazy-initialized adapter registry
        openai.ts              # OpenAI adapter (Phase 1)
        bedrock.ts             # Bedrock adapter (Phase 2)
        anthropic.ts           # Anthropic direct adapter (Phase 2)
      logging/
        auditEvent.ts          # AuditEvent type
        sqsPublisher.ts        # Publish audit events to SQS
        logConsumer.ts         # SQS consumer Lambda handler
      config/
        modelMap.ts            # Static routing config (v1)
      auth/
        apiKey.ts              # API key validation
      util/
        ids.ts                 # Request ID generation
        errors.ts              # GatewayError hierarchy + retryable classifier
        time.ts                # Timing helpers
      types/
        lambda-stream.d.ts     # awslambda global type declarations
infra/
  cdk/
    bin/app.ts                 # CDK app entry
    lib/gateway-stack.ts       # All AWS resources
```

---

## Request Flow

1. Client sends `POST /v1/chat/completions` with OpenAI-style body
2. API Gateway forwards via `response-streaming-invocations` URI
3. Gateway Lambda validates schema (Zod) and authenticates API key
4. Router resolves model alias → weighted target (provider + model)
5. Registry returns the cached provider adapter; fetches API key from Secrets Manager on cold start
6. Provider adapter opens upstream stream
7. Lambda translates provider chunks to SSE and writes to `responseStream`
8. In `finally`, Lambda publishes compact audit envelope to SQS (fire-and-forget)
9. Log Consumer Lambda batch-processes SQS messages and upserts DynamoDB records

---

## Lambda Streaming Pattern

```ts
export const handler = awslambda.streamifyResponse(
  async (event: APIGatewayProxyEvent, responseStream) => {
    const httpStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    // write SSE chunks...
    httpStream.end();
  }
);
```

The API Gateway integration uses:
- URI suffix: `/response-streaming-invocations`
- CFN override: `Integration.ResponseTransferMode = STREAMING`
