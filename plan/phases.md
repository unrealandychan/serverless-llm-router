# Implementation Phases

## Phase 1 — Foundation (current)

**Goal:** Working end-to-end with OpenAI only. Deploy and validate streaming.

### Deliverables

| Module | File | Status |
|--------|------|--------|
| Request schemas | `core/schemas.ts` | Phase 1 |
| Alias router | `core/router.ts` | Phase 1 |
| SSE formatter | `core/stream.ts` | Phase 1 |
| Error hierarchy | `util/errors.ts` | Phase 1 |
| ID utils | `util/ids.ts` | Phase 1 |
| Timing utils | `util/time.ts` | Phase 1 |
| Provider types | `providers/types.ts` | Phase 1 |
| Provider registry | `providers/registry.ts` | Phase 1 |
| OpenAI adapter | `providers/openai.ts` | Phase 1 |
| Static routing config | `config/modelMap.ts` | Phase 1 |
| Chat completions handler | `handlers/chatCompletions.ts` | Phase 1 |
| List models handler | `handlers/listModels.ts` | Phase 1 |
| Audit event type | `logging/auditEvent.ts` | Phase 1 |
| SQS publisher | `logging/sqsPublisher.ts` | Phase 1 |
| Log consumer Lambda | `logging/logConsumer.ts` | Phase 1 |
| CDK stack | `infra/cdk/lib/gateway-stack.ts` | Phase 1 |
| Unit tests — router | `__tests__/router.test.ts` | Phase 1 |
| Unit tests — stream | `__tests__/stream.test.ts` | Phase 1 |

### API surface

- `POST /v1/chat/completions` (stream + non-stream, OpenAI provider)
- `GET /v1/models` (static list)

### Verification Checklist

- [ ] `pnpm test` passes all unit tests
- [ ] `cdk synth` produces valid CloudFormation with streaming integration
- [ ] `curl -N -H "Authorization: Bearer $KEY" -d '{"model":"gpt-4o","messages":[...], "stream":true}'` receives SSE chunks
- [ ] DynamoDB table has a record after each request
- [ ] DLQ stays empty under normal load
- [ ] Unknown alias returns `400 model_not_found`
- [ ] Invalid API key returns `401`

---

## Phase 2 — Multi-Provider + Routing

**Goal:** Add Bedrock adapter, live routing config, fallback for streaming, `GET /v1/models`.

### Deliverables

| Module | Notes |
|--------|-------|
| `providers/bedrock.ts` | AWS SDK Bedrock InvokeModelWithResponseStream; normalize chunks to `ProviderChunk` |
| `providers/anthropic.ts` | Anthropic Messages API direct; normalize to `ProviderChunk` |
| Updated `providers/registry.ts` | Register Bedrock + Anthropic adapters |
| Updated `config/modelMap.ts` | Add Bedrock and Anthropic aliases |
| `core/router.ts` — streaming fallback | Try next target if upstream fails before first chunk |
| DynamoDB-backed routing config | Read routing config from a `llm_gateway_config` table; hot-reload via SSM |
| `GET /v1/models` — dynamic | Return aliases from live routing config |
| CDK additions | Bedrock `InvokeModel` + `InvokeModelWithResponseStream` permissions |

### Bedrock Streaming Notes

Bedrock uses `InvokeModelWithResponseStream` which returns a `ReadableStream` of `PayloadPart` bytes. The adapter must:
1. Decode each `PayloadPart.bytes` as UTF-8
2. Parse JSON event
3. Map to `ProviderChunk`

---

## Phase 3 — Auth, Observability, Hardening

**Goal:** Production-ready auth, metrics, cost, and ops tooling.

### Deliverables

| Module | Notes |
|--------|-------|
| `auth/apiKey.ts` | Per-tenant API key validation; keys stored in DynamoDB `llm_gateway_keys` |
| Tenant scoping | `X-Tenant-Id` header or key prefix; scope requests to tenant routing config |
| Model alias allowlist | Deny if tenant's key is not permitted for the requested alias |
| CloudWatch EMF metrics | `RequestCount`, `StreamCount`, `SuccessRate`, `FallbackCount`, `ProviderLatencyMs`, `TTFB`, `InputTokens`, `OutputTokens`, `EstimatedCostUsd` |
| Cost estimation | Token counts × provider pricing table; stored in DynamoDB |
| Provider key pools | Support multiple keys per provider (for example 2+ OpenAI keys) and select a key per request (round-robin or weighted) to balance token usage across accounts, similar to LiteLLM |
| DLQ replay tool | Script to replay DLQ messages for failed audit events |
| Request ID propagation | `X-Request-Id` in response headers and structured log output |
| Input validation hardening | Reject oversized messages, deeply nested objects |
| Prompt/response logging opt-in | Configurable per tenant; store in S3 with TTL |

---

## Future (Post-Phase 3)

- Tool/function calling normalization across providers
- Embeddings endpoint (`POST /v1/embeddings`)
- Image generation endpoint (`POST /v1/images/generations`)
- Multi-tenant admin UI
- Rate limiting + quota enforcement
- Cognito/JWT auth
- CI/CD pipeline (GitHub Actions → CDK deploy)
- Load testing harness
