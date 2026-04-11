import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { z } from 'zod';
import { getOpenAIAdapter } from '../providers/registry';
import { checkAndIncrementRateLimit, RateLimitError } from '../middleware/rateLimiter';

/**
 * POST /v1/audio/transcriptions
 *
 * Accepts JSON with base64-encoded audio (instead of multipart/form-data) to work
 * within API Gateway / Lambda constraints. Clients should base64-encode the audio
 * file before sending.
 *
 * Request body:
 *   { audio: "<base64>", filename: "recording.mp3", model: "whisper-1", language?: "en" }
 */
const TranscriptionSchema = z.object({
    audio: z.string().min(1, 'audio (base64) is required'),
    filename: z.string().min(1, 'filename is required'),
    model: z.string().default('whisper-1'),
    language: z.string().optional(),
    prompt: z.string().optional(),
    temperature: z.number().min(0).max(1).optional(),
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

    // API Gateway may base64-encode binary request bodies
    const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, 'base64').toString('utf-8')
        : event.body;

    if (!rawBody) return errResp(400, 'Request body is required');

    let raw: unknown;
    try { raw = JSON.parse(rawBody); } catch {
        return errResp(400, 'Invalid JSON body', 'parse_error');
    }

    const parsed = TranscriptionSchema.safeParse(raw);
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
        const result = await adapter.transcribe(parsed.data);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result),
        };
    } catch (err) {
        console.error(JSON.stringify({ message: 'Transcription error', error: String(err) }));
        return errResp(500, 'Internal server error', 'server_error');
    }
};
