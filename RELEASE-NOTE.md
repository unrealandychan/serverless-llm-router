# Release Notes

Use this file as the running release note for each update.

## [2026-05-02] - RAG support via Amazon S3 Vectors

### Added
- **`POST /v1/rag/ingest`** — accepts up to 100 documents per request, batch-embeds them using OpenAI Embeddings, and stores the resulting vectors (with `source_text` as non-filterable metadata) in an Amazon S3 Vectors index.
- **`POST /v1/rag/query`** — full RAG pipeline: embeds the user query, retrieves the top-K nearest chunks from S3 Vectors (with optional metadata filtering), builds a grounded system prompt, then routes the augmented request through the existing LLM router. Supports both streaming (SSE) and buffered responses. Non-streaming responses include `rag_context` (key + distance per retrieved chunk) for source attribution.
- **`src/rag/s3Vectors.ts`** — singleton `S3VectorsClient` wrapper exposing `putVectors`, `queryVectors`, and `deleteVectors`. Configured via `RAG_VECTOR_BUCKET_NAME`, `RAG_DEFAULT_INDEX_NAME`, and `RAG_EMBEDDING_MODEL` env vars.
- **`src/handlers/ragSetup.ts`** — CDK custom resource Lambda that idempotently creates the S3 Vectors bucket (`llm-gateway-rag-<account-id>`) and index (`rag-default`, 1536 dims, cosine distance) on every `cdk deploy`.
- **CDK stack** — `RagSetup` custom resource Lambda + Provider, `RagIngest` Lambda, `RagQuery` streaming Lambda, `POST /v1/rag/ingest` and `POST /v1/rag/query` API Gateway routes, IAM policies for `s3vectors:PutVectors`, `s3vectors:QueryVectors`, and provisioning actions. New stack outputs: `RagIngestEndpoint`, `RagQueryEndpoint`, `RagVectorBucketName`.

### Changed
- `apps/gateway/package.json` — `@aws-sdk/client-s3vectors` added to `dependencies` so it is bundled inside the RAG Lambda zips (the S3 Vectors client is not yet included in the Lambda Node.js 22 managed runtime).
- CDK shared bundling props extended with a `ragBundling` override: lists only the well-known AWS SDK packages as external, allowing esbuild to bundle `@aws-sdk/client-s3vectors` without affecting other Lambdas.
- Architecture diagram and Stack table in README updated to include S3 Vectors.

---

## [2026-04-16] - Accept OpenAI `developer` role in chat completions

### Fixed
- Gateway now accepts messages with `role: "developer"` (introduced in OpenAI o-series/gpt-5 models) instead of rejecting them with HTTP 400. The role is normalized to `system` before forwarding to downstream providers that do not support it.

### Changed
- `ChatMessageSchema` enum extended to include `'developer'`.
- `chatCompletions` handler maps `developer` → `system` when building the normalized request.

---

## [2026-04-15] - Provider key pool support with round-robin load balancing

### Added
- `src/providers/keyPool.ts` — `parseKeyPool()` parses a secret as either a plain string key or a JSON array of keys (backward-compatible); `selectKey()` performs stateful round-robin selection across warm Lambda invocations.
- JSON-array key pool support: store `["sk-key1","sk-key2"]` in a single Secrets Manager secret ARN for automatic round-robin distribution with no extra env vars required.
- Per-target `key_id` field on `ProviderTarget` for routing-level key selection (resolves `<PROVIDER>_SECRET_ARN_<KEY_ID>` env var, falls back to default ARN).
- Registry key pool cache (`keyPoolCache`) per ARN to avoid repeated secret parses.

### Changed
- For multi-key pool providers (OpenAI, Anthropic, `openai_compatible:*`), adapter cache is bypassed and a fresh adapter is instantiated per call so the round-robin counter is respected.
- `routeWithFallback` propagates `key_id` through to `getProviderAdapter`.
- Single-key providers and Bedrock/Vertex (IAM/OAuth) are unaffected.

---

## [2026-04-12] - OpenAI Responses API support (POST /v1/responses)

### Added
- `src/core/responses.ts` — pure utilities: `ResponsesRequestSchema` (Zod), `inputToMessages()`, `buildResponseBody()`, `formatResponseSseEvent()`.
- `src/handlers/responses.ts` — streaming Lambda handler (`awslambda.streamifyResponse`) emitting the full Responses API SSE sequence: `response.created` → `response.in_progress` → `response.output_item.added` → `response.output_text.delta` (×N) → `response.output_text.done` → `response.completed`.
- CDK: new `responsesFn` Lambda, API Gateway `POST /v1/responses` route with `ResponseTransferMode=STREAM`, and `ResponsesEndpoint` stack output.
- 17 unit tests in `src/__tests__/responses.test.ts` covering schema validation, `inputToMessages` edge cases, response body structure, and SSE framing.

---

## [2026-04-12] - Adding more plan details and fixing some errors
### Added
- Example request and response formats for both streaming and non-streaming modes.

## [2026-04-12] - Endpoint-mode routing fix and Vertex support

### Added
- Vertex OpenAI-compatible profile support in CDK (`OPENAI_COMPAT_VERTEX_BASE_URL`, `OPENAI_COMPAT_VERTEX_CREDENTIALS_SECRET_ARN`) and credentials secret output.
- New model aliases: `vertex-gemini-2.5-pro`, `vertex-gemini-2.5-flash`.
- Route target metadata `endpoint_mode` to control `chat` vs `completions` behavior explicitly.

### Changed
- OpenAI adapter now respects explicit `endpoint_mode` and only uses chat→completions fallback in `auto` mode.
- Streaming chat requests no longer send `stream_options` to non-OpenAI-compatible providers by default.

### Fixed
- Prevented incorrect fallback of `gpt-5.2-codex` to `/v1/completions` by pinning OpenAI aliases to chat endpoint mode.

### Removed
- 

### Security
- 

## [2026-04-12] - Fix the CORS probelm of the billing dashboard adding Gemini support

### Added
- CORS headers to billing dashboard API responses to allow embedding in CloudFront-hosted static site.
- Support for Google Gemini models in the routing config and provider adapter.

### Changed
- 

### Fixed
- 

### Removed
- 

### Security
- 

## [2026-04-12] - Initial Production Deployment

### Added
- Serverless LLM router deployed on AWS (API Gateway + Lambda + DynamoDB + SQS + CloudFront + S3).
- Multi-provider routing (OpenAI, Bedrock, Anthropic).
- Rate limiting and quota enforcement.
- Embeddings, image generation, audio transcription, and text-to-speech endpoints.
- Billing usage endpoint and dashboard.

### Changed
- Streaming integration uses API Gateway response streaming with Lambda integration path `/2021-11-15/.../response-streaming-invocations`.
- Dynamic route loading supports runtime alias updates from DynamoDB.

### Fixed
- API Gateway streaming `ResponseTransferMode` configuration.
- Resource naming collisions for pre-existing AWS resources.
- Compatibility fallback for models that reject `/v1/chat/completions` and require `/v1/completions`.

---

## Release Process

1. Keep work under `## [Unreleased]` while developing.
2. Before deployment, copy `Unreleased` into a dated section: `## [YYYY-MM-DD] - <release name>`.
3. Clear `Unreleased` section after release.
4. Commit release note update with code changes.

Suggested commit message format:
- `chore(release): update release notes for <YYYY-MM-DD>`
