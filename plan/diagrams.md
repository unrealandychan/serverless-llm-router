# Architecture Diagrams

## 1. System Architecture

```mermaid
flowchart TB
    subgraph Client["Client"]
        C([HTTP Client<br/>curl / SDK / app])
    end

    subgraph APIGW["API Gateway REST API"]
        direction TB
        AUTH["Lambda Authorizer\n(TOKEN type)\n5-min cache"]
        METHODS["POST /v1/chat/completions\nGET /v1/models"]
        AUTH -->|Allow + tenantId| METHODS
    end

    subgraph Lambdas["AWS Lambda  —  Node.js 22 ARM64"]
        GW["Gateway Lambda\n(streaming)\nchatCompletions.ts"]
        LM["ListModels Lambda\nlistModels.ts"]
        AU["Authorizer Lambda\nauthorizer.ts"]
        LC["Log Consumer Lambda\nlogConsumer.ts"]
    end

    subgraph Providers["LLM Providers"]
        OAI["OpenAI API\ngpt-4o / gpt-4o-mini"]
        BD["Bedrock  ⟶  Phase 2\nNova / Claude"]
        ANT["Anthropic  ⟶  Phase 2\nClaude Sonnet 4"]
    end

    subgraph AWS["AWS Services"]
        SM["Secrets Manager\n/openai-api-key\n/api-keys"]
        SQS["SQS Standard Queue\n+ DLQ"]
        DDB["DynamoDB\nllm_gateway_requests\nPK=tenantId  SK=ts#reqId\n3 GSIs"]
        CW["CloudWatch\nStructured Logs\nMetrics"]
    end

    C -->|"Authorization: Bearer gw_sk_..."| APIGW
    APIGW -->|invalid token| C
    METHODS --> GW
    METHODS --> LM
    AUTH --> AU
    AU -->|read keys| SM
    GW -->|fetch OpenAI key| SM
    GW -->|stream chunks SSE| C
    GW -->|audit event fire-and-forget| SQS
    GW --> OAI
    GW -.->|Phase 2| BD
    GW -.->|Phase 2| ANT
    SQS --> LC
    LC -->|PutItem idempotent| DDB
    GW -->|structured logs| CW
    LC -->|structured logs| CW
```

---

## 2. Request Flow — Streaming Path

```mermaid
sequenceDiagram
    actor Client
    participant APIGW as API Gateway
    participant Authz as Authorizer Lambda
    participant SM as Secrets Manager
    participant GW as Gateway Lambda
    participant OAI as OpenAI API
    participant SQS
    participant LC as Log Consumer
    participant DDB as DynamoDB

    Client->>APIGW: POST /v1/chat/completions<br/>Authorization: Bearer gw_sk_...

    APIGW->>Authz: token (cached if seen recently)
    Authz->>SM: GetSecretValue /api-keys (warm cache)
    SM-->>Authz: keys JSON map
    Authz-->>APIGW: Allow policy + tenantId context

    APIGW->>GW: event + requestContext.authorizer.tenantId<br/>(InvokeWithResponseStream)
    Note over GW: Validate schema (Zod)<br/>Resolve alias → provider/model<br/>Fetch OpenAI key (warm cache)

    GW->>OAI: streaming chat completion
    OAI-->>GW: chunk 1 … chunk N

    loop SSE chunks
        GW-->>Client: event: delta\ndata: {"content":"..."}
    end

    GW-->>Client: event: done\ndata: [DONE]

    GW--)SQS: SendMessage audit event (fire-and-forget)

    SQS--)LC: batch of records
    LC->>DDB: PutItem (ConditionExpression: attribute_not_exists)<br/>idempotent upsert
```

---

## 3. Auth Flow — Lambda Authorizer

```mermaid
flowchart TD
    REQ["Incoming Request\nAuthorization: Bearer TOKEN"] --> AGW["API Gateway\nchecks authorizer cache"]

    AGW -->|cache HIT| ALLOW["Cached Allow policy\n+ tenantId context"]
    AGW -->|cache MISS| AUTHZ["Authorizer Lambda"]

    AUTHZ --> STRIP["Strip 'Bearer ' prefix\nfrom token"]
    STRIP --> LOAD["Load keys from\nSecrets Manager\n(warm-cached 5 min)"]
    LOAD --> LOOKUP{key exists\nin map?}

    LOOKUP -->|No| DENY["Return Deny policy\ncached 5 min"]
    LOOKUP -->|internal error| DENY

    LOOKUP -->|Yes| BUILD["Build Allow policy\ncontext = { tenantId, label }"]
    BUILD --> CACHE_ALLOW["API GW caches Allow\nfor 5 min per token"]
    CACHE_ALLOW --> ALLOW

    DENY --> GATEWAY_403["API Gateway\nreturns 403 Forbidden\nGateway Lambda never runs"]

    ALLOW --> GW["Gateway Lambda\nreads tenantId from\nevent.requestContext.authorizer.tenantId"]
```

---

## 4. Routing Logic — Alias Resolution & Fallback Chain

```mermaid
flowchart LR
    subgraph ALIAS["Model Alias Resolution  —  core/router.ts"]
        direction LR
        IN([alias e.g. 'fast']) --> LOOKUP{alias in\nmodelMap?}
        LOOKUP -->|No| ERR["400 model_not_found"]
        LOOKUP -->|Yes| TARGETS["targets list\n[{provider, model, weight}]"]
        TARGETS --> WEIGHTED["Weighted Random\nselection"]
        WEIGHTED --> TARGET([provider + model])
        TARGET --> INVOKE["invoke(provider, model)"]
        INVOKE -->|retryable error 429/5xx/timeout| FALLBACK{fallbacks\nremaining?}
        FALLBACK -->|Yes, not visited| LOOKUP
        FALLBACK -->|No| UPSTREAM_ERR["502 upstream_error"]
        INVOKE -->|non-retryable 400/401/403| RETHROW["throw immediately\nno fallback"]
        INVOKE -->|success| RESULT([result])
    end
```
