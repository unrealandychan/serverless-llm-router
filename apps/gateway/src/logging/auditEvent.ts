export type AuditStatus = 'completed' | 'failed';

/** Audit event published to SQS after every request. Keep it compact — DynamoDB writes happen downstream. */
export type AuditEvent = {
    version: 1;
    type: 'llm.request.completed';
    requestId: string;
    tenantId: string;
    createdAt: string;
    modelAlias: string;
    provider: string;
    providerModel: string;
    stream: boolean;
    status: AuditStatus;
    latencyMs: number;
    ttfbMs: number | null;
    inputTokens: number;
    outputTokens: number;
    error: string | null;
    userId?: string;
    metadata?: Record<string, string>;
};
