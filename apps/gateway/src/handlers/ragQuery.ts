import type { APIGatewayProxyEvent } from 'aws-lambda';
import { z } from 'zod';
import { resolveAlias, selectTarget, routeWithFallback } from '../core/router';
import { formatSseChunk, mergeUsage, SSE_DONE } from '../core/stream';
import { getOpenAIAdapter, getProviderAdapter } from '../providers/registry';
import { checkAndIncrementRateLimit, RateLimitError } from '../middleware/rateLimiter';
import { loadRoutes } from '../config/routeLoader';
import { generateRequestId } from '../util/ids';
import { toErrorResponse, GatewayError } from '../util/errors';
import { CORS_HEADERS } from '../util/cors';
import { queryVectors, DEFAULT_INDEX_NAME, DEFAULT_EMBEDDING_MODEL, VectorHit } from '../rag/s3Vectors';

const RagQueryRequestSchema = z.object({
    /** User question or search query. */
    query: z.string().min(1),
    /** Model alias to use for generation (same as chat/completions). */
    model: z.string().min(1),
    /** Vector index to search. Defaults to the gateway-configured default index. */
    index_name: z.string().min(1).optional(),
    /** Number of context chunks to retrieve from the vector index. */
    top_k: z.number().int().min(1).max(20).default(5),
    /** Stream the LLM response as SSE. */
    stream: z.boolean().default(false),
    /** Additional instructions appended after the retrieved context in the system prompt. */
    system_prompt: z.string().optional(),
    /** Metadata filter applied to the vector similarity search. */
    metadata_filter: z.record(z.unknown()).optional(),
    /** Embedding model for the query vector. Should match the ingestion model. */
    embedding_model: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
});

/** Build a RAG system prompt that injects retrieved context chunks. */
function buildRagSystemPrompt(chunks: VectorHit[], systemPrompt?: string): string {
    const contextBlock = chunks
        .map((c, i) => `[${i + 1}] ${String(c.metadata?.source_text ?? c.key)}`)
        .join('\n\n');

    const parts = [
        'You are a helpful assistant. Answer the user\'s question using only the context provided below. If the answer cannot be determined from the context, say so.',
        '',
        'Context:',
        contextBlock,
    ];

    if (systemPrompt) {
        parts.push('', systemPrompt);
    }

    return parts.join('\n');
}

export const handler = awslambda.streamifyResponse(
    async (event: APIGatewayProxyEvent, responseStream: NodeJS.WritableStream): Promise<void> => {
        const requestId = generateRequestId();
        const tenantId =
            (event.requestContext?.authorizer?.['tenantId'] as string | undefined) ??
            process.env.DEFAULT_TENANT_ID ??
            't_default';

        let req: z.infer<typeof RagQueryRequestSchema> | undefined;
        let earlyError: GatewayError | undefined;
        let rateLimitError: RateLimitError | undefined;

        if (!event.body) {
            earlyError = new GatewayError(
                'Request body is required',
                'invalid_request_error',
                'missing_body',
                400,
            );
        } else {
            let raw: unknown;
            try {
                raw = JSON.parse(event.body);
            } catch {
                earlyError = new GatewayError(
                    'Invalid JSON body',
                    'invalid_request_error',
                    'parse_error',
                    400,
                );
            }
            if (!earlyError) {
                const result = RagQueryRequestSchema.safeParse(raw);
                if (!result.success) {
                    const msg = result.error.errors[0]?.message ?? 'Invalid request';
                    earlyError = new GatewayError(msg, 'invalid_request_error', 'validation_error', 400);
                } else {
                    req = result.data;
                }
            }
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
        const statusCode = earlyError ? earlyError.statusCode : rateLimitError ? 429 : 200;

        const httpStream = awslambda.HttpResponseStream.from(responseStream, {
            statusCode,
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
                    error: {
                        message: rateLimitError.message,
                        type: rateLimitError.type,
                        code: 'rate_limit_exceeded',
                    },
                }),
            );
            httpStream.end();
            return;
        }

        const validReq = req!;

        try {
            const indexName = validReq.index_name ?? DEFAULT_INDEX_NAME;
            const embeddingModel = validReq.embedding_model ?? DEFAULT_EMBEDDING_MODEL;

            // ── Step 1: Embed the user query ──────────────────────────────────────
            const embeddingAdapter = await getOpenAIAdapter();
            const embeddingResponse = await embeddingAdapter.embed({
                input: validReq.query,
                model: embeddingModel,
            });
            const queryVector = embeddingResponse.data[0]?.embedding ?? [];

            // ── Step 2: Retrieve context from S3 Vectors ──────────────────────────
            const chunks = await queryVectors(
                indexName,
                queryVector,
                validReq.top_k,
                validReq.metadata_filter,
            );

            // ── Step 3: Augment messages with retrieved context ───────────────────
            const systemContent = buildRagSystemPrompt(chunks, validReq.system_prompt);
            const messages = [
                { role: 'system' as const, content: systemContent },
                { role: 'user' as const, content: validReq.query },
            ];

            const baseReq = {
                messages,
                stream: validReq.stream,
                temperature: validReq.temperature,
                max_tokens: validReq.max_tokens,
            };

            const routes = await loadRoutes();

            // ── Step 4: Generate response via routed LLM ──────────────────────────
            if (validReq.stream) {
                const route = resolveAlias(validReq.model, routes);
                const target = selectTarget(route.targets);
                const adapter = await getProviderAdapter(target.provider, target.key_id);
                let usageAcc: { input_tokens?: number; output_tokens?: number } = {};

                for await (const chunk of adapter.stream({
                    ...baseReq,
                    model: target.model,
                    endpoint_mode: target.endpoint_mode,
                })) {
                    usageAcc = mergeUsage(usageAcc, chunk);
                    const sse = formatSseChunk(chunk);
                    if (sse) httpStream.write(sse);
                }

                httpStream.write(SSE_DONE);
            } else {
                const { result } = await routeWithFallback(
                    validReq.model,
                    async (prov, model, endpointMode, keyId) => {
                        const adapter = await getProviderAdapter(prov, keyId);
                        return adapter.invoke({ ...baseReq, model, endpoint_mode: endpointMode });
                    },
                    routes,
                );

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
                        prompt_tokens: result.input_tokens ?? 0,
                        completion_tokens: result.output_tokens ?? 0,
                        total_tokens: (result.input_tokens ?? 0) + (result.output_tokens ?? 0),
                    },
                    // Surface which chunks were used so the client can cite sources.
                    rag_context: chunks.map((c) => ({ key: c.key, distance: c.distance })),
                };

                httpStream.write(JSON.stringify(jsonResponse));
            }
        } catch (err) {
            const errBody = toErrorResponse(err);
            if (isStream) {
                httpStream.write(`event: error\ndata: ${JSON.stringify(errBody)}\n\n`);
                httpStream.write(SSE_DONE);
            } else {
                httpStream.write(JSON.stringify(errBody));
            }
        } finally {
            httpStream.end();
        }
    },
);
