import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { z } from 'zod';
import { getOpenAIAdapter } from '../providers/registry';
import { checkAndIncrementRateLimit, RateLimitError } from '../middleware/rateLimiter';

const ImageGenerationSchema = z.object({
    prompt: z.string().min(1, 'prompt is required'),
    model: z.enum(['dall-e-3', 'dall-e-2']).optional(),
    n: z.number().int().min(1).max(10).optional(),
    size: z.string().optional(),
    quality: z.enum(['standard', 'hd']).optional(),
    response_format: z.enum(['url', 'b64_json']).optional(),
    style: z.enum(['vivid', 'natural']).optional(),
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

    const parsed = ImageGenerationSchema.safeParse(raw);
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
        const result = await adapter.generateImage(parsed.data);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result),
        };
    } catch (err) {
        console.error(JSON.stringify({ message: 'Image generation error', error: String(err) }));
        return errResp(500, 'Internal server error', 'server_error');
    }
};
