# Release Notes

Use this file as the running release note for each update.

## [Unreleased]

### Added
- 

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
