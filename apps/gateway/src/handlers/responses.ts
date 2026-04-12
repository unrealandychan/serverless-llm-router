import type { APIGatewayProxyEvent } from 'aws-lambda';
import { resolveAlias, selectTarget, routeWithFallback } from '../core/router';
import { mergeUsage } from '../core/stream';
import {
    ResponsesRequestSchema,
    ResponsesRequest,
    inputToMessages,
    generateResponseId,
    generateMessageId,
    buildResponseBody,
    formatResponseSseEvent,
} from '../core/responses';
import { getProviderAdapter } from '../providers/registry';
import { NormalizedRequest } from '../providers/types';
import { publishAuditEvent } from '../logging/sqsPublisher';
import { AuditEvent } from '../logging/auditEvent';
import { loadRoutes } from '../config/routeLoader';
import { checkAndIncrementRateLimit, RateLimitError } from '../middleware/rateLimiter';
import { generateRequestId } from '../util/ids';
import { nowIso, elapsedMs } from '../util/time';
import { toErrorResponse, GatewayError } from '../util/errors';
import { CORS_HEADERS } from '../util/cors';

// ─── Lambda handler ───────────────────────────────────────────────────────────

function parseRequest(event: APIGatewayProxyEvent): ResponsesRequest {
    if (!event.body) {
        throw new GatewayError('Request body is required', 'invalid_request_error', 'missing_body', 400);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(event.body);
    } catch {
        throw new GatewayError('Invalid JSON body', 'invalid_request_error', 'parse_error', 400);
    }
    const result = ResponsesRequestSchema.safeParse(raw);
    if (!result.success) {
        const msg = result.error.errors[0]?.message ?? 'Invalid request';
        throw new GatewayError(msg, 'invalid_request_error', 'validation_error', 400);
    }
    return result.data;
}

export const handler = awslambda.streamifyResponse(
    async (event: APIGatewayProxyEvent, responseStream: NodeJS.WritableStream): Promise<void> => {
        const requestId = generateRequestId();
        const createdAt = nowIso();
        const startMs = Date.now();
        const tenantId =
            (event.requestContext?.authorizer?.['tenantId'] as string | undefined) ??
            process.env.DEFAULT_TENANT_ID ??
            't_default';

        let req: ResponsesRequest | undefined;
        let earlyError: GatewayError | undefined;
        let rateLimitError: RateLimitError | undefined;

        try {
            req = parseRequest(event);
        } catch (err) {
            earlyError =
                err instanceof GatewayError
                    ? err
                    : new GatewayError('Internal error', 'server_error', 'internal_error', 500);
        }

        if (!earlyError) {
            try {
                await checkAndIncrementRateLimit(tenantId);
            } catch (err) {
                if (err instanceof RateLimitError) rateLimitError = err;
                else throw err;
            }
        }

        const isStream = req?.stream ?? false;
        const responseStatusCode = earlyError
            ? earlyError.statusCode
            : rateLimitError
              ? 429
              : 200;

        const httpStream = awslambda.HttpResponseStream.from(responseStream, {
            statusCode: responseStatusCode,
            headers: {
                'Content-Type': isStream ? 'text/event-stream' : 'application/json',
                'Cache-Control': 'no-cache',
                'X-Request-Id': requestId,
                ...(isStream ? { 'X-Accel-Buffering': 'no' } : {}),
                ...CORS_HEADERS,
            },
        });

        if (earlyError) {
            httpStream.write(JSON.stringify(toErrorResponse(earlyError)));
            httpStream.end();
            return;
        }

        if (rateLimitError) {
            httpStream.write(
                JSON.stringify({
                    error: { message: rateLimitError.message, type: rateLimitError.type, code: 'rate_limit_exceeded' },
                }),
            );
            httpStream.end();
            return;
        }

        const validReq = req!;
        const messages = inputToMessages(validReq);
        const modelAlias = validReq.model;
        let resolvedProvider = 'unknown';
        let resolvedModel = 'unknown';
        let status: 'completed' | 'failed' = 'failed';
        let inputTokens = 0;
        let outputTokens = 0;
        let ttfbMs: number | null = null;
        let errorMsg: string | null = null;

        const baseReq: Omit<NormalizedRequest, 'model'> = {
            messages,
            stream: validReq.stream,
            temperature: validReq.temperature,
            max_tokens: validReq.max_output_tokens,
        };

        try {
            const routes = await loadRoutes();
            const responseId = generateResponseId();

            if (validReq.stream) {
                const route = resolveAlias(validReq.model, routes);
                const target = selectTarget(route.targets);
                resolvedProvider = target.provider;
                resolvedModel = target.model;

                const adapter = await getProviderAdapter(target.provider);
                let usageAcc: { input_tokens?: number; output_tokens?: number } = {};
                let fullText = '';
                let msgId = '';

                // Emit opening SSE events
                const partialResponse = {
                    id: responseId,
                    object: 'response',
                    created_at: Math.floor(Date.now() / 1000),
                    status: 'in_progress',
                    model: validReq.model,
                    output: [],
                    usage: null,
                };
                httpStream.write(formatResponseSseEvent('response.created', { type: 'response.created', response: partialResponse }));
                httpStream.write(formatResponseSseEvent('response.in_progress', { type: 'response.in_progress', response: partialResponse }));

                for await (const chunk of adapter.stream({
                    ...baseReq,
                    model: target.model,
                    endpoint_mode: target.endpoint_mode,
                })) {
                    if (ttfbMs === null) ttfbMs = elapsedMs(startMs);
                    usageAcc = mergeUsage(usageAcc, chunk);

                    if (chunk.type === 'message_start') {
                        msgId = generateMessageId();
                        const item = { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] };
                        httpStream.write(formatResponseSseEvent('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item }));
                        httpStream.write(formatResponseSseEvent('response.content_part.added', { type: 'response.content_part.added', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }));
                    }

                    if (chunk.type === 'delta') {
                        fullText += chunk.text;
                        httpStream.write(formatResponseSseEvent('response.output_text.delta', { type: 'response.output_text.delta', item_id: msgId, output_index: 0, content_index: 0, delta: chunk.text }));
                    }
                }

                // Emit closing SSE events
                inputTokens = usageAcc.input_tokens ?? 0;
                outputTokens = usageAcc.output_tokens ?? 0;
                const usage = {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                    output_tokens_details: { reasoning_tokens: 0 },
                };
                const completedItem = {
                    type: 'message',
                    id: msgId,
                    status: 'completed',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: fullText, annotations: [] }],
                };
                httpStream.write(formatResponseSseEvent('response.output_text.done', { type: 'response.output_text.done', item_id: msgId, output_index: 0, content_index: 0, text: fullText }));
                httpStream.write(formatResponseSseEvent('response.content_part.done', { type: 'response.content_part.done', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } }));
                httpStream.write(formatResponseSseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: completedItem }));

                const completedResponse = {
                    id: responseId,
                    object: 'response',
                    created_at: Math.floor(Date.now() / 1000),
                    status: 'completed',
                    model: validReq.model,
                    output: [completedItem],
                    usage,
                };
                httpStream.write(formatResponseSseEvent('response.completed', { type: 'response.completed', response: completedResponse }));
                httpStream.write('event: done\ndata: [DONE]\n\n');
            } else {
                const { result, provider, providerModel } = await routeWithFallback(
                    validReq.model,
                    async (prov, model, endpointMode) => {
                        const adapter = await getProviderAdapter(prov);
                        return adapter.invoke({ ...baseReq, model, endpoint_mode: endpointMode });
                    },
                    routes,
                );

                ttfbMs = elapsedMs(startMs);
                resolvedProvider = provider;
                resolvedModel = providerModel;
                inputTokens = result.input_tokens ?? 0;
                outputTokens = result.output_tokens ?? 0;

                httpStream.write(JSON.stringify(buildResponseBody(responseId, validReq.model, result.content, inputTokens, outputTokens)));
            }

            status = 'completed';
        } catch (err) {
            errorMsg = err instanceof Error ? err.message : String(err);
            const errBody = toErrorResponse(err);
            if (isStream) {
                httpStream.write(`event: error\ndata: ${JSON.stringify(errBody)}\n\n`);
                httpStream.write('event: done\ndata: [DONE]\n\n');
            } else {
                httpStream.write(JSON.stringify(errBody));
            }
        } finally {
            httpStream.end();

            const auditEvent: AuditEvent = {
                version: 1,
                type: 'llm.request.completed',
                requestId,
                tenantId,
                createdAt,
                modelAlias,
                provider: resolvedProvider,
                providerModel: resolvedModel,
                stream: validReq?.stream ?? false,
                status,
                latencyMs: elapsedMs(startMs),
                ttfbMs,
                inputTokens,
                outputTokens,
                error: errorMsg,
                userId: validReq?.user,
                metadata: validReq?.metadata,
            };

            publishAuditEvent(auditEvent).catch((e) => {
                console.error(
                    JSON.stringify({ message: 'Failed to publish audit event', requestId, error: String(e) }),
                );
            });
        }
    },
);
