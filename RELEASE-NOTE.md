# Release Notes

Use this file as the running release note for each update.

## [2026-04-20] - Tool/function-calling support for agent compatibility

### Added
- **`tools` and `tool_choice` support** on both `POST /v1/chat/completions` and `POST /v1/responses` endpoints. Agent frameworks (OpenAI Agents SDK, LangChain, AutoGen, etc.) that rely on function/tool calling now work correctly.
- `parallel_tool_calls` field accepted on both endpoints and forwarded to the provider.
- `tool_call_id` and `name` optional fields on `ChatMessageSchema` to support tool-result messages (`role: "tool"`) in conversation history.
- `ToolDefinition` and `ToolCall` types in `providers/types.ts`; `tool_calls` field added to `NormalizedResponse`; new `tool_call` variant added to `ProviderChunk`.
- `OpenAIAdapter`: `invokeChat()` passes tools to the OpenAI API and extracts `tool_calls` from the response; `streamChat()` passes tools, accumulates streamed tool-call argument deltas, filters incomplete entries, and emits a consolidated `tool_call` SSE event at stream end.
- `formatSseChunk` handles the new `tool_call` chunk type — emits `event: tool_call`.
- 13 new unit tests covering schema validation (`ChatRequestSchema` tools, `ResponsesRequestSchema` tools) and `formatSseChunk` tool_call formatting.

### Fixed
- Previously, `tools` sent by agent clients were silently stripped by Zod (not in the schema), so LLMs never received tool definitions and never returned tool calls. The `chatCompletions` handler now returns `content: null` and includes `tool_calls` in the response message when the model chose a tool.

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
