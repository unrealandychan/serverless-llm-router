# Release Notes

Use this file as the running release note for each update.

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
