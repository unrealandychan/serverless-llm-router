# Serverless LLM Router

A serverless, OpenAI-compatible LLM gateway on AWS. Drop it in front of any LLM provider and get streaming responses, multi-provider routing, rate limiting, and async request logging — all without managing servers.

## What it does

- Accepts `POST /v1/chat/completions` with the same shape as the OpenAI API — stream or buffered
- Routes the `"model"` alias to the correct provider/model (e.g. `"fast"` → 60% OpenAI `gpt-5.2-codex` / 40% Bedrock `nova-lite`)
- Supports **OpenAI**, **AWS Bedrock** (Amazon Nova, Claude), **Anthropic**, and **OpenAI-compatible providers** (e.g. Gemini and Vertex)
- Streams tokens back as SSE via AWS Lambda response streaming + API Gateway REST
- **Rate limiting** — per-tenant per-minute and per-day request quotas backed by DynamoDB atomic counters
- **Live routing config** — update model aliases in DynamoDB without redeploying
- Per-target endpoint control via `endpoint_mode` (`chat`, `completions`, or `auto`) to avoid incompatible endpoint fallbacks
- **Provider key pools** — multiple API keys per provider (e.g. 2+ OpenAI accounts) with weighted or equal distribution across requests via `key_id`
- **OpenAI Responses API** — `POST /v1/responses` with full streaming SSE event sequence (`response.created`, `response.output_text.delta`, `response.completed`, etc.)
- **Embeddings, images, and audio** — `POST /v1/embeddings`, `POST /v1/images/generations`, `POST /v1/audio/transcriptions`, `POST /v1/audio/speech`
- **RAG (Retrieval Augmented Generation)** — `POST /v1/rag/ingest` to embed and store documents in **Amazon S3 Vectors**, and `POST /v1/rag/query` to retrieve context and stream grounded answers via any configured model alias
- Logs every request asynchronously (SQS → DynamoDB) — never on the hot path
- Rejects unauthenticated requests at the **API Gateway layer** via a Lambda Authorizer, before your streaming Lambda ever runs
- **Billing dashboard** — S3 + CloudFront static site showing usage, token counts, and estimated cost per model

---

## Architecture

```
Client
  │  POST /v1/chat/completions   (or /embeddings, /images/generations, /audio/*, /billing/usage)
  │  POST /v1/rag/ingest         (embed documents → S3 Vectors)
  │  POST /v1/rag/query          (embed query → S3 Vectors → LLM → streaming response)
  │  Authorization: Bearer gw_sk_...
  ▼
API Gateway REST API
  │  Lambda Authorizer validates key → 403 or Allow + tenantId
  │  Rate limiter checks DynamoDB counters → 429 if quota exceeded
  ▼
Handler Lambda (streaming for chat/rag-query, standard for rest)
  │  Routes via alias → OpenAI / Bedrock (Nova, Claude) / Anthropic
  │  audit event → SQS (fire-and-forget)
  ▼
Log Consumer Lambda  →  DynamoDB llm_gateway_requests

                         DynamoDB llm_gateway_routes   ← live route config
                         DynamoDB llm_gateway_rate_limits ← quota counters

RAG Ingest Lambda  →  OpenAI Embeddings API  →  S3 Vectors (PutVectors)
RAG Query Lambda   →  OpenAI Embeddings API  →  S3 Vectors (QueryVectors)
                   →  LLM Router  →  streaming SSE response

Billing Dashboard (CloudFront + S3)  ←  GET /v1/billing/usage
```

## Stack

| Layer | Service |
|-------|---------|
| API | API Gateway REST API (response streaming for chat/rag-query) |
| Auth | Lambda Authorizer (TOKEN type, 5 min cache) |
| Compute | Lambda Node.js 22 (ARM64) |
| Queue | SQS Standard + DLQ |
| Storage | DynamoDB (on-demand) — requests, routes, rate limits |
| Vector Store | **Amazon S3 Vectors** — RAG document embeddings |
| Secrets | AWS Secrets Manager |
| Dashboard | S3 + CloudFront |
| Metrics | CloudWatch |

---

## Project Structure

```
apps/
  gateway/
    src/
      auth/          keyStore.ts — API key validation against Secrets Manager
      handlers/      chatCompletions.ts, responses.ts, listModels.ts, authorizer.ts
                     embeddings.ts, imageGenerations.ts
                     audioTranscriptions.ts, audioSpeech.ts
                     billingUsage.ts
                     ragIngest.ts, ragQuery.ts   ← RAG API handlers
                     ragSetup.ts                 ← CDK custom resource (vector bucket init)
      rag/           s3Vectors.ts               ← S3 Vectors client utility
      core/          router.ts, schemas.ts, stream.ts
      providers/     openai.ts, bedrock.ts, anthropic.ts, types.ts, registry.ts
      middleware/    rateLimiter.ts
      logging/       auditEvent.ts, sqsPublisher.ts, logConsumer.ts
      config/        modelMap.ts, routeLoader.ts
      util/          errors.ts, ids.ts, time.ts
dashboard/
  index.html         Billing dashboard (deployed to S3 + CloudFront)
infra/
  cdk/               gateway-stack.ts — all AWS resources
plan/                architecture, API spec, routing, data model, phases
```

---

## Prerequisites

- Node.js 18+
- AWS CLI configured (`aws configure`)
- AWS CDK bootstrapped in your target account/region

---

## Deploy

```bash
# 1. Install dependencies
npm install

# 2. Bootstrap CDK (first time only)
cd infra/cdk
npx cdk bootstrap

# 3. Deploy
npx cdk deploy

# 4. Populate provider API keys
aws secretsmanager put-secret-value \
  --secret-id /llm-gateway/openai-api-key \
  --secret-string "sk-proj-..."

aws secretsmanager put-secret-value \
  --secret-id /llm-gateway/anthropic-api-key \
  --secret-string "sk-ant-..."

# Optional: Gemini API key for OpenAI-compatible Gemini routing
aws secretsmanager put-secret-value \
  --secret-id /llm-gateway/gemini-api-key \
  --secret-string "AIza..."

# Optional: Vertex credentials JSON for OpenAI-compatible Vertex routing
aws secretsmanager put-secret-value \
  --secret-id /llm-gateway/vertex-credentials-json \
  --secret-string 'JSON_CREDENTIALS_CONTENT'

# Bedrock uses the Lambda execution role — no key needed.
# Ensure your AWS account has model access enabled in the Bedrock console.

# 5. Create your first gateway API key
aws secretsmanager put-secret-value \
  --secret-id /llm-gateway/api-keys \
  --secret-string '{"gw_sk_changeme": {"tenantId": "t_default", "label": "default"}}'
```

`cdk deploy` prints all endpoint URLs and secret ARNs as stack outputs.

Note: Use the exact endpoint outputs (`ChatEndpoint`, `EmbeddingsEndpoint`, `BillingEndpoint`) when testing. Depending on stage/base URL composition, the path can include `/v1/v1/...`.

---

## Usage

### Chat completions — streaming

```bash
curl -N \
  -H "Authorization: Bearer gw_sk_changeme" \
  -H "Content-Type: application/json" \
  -d '{"model":"fast","messages":[{"role":"user","content":"Hello"}],"stream":true}' \
  https://<api-id>.execute-api.<region>.amazonaws.com/v1/chat/completions
```

### Chat completions — buffered

```bash
curl \
  -H "Authorization: Bearer gw_sk_changeme" \
  -H "Content-Type: application/json" \
  -d '{"model":"smart","messages":[{"role":"user","content":"Hello"}],"stream":false}' \
  https://<api-id>.execute-api.<region>.amazonaws.com/v1/chat/completions
```

### Embeddings

```bash
curl \
  -H "Authorization: Bearer gw_sk_changeme" \
  -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-3-small","input":"The quick brown fox"}' \
  https://<api-id>.execute-api.<region>.amazonaws.com/v1/embeddings
```

### Image generation

```bash
curl \
  -H "Authorization: Bearer gw_sk_changeme" \
  -H "Content-Type: application/json" \
  -d '{"model":"dall-e-3","prompt":"A sunset over mountains","size":"1024x1024"}' \
  https://<api-id>.execute-api.<region>.amazonaws.com/v1/images/generations
```

### Audio transcription

```bash
# Encode the audio file to base64 first, then send as JSON
AUDIO_B64=$(base64 -i recording.mp3)
curl \
  -H "Authorization: Bearer gw_sk_changeme" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"whisper-1\",\"audio\":\"$AUDIO_B64\",\"filename\":\"recording.mp3\"}" \
  https://<api-id>.execute-api.<region>.amazonaws.com/v1/audio/transcriptions
```

### Text-to-speech

```bash
curl \
  -H "Authorization: Bearer gw_sk_changeme" \
  -H "Content-Type: application/json" \
  -d '{"model":"tts-1","input":"Hello world","voice":"nova"}' \
  https://<api-id>.execute-api.<region>.amazonaws.com/v1/audio/speech
# Response: { "audio": "<base64-mp3>", "format": "mp3" }
```

### List models

```bash
curl \
  -H "Authorization: Bearer gw_sk_changeme" \
  https://<api-id>.execute-api.<region>.amazonaws.com/v1/models
```

### Responses API — streaming

```bash
curl -N \
  -H "Authorization: Bearer gw_sk_changeme" \
  -H "Content-Type: application/json" \
  -d '{"model":"fast","input":"Tell me a joke","stream":true}' \
  https://<api-id>.execute-api.<region>.amazonaws.com/v1/responses
```

The response follows the OpenAI Responses API SSE event sequence:
`response.created` → `response.in_progress` → `response.output_item.added` → `response.output_text.delta` (×N) → `response.output_text.done` → `response.completed`

### Billing usage

```bash
curl \
  -H "Authorization: Bearer gw_sk_changeme" \
  "https://<api-id>.execute-api.<region>.amazonaws.com/v1/billing/usage?from=2026-04-01&to=2026-04-11"
```

---

## Authentication

The gateway uses an **API Gateway Lambda Authorizer** (TOKEN type).

Every request must include:
```
Authorization: Bearer <your-gateway-key>
```

**How it works:**

1. API Gateway intercepts the request and calls the Authorizer Lambda with the bearer token
2. The Authorizer looks up the key in the `/llm-gateway/api-keys` Secrets Manager secret
3. On a valid key: returns an `Allow` IAM policy + `tenantId` context, cached for **5 minutes**
4. On an invalid key: returns a `Deny` policy → API Gateway responds with **403 Forbidden** immediately, without invoking any Lambda
5. The cached `tenantId` is forwarded to handler Lambdas via `event.requestContext.authorizer.tenantId`

**Key format** (stored in Secrets Manager `/llm-gateway/api-keys`):

```json
{
  "gw_sk_alice_key_here": { "tenantId": "t_alice", "label": "alice-prod" },
  "gw_sk_bob_key_here":   { "tenantId": "t_bob",   "label": "bob-dev"  }
}
```

**Adding a key:**

```bash
VALUE=$(aws secretsmanager get-secret-value \
  --secret-id /llm-gateway/api-keys \
  --query SecretString --output text)

NEW_VALUE=$(echo "$VALUE" | jq '. + {"gw_sk_newkey": {"tenantId":"t_alice","label":"alice-dev"}}')

aws secretsmanager put-secret-value \
  --secret-id /llm-gateway/api-keys \
  --secret-string "$NEW_VALUE"
```

New keys take effect immediately on the next non-cached request.

---

## API Key Storage Guidelines

Use this baseline for production key management.

1. Separate secrets by purpose.
2. Keep provider keys in dedicated secrets: `/llm-gateway/openai-api-key`, `/llm-gateway/anthropic-api-key`.
3. Keep client gateway keys in `/llm-gateway/api-keys` with metadata (`tenantId`, `label`, optional `status`, `createdAt`, `expiresAt`).
4. Grant `secretsmanager:GetSecretValue` only to the authorizer and request Lambdas that need it.
5. Never put keys in git, local `.env` files committed to repo, CI logs, or analytics payloads.
6. Rotate keys every 60-90 days, and immediately after any suspected leak.
7. Rotate safely with overlap: add new key, migrate clients, then disable old key.
8. Add CloudTrail and CloudWatch alerts for unusual Secrets Manager reads.
9. Scope keys by environment (`dev`, `staging`, `prod`) and by tenant.
10. Use a customer-managed KMS key for Secrets Manager if you need stricter access control.

Recommended gateway key record shape:

```json
{
  "gw_sk_live_xxx": {
    "tenantId": "t_acme",
    "label": "acme-prod",
    "status": "active",
    "createdAt": "2026-04-11T00:00:00.000Z",
    "expiresAt": "2026-07-11T00:00:00.000Z"
  }
}
```

---

## Rate Limiting

Per-tenant request quotas are enforced using DynamoDB atomic counters before any provider call is made.

| Limit | Default | Env var |
|-------|---------|---------|
| Requests per minute | 60 | `RPM_LIMIT` |
| Requests per day | 1 000 | `RPD_LIMIT` |

Exceeded quotas return `HTTP 429` with:
```json
{ "error": { "type": "rate_limit_error", "code": "rate_limit_exceeded", "message": "..." } }
```

To disable rate limiting entirely, unset `RATE_LIMITS_TABLE_NAME` in the Lambda environment.

---

## Model Aliases

### Static config

Edit [apps/gateway/src/config/modelMap.ts](apps/gateway/src/config/modelMap.ts):

```ts
// Weighted multi-provider alias — 60% OpenAI, 40% Bedrock
'fast': {
  targets: [
    { provider: 'openai',   model: 'gpt-5.2-codex',          weight: 60 },
    { provider: 'bedrock',  model: 'amazon.nova-lite-v1:0',  weight: 40 },
  ],
  fallbacks: ['gpt-5.2-codex'],
},
```

### Live config (DynamoDB)

Put a row in your deployed `RoutesTableName` output to override or add aliases without redeploying:

```bash
aws dynamodb put-item \
  --table-name <RoutesTableName-from-cdk-output> \
  --item '{
    "alias":     {"S": "fast"},
    "targets":   {"L": [
      {"M": {"provider":{"S":"bedrock"},"model":{"S":"amazon.nova-lite-v1:0"},"weight":{"N":"100"},"endpoint_mode":{"S":"chat"}}}
    ]},
    "fallbacks": {"L": [{"S":"gpt-5.2-codex"}]},
    "enabled":   {"BOOL": true}
  }'
```

Changes are picked up within **5 minutes** (in-memory cache TTL). Set `enabled: false` to disable an alias.

### OpenAI-compatible providers (Gemini, Vertex, and others)

Use provider name format `openai_compatible:<profile>` in route targets. For example:

```json
{
  "provider": "openai_compatible:gemini",
  "model": "gemini-2.5-pro",
  "weight": 100
}
```

Environment variable convention:

- `OPENAI_COMPAT_<PROFILE>_BASE_URL`
- `OPENAI_COMPAT_<PROFILE>_SECRET_ARN`

For Gemini, CDK sets:

- `OPENAI_COMPAT_GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`
- `OPENAI_COMPAT_GEMINI_SECRET_ARN=<gemini-secret-arn>`

For Vertex, CDK sets:

- `OPENAI_COMPAT_VERTEX_BASE_URL=https://us-central1-aiplatform.googleapis.com/v1/projects/YOUR_VERTEX_PROJECT/locations/us-central1/endpoints/openapi`
- `OPENAI_COMPAT_VERTEX_CREDENTIALS_SECRET_ARN=<vertex-credentials-secret-arn>`

Before using Vertex routes, replace `YOUR_VERTEX_PROJECT` in `OPENAI_COMPAT_VERTEX_BASE_URL` with your actual project ID.
The Vertex credentials secret must contain Google credentials JSON (service account or compatible external account credentials), not a raw API key.

### Endpoint mode (`endpoint_mode`)

Each route target can include `endpoint_mode` to force chat vs completions behavior for OpenAI-compatible APIs:

- `chat`: always call `/v1/chat/completions`
- `completions`: always call `/v1/completions`
- `auto`: try chat first, fallback to completions only on compatibility errors

Example route target:

```json
{
  "provider": "openai_compatible:gemini",
  "model": "gemini-2.5-pro",
  "weight": 100,
  "endpoint_mode": "chat"
}
```

### Provider key pools (`key_id`)

Each route target can include an optional `key_id` to select a specific API key from a pool of credentials for that provider. This allows you to distribute traffic across multiple provider accounts — useful for sharing token quotas across organizational accounts.

**How it works**

When a target has `"key_id": "account1"`, the gateway looks up the environment variable `<PROVIDER>_SECRET_ARN_<KEY_ID>` (uppercased, non-alphanumeric characters replaced with `_`) instead of the default `<PROVIDER>_SECRET_ARN`. If the key-specific variable is not set it falls back to the default.

| `key_id` value | Env var resolved |
|----------------|-----------------|
| _(not set)_ | `OPENAI_SECRET_ARN` |
| `"account1"` | `OPENAI_SECRET_ARN_ACCOUNT1` → fallback `OPENAI_SECRET_ARN` |
| `"account-2"` | `OPENAI_SECRET_ARN_ACCOUNT_2` → fallback `OPENAI_SECRET_ARN` |

The same naming convention applies to all providers: `ANTHROPIC_SECRET_ARN_<KEY_ID>`, `OPENAI_COMPAT_GEMINI_SECRET_ARN_<KEY_ID>`, etc.

**Example: equal distribution across two OpenAI accounts**

```json
{
  "gpt-5.4": {
    "targets": [
      { "provider": "openai", "model": "gpt-5.4", "weight": 50, "key_id": "account1" },
      { "provider": "openai", "model": "gpt-5.4", "weight": 50, "key_id": "account2" }
    ]
  }
}
```

Set environment variables pointing to separate Secrets Manager ARNs:

```
OPENAI_SECRET_ARN_ACCOUNT1=arn:aws:secretsmanager:us-east-1:111122223333:secret:openai-key-account1
OPENAI_SECRET_ARN_ACCOUNT2=arn:aws:secretsmanager:us-east-1:111122223333:secret:openai-key-account2
```

**Example: weighted distribution (70% primary / 30% secondary)**

```json
{
  "gpt-5.4": {
    "targets": [
      { "provider": "openai", "model": "gpt-5.4", "weight": 70, "key_id": "primary" },
      { "provider": "openai", "model": "gpt-5.4", "weight": 30, "key_id": "secondary" }
    ]
  }
}
```

The same target can also combine key pools with multi-provider routing — each entry in `targets` independently specifies its `provider`, `model`, `weight`, and optional `key_id`.

**Option 2 — JSON-array secret (round-robin within a single secret)**

Store a JSON array of keys inside one Secrets Manager secret. The gateway parses the array and selects the next key via round-robin on every request (counter persists across warm Lambda invocations):

```bash
aws secretsmanager put-secret-value \
  --secret-id /llm-gateway/openai-api-key \
  --secret-string '["sk-key1","sk-key2","sk-key3"]'
```

No `key_id` or extra env variables are needed — the default `OPENAI_SECRET_ARN` (or any other provider ARN) just points to the array secret. This approach is simpler when you only need to pool keys for a single provider without weighted routing across accounts.

### Available aliases

| Alias | Providers | Notes |
|-------|-----------|-------|
| `gpt-5.4` | OpenAI | Falls back to `gpt-5.2-codex` |
| `gpt-5.2-codex` | OpenAI | |
| `gemini-2.5-pro` | OpenAI-compatible (Gemini) | Routed via `openai_compatible:gemini` |
| `gemini-2.5-flash` | OpenAI-compatible (Gemini) | Routed via `openai_compatible:gemini` |
| `vertex-gemini-2.5-pro` | OpenAI-compatible (Vertex) | Routed via `openai_compatible:vertex` |
| `vertex-gemini-2.5-flash` | OpenAI-compatible (Vertex) | Routed via `openai_compatible:vertex` |
| `nova-lite` | Bedrock | Amazon Nova Lite |
| `nova-pro` | Bedrock | Amazon Nova Pro |
| `nova-micro` | Bedrock | Amazon Nova Micro |
| `claude-sonnet` | Anthropic | claude-sonnet-4-5 |
| `claude-haiku` | Anthropic | claude-haiku-3-5 |
| `fast` | OpenAI 60% / Bedrock 40% | Weighted routing |
| `smart` | OpenAI 50% / Anthropic 50% | Weighted routing |
| `text-embedding-3-small` | OpenAI | Embeddings |
| `text-embedding-3-large` | OpenAI | Embeddings |
| `dall-e-3` | OpenAI | Image generation |
| `dall-e-2` | OpenAI | Image generation |

## RAG (Retrieval Augmented Generation)

The gateway includes a built-in RAG pipeline backed by **Amazon S3 Vectors** — the first cloud object store with native vector storage and sub-second similarity search.

### How it works

```
POST /v1/rag/ingest           POST /v1/rag/query
        │                             │
  Embed documents              Embed user query
  (OpenAI Embeddings)          (OpenAI Embeddings)
        │                             │
  PutVectors → S3 Vectors      QueryVectors ← S3 Vectors
                                      │
                               Augment system prompt
                               with retrieved context
                                      │
                               Route to LLM (any alias)
                                      │
                               Streaming SSE response
```

### Ingest documents — `POST /v1/rag/ingest`

```bash
curl \
  -H "Authorization: Bearer gw_sk_changeme" \
  -H "Content-Type: application/json" \
  -d '{
    "documents": [
      {
        "key": "doc-aws-lambda",
        "text": "AWS Lambda is a serverless compute service that runs code without provisioning servers.",
        "metadata": { "category": "compute", "source": "aws-docs" }
      },
      {
        "key": "doc-s3-vectors",
        "text": "Amazon S3 Vectors provides native vector storage with sub-second similarity search, reducing vector storage costs by up to 90%.",
        "metadata": { "category": "storage", "source": "aws-docs" }
      }
    ]
  }' \
  https://<api-id>.execute-api.<region>.amazonaws.com/v1/rag/ingest
```

Response:
```json
{ "ingested": 2, "index_name": "rag-default" }
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `documents` | array (1–100) | required | Documents to embed and store |
| `documents[].key` | string | required | Unique document identifier (used for upsert/delete) |
| `documents[].text` | string | required | Source text to embed |
| `documents[].metadata` | object | optional | Filterable key-value metadata |
| `index_name` | string | `rag-default` | Target vector index |
| `embedding_model` | string | `text-embedding-3-small` | OpenAI embedding model |

### RAG query — `POST /v1/rag/query`

```bash
# Streaming (SSE)
curl -N \
  -H "Authorization: Bearer gw_sk_changeme" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What is S3 Vectors and how does it reduce costs?",
    "model": "fast",
    "stream": true,
    "top_k": 5
  }' \
  https://<api-id>.execute-api.<region>.amazonaws.com/v1/rag/query
```

```bash
# Buffered (non-streaming)
curl \
  -H "Authorization: Bearer gw_sk_changeme" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What is S3 Vectors and how does it reduce costs?",
    "model": "smart",
    "stream": false,
    "top_k": 3,
    "metadata_filter": { "category": "storage" }
  }' \
  https://<api-id>.execute-api.<region>.amazonaws.com/v1/rag/query
```

Non-streaming response includes `rag_context` showing which documents were retrieved:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "smart",
  "choices": [{ "message": { "role": "assistant", "content": "S3 Vectors provides..." } }],
  "rag_context": [
    { "key": "doc-s3-vectors", "distance": 0.12 },
    { "key": "doc-aws-lambda", "distance": 0.87 }
  ]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | User question |
| `model` | string | required | Model alias for generation |
| `stream` | boolean | `false` | Stream response as SSE |
| `top_k` | integer (1–20) | `5` | Number of context chunks to retrieve |
| `index_name` | string | `rag-default` | Vector index to search |
| `system_prompt` | string | optional | Extra instructions appended after the retrieved context |
| `metadata_filter` | object | optional | Filter retrieved chunks by metadata fields |
| `embedding_model` | string | `text-embedding-3-small` | Must match the model used during ingest |
| `temperature` | number | optional | Generation temperature |
| `max_tokens` | integer | optional | Max output tokens |

### Vector index configuration

The CDK stack automatically provisions an S3 Vectors bucket and index on first deploy via a CloudFormation custom resource:

| Parameter | Value |
|-----------|-------|
| Bucket name | `llm-gateway-rag-<account-id>` |
| Index name | `rag-default` |
| Dimensions | `1536` (matches `text-embedding-3-small`) |
| Distance metric | `cosine` |
| `source_text` metadata | non-filterable (stored but not indexed for filtering) |

To use a different embedding model, update `RAG_EMBEDDING_MODEL` in the CDK stack and recreate the index with the correct dimension count. Supported OpenAI embedding models and their dimensions:

| Model | Dimensions |
|-------|-----------|
| `text-embedding-3-small` | 1536 |
| `text-embedding-3-large` | 3072 |
| `text-embedding-ada-002` | 1536 |

---

## Billing Dashboard

After deploy, open the `DashboardUrl` CloudFront URL printed by `cdk deploy`.

Enter your **Gateway Base URL** and **API Key** to pull usage data from `GET /v1/billing/usage`. The dashboard shows:

- Total requests, success rate, token counts, estimated cost
- Requests-per-day bar chart
- Model breakdown table with per-model cost estimates

Cost estimates use public list prices. Bedrock and Anthropic prices may vary by region and commitment tier.

---

## Local Development

```bash
cd apps/gateway
npm run test        # run unit tests (vitest)
npm run lint        # tsc --noEmit type check
```

---

## Roadmap

- **Phase 3**: Per-tenant CloudWatch EMF metrics, DLQ replay tool, model alias allowlist per tenant, prompt/response logging opt-in

See [plan/phases.md](plan/phases.md) for the full roadmap.
