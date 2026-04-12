import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CORS_HEADERS } from '../util/cors';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME ?? '';

/**
 * Estimated cost per 1M tokens (input / output) in USD.
 * Keyed as "provider/model-id".
 */
const PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
    // Keep legacy keys for historical records generated before alias updates.
    'openai/gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
    'openai/gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.60 },
    // Update these to your contract rates if they differ.
    'openai/gpt-5.4': { inputPer1M: 2.5, outputPer1M: 10.0 },
    'openai/gpt-5.2-codex': { inputPer1M: 0.15, outputPer1M: 0.60 },
    'openai/text-embedding-3-small': { inputPer1M: 0.02, outputPer1M: 0 },
    'openai/text-embedding-3-large': { inputPer1M: 0.13, outputPer1M: 0 },
    'bedrock/amazon.nova-micro-v1:0': { inputPer1M: 0.035, outputPer1M: 0.14 },
    'bedrock/amazon.nova-lite-v1:0': { inputPer1M: 0.06, outputPer1M: 0.24 },
    'bedrock/amazon.nova-pro-v1:0': { inputPer1M: 0.80, outputPer1M: 3.20 },
    'bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0': { inputPer1M: 3.0, outputPer1M: 15.0 },
    'anthropic/claude-sonnet-4-5': { inputPer1M: 3.0, outputPer1M: 15.0 },
    'anthropic/claude-haiku-3-5': { inputPer1M: 0.8, outputPer1M: 4.0 },
};

function estimateCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
    const pricing = PRICING[`${provider}/${model}`];
    if (!pricing) return 0;
    return (inputTokens / 1_000_000) * pricing.inputPer1M +
        (outputTokens / 1_000_000) * pricing.outputPer1M;
}

function errResp(statusCode: number, message: string): APIGatewayProxyResult {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        body: JSON.stringify({ error: { message, type: 'invalid_request_error' } }),
    };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const tenantId =
        (event.requestContext?.authorizer?.['tenantId'] as string | undefined) ??
        process.env.DEFAULT_TENANT_ID ??
        't_default';

    const qp = event.queryStringParameters ?? {};
    // Default: last 30 days
    const fromDate = qp['from'] ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const toDate = qp['to'] ?? new Date().toISOString().slice(0, 10);

    const fromSk = `ts#${fromDate}T00:00:00.000Z`;
    const toSk = `ts#${toDate}T23:59:59.999Z`;

    // Paginate through all items for the tenant in the date range
    const items: Array<Record<string, unknown>> = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
        const result = await dynamo.send(
            new QueryCommand({
                TableName: TABLE_NAME,
                KeyConditionExpression: 'tenantId = :tid AND sk BETWEEN :from AND :to',
                ExpressionAttributeValues: { ':tid': tenantId, ':from': fromSk, ':to': toSk },
                ProjectionExpression:
                    'modelAlias, resolvedProvider, resolvedModel, #st, inputTokens, outputTokens, createdAt',
                ExpressionAttributeNames: { '#st': 'status' },
                ExclusiveStartKey: lastKey as Record<string, unknown> | undefined,
                Limit: 1000,
            }),
        );
        items.push(...(result.Items ?? []) as Array<Record<string, unknown>>);
        lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    // Aggregate
    let totalRequests = 0;
    let successfulRequests = 0;
    let failedRequests = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;

    const byModel: Record<string, { requests: number; inputTokens: number; outputTokens: number; cost: number }> = {};
    const byDate: Record<string, { requests: number; totalTokens: number }> = {};

    for (const item of items) {
        totalRequests++;
        const status = (item['status'] as string) ?? 'unknown';
        const inputTokens = (item['inputTokens'] as number) ?? 0;
        const outputTokens = (item['outputTokens'] as number) ?? 0;
        const modelAlias = (item['modelAlias'] as string) ?? 'unknown';
        const provider = (item['resolvedProvider'] as string) ?? 'unknown';
        const model = (item['resolvedModel'] as string) ?? 'unknown';
        const createdAt = (item['createdAt'] as string) ?? '';
        const dateKey = createdAt.slice(0, 10) || fromDate;
        const cost = estimateCost(provider, model, inputTokens, outputTokens);

        if (status === 'completed') successfulRequests++;
        else failedRequests++;

        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        totalCostUsd += cost;

        if (!byModel[modelAlias]) byModel[modelAlias] = { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
        byModel[modelAlias].requests++;
        byModel[modelAlias].inputTokens += inputTokens;
        byModel[modelAlias].outputTokens += outputTokens;
        byModel[modelAlias].cost += cost;

        if (!byDate[dateKey]) byDate[dateKey] = { requests: 0, totalTokens: 0 };
        byDate[dateKey].requests++;
        byDate[dateKey].totalTokens += inputTokens + outputTokens;
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        body: JSON.stringify({
            tenantId,
            period: { from: fromDate, to: toDate },
            summary: {
                totalRequests,
                successfulRequests,
                failedRequests,
                totalInputTokens,
                totalOutputTokens,
                estimatedCostUsd: Math.round(totalCostUsd * 10_000) / 10_000,
            },
            byModel: Object.entries(byModel)
                .map(([modelAlias, d]) => ({
                    modelAlias,
                    requests: d.requests,
                    inputTokens: d.inputTokens,
                    outputTokens: d.outputTokens,
                    estimatedCostUsd: Math.round(d.cost * 10_000) / 10_000,
                }))
                .sort((a, b) => b.requests - a.requests),
            byDate: Object.entries(byDate)
                .map(([date, d]) => ({ date, requests: d.requests, totalTokens: d.totalTokens }))
                .sort((a, b) => a.date.localeCompare(b.date)),
        }),
    };
};
