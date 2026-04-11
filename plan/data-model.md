# Data Model

## DynamoDB — `llm_gateway_requests`

### Key Schema

| Key | Attribute | Type | Example |
|-----|-----------|------|---------|
| PK | `tenantId` | S | `t_default` |
| SK | `sk` | S | `ts#2026-04-11T06:20:00Z#req_01j9...` |

The SK includes ISO timestamp prefix for natural time ordering within a tenant.

### Attributes

| Attribute | Type | Notes |
|-----------|------|-------|
| `requestId` | S | Unique per request; used for idempotency |
| `createdAt` | S | ISO 8601 |
| `modelAlias` | S | Alias requested by caller (e.g. `fast`) |
| `resolvedProvider` | S | Actual provider used (e.g. `openai`) |
| `resolvedModel` | S | Actual model used (e.g. `gpt-4o-mini`) |
| `stream` | BOOL | Whether the request was streamed |
| `status` | S | `completed` or `failed` |
| `latencyMs` | N | Total latency from request start to response end |
| `ttfbMs` | N | Time to first byte (null if never started) |
| `inputTokens` | N | Input token count |
| `outputTokens` | N | Output token count |
| `estimatedCostUsd` | N | Future: computed from token counts + provider pricing |
| `errorCode` | S | Error message if failed, null otherwise |
| `userId` | S | Caller-supplied user ID |
| `metadata` | M | Caller-supplied metadata map |
| `ttl` | N | Unix epoch; set for retention control |
| `providerStatus` | S | `{provider}#{status}` — denormalized for GSI3 |

### GSIs

| Index | PK | SK | Use Case |
|-------|----|----|----------|
| `GSI1-requestId` | `requestId` | `createdAt` | Look up a specific request by ID |
| `GSI2-modelAlias` | `modelAlias` | `createdAt` | Query all requests for a model alias by time |
| `GSI3-providerStatus` | `providerStatus` | `createdAt` | Query requests by provider + status (e.g. `openai#failed`) |

### Example Item

```json
{
  "tenantId": "t_default",
  "sk": "ts#2026-04-11T06:20:00Z#req_01j9abc",
  "requestId": "req_01j9abc",
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
  "errorCode": null,
  "userId": "u_123",
  "providerStatus": "openai#completed",
  "metadata": { "traceId": "abc123" }
}
```

---

## SQS — Audit Event Envelope

Published by Gateway Lambda immediately after the request ends (fire-and-forget).

```json
{
  "version": 1,
  "type": "llm.request.completed",
  "requestId": "req_01j9abc",
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
  "metadata": { "traceId": "abc123" }
}
```

### DLQ Policy

- SQS visibility timeout: 30 s
- `maxReceiveCount`: 3
- DLQ retention: 14 days
- Log Consumer uses `reportBatchItemFailures` for partial batch failure

---

## Idempotency

Log Consumer uses a DynamoDB `ConditionExpression: attribute_not_exists(requestId)` on every `PutItem`. If the item already exists (duplicate SQS delivery), the `ConditionalCheckFailedException` is caught and treated as success — no retry.

---

## TTL Strategy

- Set `ttl` attribute on every DynamoDB item
- Default: `createdAt + 90 days`
- Configurable per tenant in future via tenant config table
- Verbose prompt/completion bodies (if enabled): store in S3, reference by key; apply shorter TTL

---

## Payload Storage (v1)

Request and response bodies are **not stored by default** (privacy default). Future opt-in:

1. Store truncated bodies (first 1 KB) in DynamoDB directly
2. Store full bodies in S3 `llm-gateway-payloads/{tenantId}/{date}/{requestId}.json`
3. Add `payloadKey` attribute to DynamoDB item pointing to S3 object
