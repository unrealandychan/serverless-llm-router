import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ChatRequest, ChatRequestSchema } from '../core/schemas';
import { resolveAlias, selectTarget, routeWithFallback } from '../core/router';
import { formatSseChunk, mergeUsage, SSE_DONE } from '../core/stream';
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

function parseRequest(event: APIGatewayProxyEvent): ChatRequest {
    if (!event.body) {
        throw new GatewayError('Request body is required', 'invalid_request_error', 'missing_body', 400);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(event.body);
    } catch {
        throw new GatewayError('Invalid JSON body', 'invalid_request_error', 'parse_error', 400);
    }
    const result = ChatRequestSchema.safeParse(raw);
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
        // tenantId is injected by the Lambda Authorizer via requestContext.authorizer.
        // Falls back to DEFAULT_TENANT_ID for local/dev invocations without an authorizer.
        const tenantId =
            (event.requestContext?.authorizer?.['tenantId'] as string | undefined) ??
            process.env.DEFAULT_TENANT_ID ??
            't_default';

        // Parse the request body before committing to response headers.
        // We need isStream to set the correct Content-Type.
        let req: ChatRequest | undefined;
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

        // Rate limit check runs after parsing (so we have isStream for Content-Type)
        // but only if no earlier parse error.
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

        // req is guaranteed non-null beyond this point
        const validReq = req!;
        let modelAlias = validReq.model;
        let resolvedProvider = 'unknown';
        let resolvedModel = 'unknown';
        let status: 'completed' | 'failed' = 'failed';
        let inputTokens = 0;
        let outputTokens = 0;
        let ttfbMs: number | null = null;
        let errorMsg: string | null = null;

        try {
            const baseReq: Omit<NormalizedRequest, 'model'> = {
                messages: validReq.messages,
                stream: validReq.stream,
                temperature: validReq.temperature,
                max_tokens: validReq.max_tokens,
            };

            const routes = await loadRoutes();

            if (validReq.stream) {
                // Streaming path: single-target selection with dynamic route config.
                const route = resolveAlias(validReq.model, routes);
                const target = selectTarget(route.targets);
                resolvedProvider = target.provider;
                resolvedModel = target.model;

                const adapter = await getProviderAdapter(target.provider);
                let usageAcc: { input_tokens?: number; output_tokens?: number } = {};

                for await (const chunk of adapter.stream({ ...baseReq, model: target.model })) {
                    if (ttfbMs === null) ttfbMs = elapsedMs(startMs);
                    usageAcc = mergeUsage(usageAcc, chunk);
                    const sse = formatSseChunk(chunk);
                    if (sse) httpStream.write(sse);
                }

                httpStream.write(SSE_DONE);
                inputTokens = usageAcc.input_tokens ?? 0;
                outputTokens = usageAcc.output_tokens ?? 0;
            } else {
                // Non-streaming path: use routeWithFallback for resilience.
                const { result, provider, providerModel } = await routeWithFallback(
                    validReq.model,
                    async (prov, model) => {
                        const adapter = await getProviderAdapter(prov);
                        return adapter.invoke({ ...baseReq, model });
                    },
                    routes,
                );

                ttfbMs = elapsedMs(startMs);
                resolvedProvider = provider;
                resolvedModel = providerModel;
                inputTokens = result.input_tokens ?? 0;
                outputTokens = result.output_tokens ?? 0;

                const jsonResponse = {
                    id: result.id,
                    object: 'chat.completion',
                    model: validReq.model,
                    choices: [
                        {
                            index: 0,
                            message: { role: 'assistant', content: result.content },
                            finish_reason: result.finish_reason ?? 'stop',
                        },
                    ],
                    usage: {
                        prompt_tokens: inputTokens,
                        completion_tokens: outputTokens,
                        total_tokens: inputTokens + outputTokens,
                    },
                };

                httpStream.write(JSON.stringify(jsonResponse));
            }

            status = 'completed';
        } catch (err) {
            errorMsg = err instanceof Error ? err.message : String(err);
            const errBody = toErrorResponse(err);
            if (isStream) {
                httpStream.write(`event: error\ndata: ${JSON.stringify(errBody)}\n\n`);
                httpStream.write(SSE_DONE);
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
                stream: validReq.stream,
                status,
                latencyMs: elapsedMs(startMs),
                ttfbMs,
                inputTokens,
                outputTokens,
                error: errorMsg,
                userId: validReq.user,
                metadata: validReq.metadata,
            };

            publishAuditEvent(auditEvent).catch((e) => {
                console.error(
                    JSON.stringify({ message: 'Failed to publish audit event', requestId, error: String(e) }),
                );
            });
        }
    },
);
