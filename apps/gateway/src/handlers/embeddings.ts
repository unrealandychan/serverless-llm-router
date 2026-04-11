import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { z } from 'zod';
import { getOpenAIAdapter } from '../providers/registry';
import { checkAndIncrementRateLimit, RateLimitError } from '../middleware/rateLimiter';

const EmbeddingRequestSchema = z.object({
    input: z.union([z.string(), z.array(z.string())]),
    model: z.string().min(1),
    encoding_format: z.enum(['float', 'base64']).optional(),
    dimensions: z.number().int().positive().optional(),
    user: z.string().optional(),
});

function errResp(statusCode: number, message: string, type = 'invalid_request_error'): APIGatewayProxyResult {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { message, type } }),
    };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const tenantId =
        (event.requestContext?.authorizer?.['tenantId'] as string | undefined) ??
        process.env.DEFAULT_TENANT_ID ??
        't_default';

    if (!event.body) return errResp(400, 'Request body is required');

    let raw: unknown;
    try { raw = JSON.parse(event.body); } catch {
        return errResp(400, 'Invalid JSON body', 'parse_error');
    }

    const parsed = EmbeddingRequestSchema.safeParse(raw);
    if (!parsed.success) {
        return errResp(400, parsed.error.errors[0]?.message ?? 'Invalid request');
    }

    try {
        await checkAndIncrementRateLimit(tenantId);
    } catch (err) {
        if (err instanceof RateLimitError) return errResp(429, err.message, err.type);
        throw err;
    }

    try {
        const adapter = await getOpenAIAdapter();
        const result = await adapter.embed(parsed.data);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result),
        };
    } catch (err) {
        console.error(JSON.stringify({ message: 'Embeddings error', error: String(err) }));
        return errResp(500, 'Internal server error', 'server_error');
    }
};
