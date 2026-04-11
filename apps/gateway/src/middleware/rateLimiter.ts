import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export class RateLimitError extends Error {
    readonly statusCode = 429;
    readonly type = 'rate_limit_error';

    constructor(message: string) {
        super(message);
        this.name = 'RateLimitError';
    }
}

type WindowType = 'minute' | 'day';

function windowKey(tenantId: string, type: WindowType): { pk: string; ttl: number } {
    const now = new Date();
    if (type === 'minute') {
        // Window key: YYYYMMDDTHHMI (no separators)
        const w = now.toISOString().slice(0, 16).replace(/[T:-]/g, '');
        return {
            pk: `${tenantId}#minute#${w}`,
            // Expire 2 minutes later so late-arriving writes still succeed
            ttl: Math.floor(now.getTime() / 1000) + 120,
        };
    }
    const w = now.toISOString().slice(0, 10).replace(/-/g, '');
    return {
        pk: `${tenantId}#day#${w}`,
        ttl: Math.floor(now.getTime() / 1000) + 2 * 86_400,
    };
}

/**
 * Atomically increment the counter for a rate-limit window and return the new count.
 * Sets TTL on first write so DynamoDB auto-expires old windows.
 */
async function increment(tableName: string, pk: string, ttl: number): Promise<number> {
    const result = await dynamo.send(
        new UpdateCommand({
            TableName: tableName,
            Key: { pk },
            UpdateExpression: 'ADD #cnt :one SET #ttl = if_not_exists(#ttl, :ttl)',
            ExpressionAttributeNames: { '#cnt': 'count', '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':one': 1, ':ttl': ttl },
            ReturnValues: 'ALL_NEW',
        }),
    );
    return (result.Attributes?.['count'] as number) ?? 1;
}

/**
 * Atomically increment per-minute and per-day request counters for a tenant.
 * Throws RateLimitError if either window exceeds the configured limit.
 *
 * Configuration (env vars, all optional):
 *   RATE_LIMITS_TABLE_NAME — if absent, rate limiting is disabled (no-op)
 *   RPM_LIMIT              — requests per minute, default 60
 *   RPD_LIMIT              — requests per day,    default 1000
 */
export async function checkAndIncrementRateLimit(tenantId: string): Promise<void> {
    const tableName = process.env.RATE_LIMITS_TABLE_NAME;
    if (!tableName) return; // Rate limiting disabled

    const rpmLimit = parseInt(process.env.RPM_LIMIT ?? '60', 10);
    const rpdLimit = parseInt(process.env.RPD_LIMIT ?? '1000', 10);

    const { pk: minutePk, ttl: minuteTtl } = windowKey(tenantId, 'minute');
    const { pk: dayPk, ttl: dayTtl } = windowKey(tenantId, 'day');

    // Run both increments concurrently
    const [minuteCount, dayCount] = await Promise.all([
        increment(tableName, minutePk, minuteTtl),
        increment(tableName, dayPk, dayTtl),
    ]);

    if (minuteCount > rpmLimit) {
        throw new RateLimitError(
            `Rate limit exceeded: ${minuteCount} requests this minute (limit ${rpmLimit} rpm)`,
        );
    }
    if (dayCount > rpdLimit) {
        throw new RateLimitError(
            `Rate limit exceeded: ${dayCount} requests today (limit ${rpdLimit} rpd)`,
        );
    }
}
