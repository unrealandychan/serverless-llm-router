# Serverless LLM Router — Product Overview

A serverless, OpenAI-compatible LLM gateway on AWS. Accepts OpenAI-style requests, routes to the best provider via model alias, streams tokens back via SSE, and logs every request asynchronously through SQS into DynamoDB.

---

## Goals

| Goal | Description |
|------|------------|
| OpenAI-compatible surface | Clients use `POST /v1/chat/completions` and `GET /v1/models` unchanged |
| Model alias routing | Callers request `"fast"` or `"gpt-4o"` — the gateway resolves provider/model |
| Response streaming | Lambda response streaming via API Gateway REST reduces time-to-first-byte |
| AWS-native observability | Structured CloudWatch logs + DynamoDB request records, no external dependencies |
| Lightweight deploy | Two Lambdas + SQS + DynamoDB — no containers, no VPC required in v1 |

---

## v1 Scope (Phase 1)

- `POST /v1/chat/completions` — stream and non-stream
- `GET /v1/models` — returns public alias list
- **OpenAI provider adapter** only
- Alias routing with weighted target selection
- Basic fallback on retryable errors (non-streaming path)
- Async audit log: SQS → DynamoDB
- API key auth (env-var backed, Secrets Manager for provider keys)
- CloudWatch structured logs

## v2 Scope (Phase 2) ✅ Implemented

- Bedrock adapter (Amazon Nova Micro/Lite/Pro, Claude via Bedrock Converse API)
- Anthropic direct adapter (`claude-sonnet`, `claude-haiku`)
- Multi-provider weighted routing aliases (`fast`, `smart`)
- Dynamic routing config from DynamoDB (`llm_gateway_routes` table, 5-min cache)
- `GET /v1/models` includes provider metadata
- **Rate limiting / quota enforcement** — DynamoDB atomic counters, per-minute (60 rpm) and per-day (1000 rpd) windows; configurable via env vars
- **Billing dashboard** — `GET /v1/billing/usage` API + static S3+CloudFront dashboard with Chart.js
- **Image, audio & embeddings endpoints**:
  - `POST /v1/embeddings` → OpenAI text-embedding-3-small / text-embedding-3-large
  - `POST /v1/images/generations` → DALL-E 2 / DALL-E 3
  - `POST /v1/audio/transcriptions` → Whisper-1 (JSON body with base64 audio)
  - `POST /v1/audio/speech` → TTS-1 / TTS-1-HD (returns base64 JSON)

## Out of Scope (v1/v2)

- Tool calling / function calling normalization
- Per-tenant admin UI or billing dashboard with user management
- Multi-tenant auth (Cognito/JWT)
- LiteLLM config parity

---

## Guiding Principles

1. **Explicit over magic** — Unknown model alias returns `400`, no silent fallback
2. **Hot path stays fast** — SQS decouples logging from request latency
3. **Privacy by default** — Prompt/completion bodies not stored unless opted in
4. **Portable provider interface** — Adding a new provider is one file

---

## Quick Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Stream or buffered chat completions |
| `/v1/models` | GET | List available model aliases |

See [api-spec.md](api-spec.md) for full contract.
