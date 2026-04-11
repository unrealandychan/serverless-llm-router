# Routing

## Routing Config Format

```json
{
  "gpt-4o": {
    "targets": [
      { "provider": "openai", "model": "gpt-4o", "weight": 100 }
    ],
    "fallbacks": ["claude-sonnet-4"]
  },
  "claude-sonnet-4": {
    "targets": [
      { "provider": "anthropic", "model": "claude-sonnet-4-20250514", "weight": 100 }
    ]
  },
  "fast": {
    "targets": [
      { "provider": "openai", "model": "gpt-4o-mini", "weight": 60 },
      { "provider": "bedrock", "model": "amazon.nova-lite-v1:0", "weight": 40 }
    ],
    "fallbacks": ["gpt-4o-mini"]
  },
  "gpt-4o-mini": {
    "targets": [
      { "provider": "openai", "model": "gpt-4o-mini", "weight": 100 }
    ]
  }
}
```

### Fields

| Field | Type | Notes |
|-------|------|-------|
| `targets` | array | One or more provider/model targets with weights |
| `targets[].provider` | string | Must match a registered `ProviderAdapter.name` |
| `targets[].model` | string | Provider-native model name |
| `targets[].weight` | number | Relative weight for random selection (positive integer) |
| `fallbacks` | string[] | Ordered list of alias names to try on retryable error |

---

## Resolution Algorithm

```
1. Look up alias in routing config
   └─ Not found → throw ModelNotFoundError (400 model_not_found)

2. Select a target via weighted random selection:
   - Sum all weights
   - Pick random number in [0, sum)
   - Walk targets, subtracting weight until ≤ 0
   - Return final target

3. Invoke the selected target
   └─ On retryable error:
       - Take first unused fallback alias from the list
       - Recurse from step 1 with visited-set tracking
       - If no unvisited fallbacks remain → re-throw last error
   └─ On non-retryable error:
       - Immediately re-throw (no fallback)
```

---

## Weighted Target Selection

Given targets `[{weight:60}, {weight:40}]`:

- Total = 100
- `rand = Math.random() * 100` → say 72
- After first target: `72 - 60 = 12` (> 0, continue)
- After second target: `12 - 40 = -28` (≤ 0, select this)

Edge cases:
- Single target → always selected regardless of weight
- All weights equal → uniform random
- Last target is always the fallback if floating-point rounding causes no selection

---

## Fallback Chain

```
fast → fails retryably → try "gpt-4o-mini"
gpt-4o-mini → fails retryably → no more fallbacks → throw upstream_error
```

Cycle protection: a `visited` set prevents infinite loops if two aliases reference each other.

---

## Retryable vs Non-Retryable Errors

### Retryable (triggers fallback)

| Condition | Example |
|-----------|---------|
| HTTP 408 | Request timeout |
| HTTP 429 | Rate limit |
| HTTP 500 | Internal server error |
| HTTP 502 | Bad gateway |
| HTTP 503 | Service unavailable |
| HTTP 504 | Gateway timeout |
| `ECONNRESET` | Network connection reset |
| `ECONNREFUSED` | Provider unreachable |
| `ETIMEDOUT` | Socket timeout |

### Non-Retryable (throws immediately)

| Condition | Example |
|-----------|---------|
| HTTP 400 | Malformed request to provider |
| HTTP 401 | Invalid provider API key |
| HTTP 403 | Forbidden / quota exceeded (permanent) |
| HTTP 422 | Unprocessable request |
| Content policy rejection | Provider blocks message |
| Zod validation failure | Gateway-level schema error |

**Design note:** Content policy rejections are non-retryable to prevent unintended cross-provider policy bypass.

---

## Streaming Fallback (Phase 1 limitation)

In Phase 1, the streaming path uses a single-target resolution with no fallback:

```
1. Resolve alias → selectTarget → single target
2. Open stream
3. If error during stream setup (before first chunk) → return 502
4. If error after first chunk is written → write SSE error event + [DONE]
```

Phase 2 will add streaming fallback: if stream setup fails before the first chunk, try the next fallback target.

---

## Unknown Model Alias Behavior

| Alias | Behavior |
|-------|----------|
| Known alias | Route to configured targets |
| Unknown alias | Return `400 model_not_found` — no silent fallback |

This is intentional. Silent fallbacks cause confusing behavior (unexpected costs, different response quality). Be explicit.
