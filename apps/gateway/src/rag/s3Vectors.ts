import {
    S3VectorsClient,
    PutVectorsCommand,
    QueryVectorsCommand,
    DeleteVectorsCommand,
} from '@aws-sdk/client-s3vectors';

// These env vars are set by the CDK stack at deploy time.
const VECTOR_BUCKET_NAME = process.env.RAG_VECTOR_BUCKET_NAME!;

export const DEFAULT_INDEX_NAME = process.env.RAG_DEFAULT_INDEX_NAME ?? 'rag-default';
export const DEFAULT_EMBEDDING_MODEL = process.env.RAG_EMBEDDING_MODEL ?? 'text-embedding-3-small';

// Singleton client — reused across warm Lambda invocations.
let _client: S3VectorsClient | undefined;
function getClient(): S3VectorsClient {
    if (!_client) _client = new S3VectorsClient({});
    return _client;
}

export interface VectorRecord {
    key: string;
    data: number[];
    /** All metadata fields are filterable except `source_text`, which is non-filterable. */
    metadata?: Record<string, string | number | boolean>;
}

export interface VectorHit {
    key: string;
    distance: number;
    metadata?: Record<string, unknown>;
}

/**
 * Write a batch of vectors (with metadata) into the given index.
 * Upserts by key — re-ingesting the same key overwrites the previous vector.
 */
export async function putVectors(indexName: string, vectors: VectorRecord[]): Promise<void> {
    await getClient().send(
        new PutVectorsCommand({
            vectorBucketName: VECTOR_BUCKET_NAME,
            indexName,
            vectors: vectors.map((v) => ({
                key: v.key,
                data: { float32: v.data },
                metadata: v.metadata,
            })),
        }),
    );
}

/**
 * Retrieve the top-K nearest neighbors for a query vector.
 * Optionally filter by metadata key-value conditions.
 */
export async function queryVectors(
    indexName: string,
    queryVector: number[],
    topK: number,
    filter?: Record<string, unknown>,
): Promise<VectorHit[]> {
    const response = await getClient().send(
        new QueryVectorsCommand({
            vectorBucketName: VECTOR_BUCKET_NAME,
            indexName,
            queryVector: { float32: queryVector },
            topK,
            returnDistance: true,
            returnMetadata: true,
            ...(filter ? { filter } : {}),
        }),
    );

    return (response.vectors ?? []).map((v) => ({
        key: v.key ?? '',
        distance: v.distance ?? 0,
        metadata: v.metadata as Record<string, unknown> | undefined,
    }));
}

/**
 * Delete vectors by key from the given index.
 */
export async function deleteVectors(indexName: string, keys: string[]): Promise<void> {
    await getClient().send(
        new DeleteVectorsCommand({
            vectorBucketName: VECTOR_BUCKET_NAME,
            indexName,
            keys,
        }),
    );
}
