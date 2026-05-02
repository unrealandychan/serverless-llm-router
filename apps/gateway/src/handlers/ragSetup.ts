// CDK Custom Resource handler — provisions the S3 Vectors bucket and index
// during `cdk deploy`. This file is bundled with @aws-sdk/client-s3vectors.
import {
    S3VectorsClient,
    CreateVectorBucketCommand,
    CreateIndexCommand,
} from '@aws-sdk/client-s3vectors';
import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';

const client = new S3VectorsClient({});

export const handler = async (
    event: CdkCustomResourceEvent,
): Promise<CdkCustomResourceResponse> => {
    const { VectorBucketName, IndexName, Dimension, DistanceMetric } =
        event.ResourceProperties as {
            VectorBucketName: string;
            IndexName: string;
            Dimension: string;
            DistanceMetric: 'cosine' | 'euclidean';
        };

    // On Delete: retain data (same policy as DynamoDB RETAIN tables).
    if (event.RequestType === 'Delete') {
        return {
            PhysicalResourceId:
                event.PhysicalResourceId ?? `${VectorBucketName}/${IndexName}`,
        };
    }

    // Create or Update ─────────────────────────────────────────────────────────

    // Create vector bucket (idempotent — ignore "already exists").
    try {
        await client.send(
            new CreateVectorBucketCommand({ vectorBucketName: VectorBucketName }),
        );
    } catch (err: unknown) {
        const name = (err as { name?: string }).name ?? '';
        if (name !== 'ConflictException' && name !== 'BucketAlreadyExists') {
            throw err;
        }
    }

    // Create vector index (idempotent — ignore "already exists").
    // Dimension 1536 matches text-embedding-3-small; cosine is recommended for
    // OpenAI embeddings. `source_text` is non-filterable to reduce index overhead.
    try {
        await client.send(
            new CreateIndexCommand({
                vectorBucketName: VectorBucketName,
                indexName: IndexName,
                dataType: 'float32',
                dimension: parseInt(Dimension, 10),
                distanceMetric: DistanceMetric,
                metadataConfiguration: {
                    nonFilterableMetadataKeys: ['source_text'],
                },
            }),
        );
    } catch (err: unknown) {
        const name = (err as { name?: string }).name ?? '';
        if (name !== 'ConflictException' && name !== 'IndexAlreadyExists') {
            throw err;
        }
    }

    return {
        PhysicalResourceId: `${VectorBucketName}/${IndexName}`,
        Data: { VectorBucketName, IndexName },
    };
};
