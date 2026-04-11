Build a TypeScript monorepo for a serverless LLM gateway on AWS.

Goal:
- OpenAI-compatible API surface for /v1/chat/completions
- Request body contains model alias, and the gateway routes to the correct provider/model
- Support both stream=true and stream=false
- For stream=true, use AWS Lambda response streaming with API Gateway REST response streaming and return SSE
- Log request outcome asynchronously by sending an event to SQS
- A separate Lambda consumes SQS and writes structured request records to DynamoDB
- Use Node.js 22 Lambda runtime and AWS CDK

Architecture:
- API Gateway REST API
- Gateway Lambda with response streaming
- SQS queue + DLQ
- Log writer Lambda
- DynamoDB table for request logs
- Secrets Manager for provider API keys
- CloudWatch structured logs and metrics

Implement these modules:
1. core/router.ts
   - resolve model alias to target provider/model
   - support weighted targets
   - support fallback chain on retryable errors

2. providers/openai.ts
   - implement non-streaming and streaming chat completion calls
   - normalize provider chunks to internal stream events

3. handlers/chatCompletions.ts
   - validate OpenAI-style request
   - invoke router
   - if stream=true, write SSE chunks to Lambda response stream
   - if stream=false, return JSON
   - emit audit event to SQS in both success and failure paths

4. handlers/listModels.ts
   - return public model aliases

5. logging/sqsPublisher.ts
   - publish compact audit events with requestId, tenantId, modelAlias, provider, timings, usage, status, and error

6. logging/logConsumer.ts
   - consume SQS batch safely
   - idempotently write to DynamoDB
   - support partial batch failure response

7. infra/cdk
   - define all AWS resources
   - configure API Gateway REST integration for Lambda response streaming
   - set Integration.ResponseTransferMode=STREAM
   - use the response-streaming-invocations URI
   - least-privilege IAM

Data model:
- DynamoDB PK=tenantId, SK=ts#requestId
- GSI on requestId
- GSI on modelAlias + createdAt
- store status, latencyMs, ttfbMs, token usage, provider info, and metadata

Requirements:
- strong typing with zod
- structured JSON logging
- no framework unless it helps streaming compatibility
- unit-test router and provider normalization
- keep provider interface generic so Anthropic and Bedrock can be added next
- keep all code production-ready and minimal