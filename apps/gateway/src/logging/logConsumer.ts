import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { AuditEvent } from './auditEvent';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME ?? '';

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const failures: SQSBatchItemFailure[] = [];

    for (const record of event.Records) {
        try {
            const audit: AuditEvent = JSON.parse(record.body) as AuditEvent;
            await upsertRequest(audit);
        } catch (err) {
            console.error(
                JSON.stringify({ message: 'Failed to process SQS record', messageId: record.messageId, error: String(err) }),
            );
            failures.push({ itemIdentifier: record.messageId });
        }
    }

    return { batchItemFailures: failures };
};

async function upsertRequest(event: AuditEvent): Promise<void> {
    const sk = `ts#${event.createdAt}#${event.requestId}`;
    // TTL: 90 days from createdAt
    const ttl = Math.floor(new Date(event.createdAt).getTime() / 1000) + 90 * 24 * 60 * 60;

    try {
        await dynamo.send(
            new PutCommand({
                TableName: TABLE_NAME,
                Item: {
                    tenantId: event.tenantId,
                    sk,
                    requestId: event.requestId,
                    createdAt: event.createdAt,
                    modelAlias: event.modelAlias,
                    resolvedProvider: event.provider,
                    resolvedModel: event.providerModel,
                    stream: event.stream,
                    status: event.status,
                    latencyMs: event.latencyMs,
                    ttfbMs: event.ttfbMs,
                    inputTokens: event.inputTokens,
                    outputTokens: event.outputTokens,
                    errorCode: event.error ?? null,
                    userId: event.userId ?? null,
                    providerStatus: `${event.provider}#${event.status}`,
                    metadata: event.metadata ?? null,
                    ttl,
                },
                // Idempotent write — silently skip if record already exists (duplicate SQS delivery)
                ConditionExpression: 'attribute_not_exists(requestId)',
            }),
        );
    } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
            // Already written — idempotent, treat as success
            console.info(JSON.stringify({ message: 'Duplicate audit event, skipping', requestId: event.requestId }));
            return;
        }
        throw err;
    }
}
