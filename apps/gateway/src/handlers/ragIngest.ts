import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { z } from 'zod';
import { getOpenAIAdapter } from '../providers/registry';
import { checkAndIncrementRateLimit, RateLimitError } from '../middleware/rateLimiter';
import { CORS_HEADERS } from '../util/cors';
import { putVectors, DEFAULT_INDEX_NAME, DEFAULT_EMBEDDING_MODEL } from '../rag/s3Vectors';

const DocumentSchema = z.object({
    /** Unique document key — used for upsert and delete operations. */
    key: z.string().min(1),
    /** Source text to embed and store. */
    text: z.string().min(1),
    /** Filterable metadata attached alongside the vector. */
    metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const IngestRequestSchema = z.object({
    documents: z.array(DocumentSchema).min(1).max(100),
    /** Target vector index. Defaults to the gateway-configured default index. */
    index_name: z.string().min(1).optional(),
    /** Embedding model to use. Defaults to `text-embedding-3-small` (1536 dims). */
    embedding_model: z.string().optional(),
});

function errResp(
    statusCode: number,
    message: string,
    type = 'invalid_request_error',
): APIGatewayProxyResult {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        body: JSON.stringify({ error: { message, type } }),
    };
}

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const tenantId =
        (event.requestContext?.authorizer?.['tenantId'] as string | undefined) ??
        process.env.DEFAULT_TENANT_ID ??
        't_default';

    if (!event.body) return errResp(400, 'Request body is required');

    let raw: unknown;
    try {
        raw = JSON.parse(event.body);
    } catch {
        return errResp(400, 'Invalid JSON body', 'parse_error');
    }

    const parsed = IngestRequestSchema.safeParse(raw);
    if (!parsed.success) {
        return errResp(400, parsed.error.errors[0]?.message ?? 'Invalid request');
    }

    try {
        await checkAndIncrementRateLimit(tenantId);
    } catch (err) {
        if (err instanceof RateLimitError) return errResp(429, err.message, err.type);
        throw err;
    }

    const { documents, index_name, embedding_model } = parsed.data;
    const indexName = index_name ?? DEFAULT_INDEX_NAME;
    const model = embedding_model ?? DEFAULT_EMBEDDING_MODEL;

    try {
        const adapter = await getOpenAIAdapter();
        const texts = documents.map((d) => d.text);

        // Batch-embed all texts in a single API call for efficiency.
        const embeddingResponse = await adapter.embed({ input: texts, model });
        const embeddings = embeddingResponse.data
            .sort((a, b) => a.index - b.index)
            .map((d) => d.embedding);

        const vectors = documents.map((doc, i) => ({
            key: doc.key,
            data: embeddings[i]!,
            // source_text is stored as non-filterable metadata for retrieval.
            metadata: { source_text: doc.text, ...(doc.metadata ?? {}) },
        }));

        await putVectors(indexName, vectors);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            body: JSON.stringify({ ingested: documents.length, index_name: indexName }),
        };
    } catch (err) {
        console.error(JSON.stringify({ message: 'RAG ingest error', error: String(err) }));
        return errResp(500, 'Internal server error', 'server_error');
    }
};
