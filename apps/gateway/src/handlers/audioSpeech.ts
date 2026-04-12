import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { z } from 'zod';
import { getOpenAIAdapter } from '../providers/registry';
import { checkAndIncrementRateLimit, RateLimitError } from '../middleware/rateLimiter';
import { CORS_HEADERS } from '../util/cors';

/**
 * POST /v1/audio/speech
 *
 * Returns base64-encoded audio in JSON.  Clients decode the `audio` field and
 * play/save the resulting bytes.
 *
 * Response: { audio: "<base64>", format: "mp3" }
 */
const SpeechSchema = z.object({
    model: z.enum(['tts-1', 'tts-1-hd']).default('tts-1'),
    input: z.string().min(1, 'input text is required'),
    voice: z.enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']),
    response_format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).optional(),
    speed: z.number().min(0.25).max(4.0).optional(),
});

function errResp(statusCode: number, message: string, type = 'invalid_request_error'): APIGatewayProxyResult {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
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

    const parsed = SpeechSchema.safeParse(raw);
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
        const result = await adapter.speak(parsed.data);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            body: JSON.stringify(result),
        };
    } catch (err) {
        console.error(JSON.stringify({ message: 'Speech error', error: String(err) }));
        return errResp(500, 'Internal server error', 'server_error');
    }
};
