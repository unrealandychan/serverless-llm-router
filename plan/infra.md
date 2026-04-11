# Infrastructure

## CDK Resources

### Stacks

| Stack | File | Description |
|-------|------|-------------|
| `GatewayStack` | `lib/gateway-stack.ts` | All resources in a single stack for v1 |

---

## Resources

### Lambda Functions

| Logical ID | Handler | Runtime | Memory | Timeout |
|-----------|---------|---------|--------|---------|
| `Gateway` | `chatCompletions.handler` | `nodejs22.x` | 512 MB | 30 s |
| `ListModels` | `listModels.handler` | `nodejs22.x` | 128 MB | 10 s |
| `LogConsumer` | `logConsumer.handler` | `nodejs22.x` | 256 MB | 30 s |

All functions use `NodejsFunction` + esbuild bundling. `@aws-sdk/*` is marked external (available in Lambda runtime).

### API Gateway REST API

| Resource | Method | Integration | Notes |
|---------|--------|-------------|-------|
| `/v1/chat/completions` | POST | `Gateway` Lambda (streaming) | Streaming integration config — see below |
| `/v1/models` | GET | `ListModels` Lambda | Standard proxy integration |

### SQS

| Queue | Visibility Timeout | DLQ | Max Receive Count |
|-------|--------------------|-----|-------------------|
| `llm-gateway-audit` | 30 s | `llm-gateway-audit-dlq` | 3 |
| `llm-gateway-audit-dlq` | — | — | retention: 14 days |

### DynamoDB

| Table | Billing | Key | GSIs |
|-------|---------|-----|------|
| `llm_gateway_requests` | On-demand | PK: `tenantId`, SK: `sk` | 3 — see [data-model.md](data-model.md) |

TTL attribute: `ttl`

### Secrets Manager

| Secret | Path | Used By |
|--------|------|---------|
| OpenAI API key | `/llm-gateway/openai-api-key` | `Gateway` Lambda |

---

## IAM Policies

### Gateway Lambda

```
sqs:SendMessage        → AuditQueue ARN
secretsmanager:GetSecretValue → OpenAI secret ARN
logs:CreateLogGroup / CreateLogStream / PutLogEvents → Lambda log group
```

### Log Consumer Lambda

```
dynamodb:PutItem       → llm_gateway_requests table ARN
sqs:ReceiveMessage / DeleteMessage / GetQueueAttributes → AuditQueue ARN
logs:CreateLogGroup / CreateLogStream / PutLogEvents → Lambda log group
```

### API Gateway → Gateway Lambda

Resource-based policy on Gateway Lambda:
```
Principal: apigateway.amazonaws.com
Action: lambda:InvokeFunction
SourceArn: arn:aws:execute-api:{region}:{account}:{api-id}/*/POST/v1/chat/completions
```

---

## API Gateway Streaming Integration

Standard CDK `LambdaIntegration` does not support streaming. Use the escape hatch:

```ts
// 1. Construct the streaming invocations URI
const streamingUri = cdk.Fn.join('', [
  'arn:', cdk.Aws.PARTITION,
  ':apigateway:', cdk.Aws.REGION,
  ':lambda:path/2015-03-31/functions/',
  gatewayFn.functionArn,
  '/response-streaming-invocations',
]);

// 2. Create integration with streaming URI
const streamIntegration = new apigw.Integration({
  type: apigw.IntegrationType.AWS_PROXY,
  integrationHttpMethod: 'POST',
  uri: streamingUri,
});

// 3. Add method
const chatMethod = chatResource.addMethod('POST', streamIntegration, { ... });

// 4. Override ResponseTransferMode via CFN escape hatch
const cfnMethod = chatMethod.node.defaultChild as apigw.CfnMethod;
cfnMethod.addOverride('Properties.Integration.ResponseTransferMode', 'STREAMING');
```

---

## Bedrock Permissions (Phase 2)

When Bedrock adapter is added:

```
bedrock:InvokeModel                 → arn:aws:bedrock:{region}::foundation-model/*
bedrock:InvokeModelWithResponseStream → arn:aws:bedrock:{region}::foundation-model/*
```

---

## CloudFormation Outputs

| Output | Value |
|--------|-------|
| `ApiUrl` | API Gateway invoke URL |
| `TableName` | DynamoDB table name |
| `AuditQueueUrl` | SQS queue URL |
| `OpenAiSecretArn` | Secrets Manager ARN |

---

## Deploy Commands

```bash
# First deploy
cd infra/cdk
npx cdk bootstrap
npx cdk deploy

# Update
npx cdk deploy --hotswap   # fast Lambda code updates
npx cdk diff               # preview changes
```

After deploying, populate the OpenAI API key:

```bash
aws secretsmanager put-secret-value \
  --secret-id /llm-gateway/openai-api-key \
  --secret-string "sk-..."
```
