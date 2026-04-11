# API Specification

## POST /v1/chat/completions

### Request

```json
{
  "model": "fast",
  "messages": [
    { "role": "system", "content": "You are concise." },
    { "role": "user", "content": "Explain DynamoDB streams briefly." }
  ],
  "stream": true,
  "temperature": 0.2,
  "max_tokens": 512,
  "user": "u_123",
  "metadata": { "app": "demo", "traceId": "abc123" }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `model` | string | yes | Model alias from routing config |
| `messages` | array | yes | Min 1 message; roles: `system`, `user`, `assistant`, `tool` |
| `stream` | boolean | no | Default `false` |
| `temperature` | number | no | 0–2 |
| `max_tokens` | number | no | Positive integer |
| `user` | string | no | Caller-supplied user ID for audit |
| `metadata` | object | no | Arbitrary string key-value pairs passed through to audit log |

### Response — `stream: false`

HTTP 200 `application/json`

```json
{
  "id": "req_01j9abc...",
  "object": "chat.completion",
  "model": "fast",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "DynamoDB Streams captures..." },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 22,
    "completion_tokens": 48,
    "total_tokens": 70
  }
}
```

### Response — `stream: true`

HTTP 200 `text/event-stream`

```
event: message.start
data: {"id":"req_01j9abc..."}

event: delta
data: {"content":"DynamoDB"}

event: delta
data: {"content":" Streams"}

event: message.end
data: {"finish_reason":"stop"}

event: usage
data: {"input_tokens":22,"output_tokens":48}

event: done
data: [DONE]
```

### Error Response

All errors use the same envelope (OpenAI-compatible):

```json
{
  "error": {
    "message": "Model alias not configured: foo",
    "type": "invalid_request_error",
    "code": "model_not_found"
  }
}
```

For `stream: true`, errors are sent as an SSE event before `[DONE]`:

```
event: error
data: {"error":{"message":"...","type":"...","code":"..."}}

event: done
data: [DONE]
```

### Error Codes

| HTTP | type | code | Cause |
|------|------|------|-------|
| 400 | `invalid_request_error` | `missing_body` | No request body |
| 400 | `invalid_request_error` | `parse_error` | Invalid JSON |
| 400 | `invalid_request_error` | `validation_error` | Zod schema violation |
| 400 | `invalid_request_error` | `model_not_found` | Unknown model alias |
| 401 | `authentication_error` | `invalid_api_key` | Missing or wrong API key |
| 502 | `upstream_error` | `upstream_error` | Provider returned retryable error after all fallbacks exhausted |
| 500 | `server_error` | `internal_error` | Unexpected internal error |

---

## GET /v1/models

Returns publicly exposed model aliases. Does not reveal provider credentials or internal model names.

### Response

HTTP 200 `application/json`

```json
{
  "object": "list",
  "data": [
    { "id": "fast", "object": "model", "owned_by": "gateway" },
    { "id": "gpt-4o", "object": "model", "owned_by": "gateway" },
    { "id": "gpt-4o-mini", "object": "model", "owned_by": "gateway" },
    { "id": "claude-sonnet-4", "object": "model", "owned_by": "gateway" }
  ]
}
```

---

## Authentication

Pass the gateway API key in the `Authorization` header:

```
Authorization: Bearer gw_sk_...
```

Missing or invalid key → `401 authentication_error`.

If `API_KEY` environment variable is not set, authentication is skipped (useful for local/dev).

---

## Headers

### Request headers used

| Header | Purpose |
|--------|---------|
| `Authorization` | `Bearer <api-key>` |
| `Content-Type` | Must be `application/json` |

### Response headers

| Header | Value |
|--------|-------|
| `X-Request-Id` | Gateway-assigned request ID (e.g. `req_01j9abc...`) |
| `Content-Type` | `text/event-stream` or `application/json` |
| `Cache-Control` | `no-cache` |
| `X-Accel-Buffering` | `no` (streaming responses only) |
