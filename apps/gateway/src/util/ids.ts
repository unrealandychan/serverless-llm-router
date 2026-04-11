import { randomUUID } from 'crypto';

/** Generates a gateway-scoped request ID like `req_01j9abc12345678901`. */
export function generateRequestId(): string {
    return `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** Generates a short trace ID for log correlation. */
export function generateTraceId(): string {
    return `tr_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
