/** Base class for all gateway-originated errors. */
export class GatewayError extends Error {
    constructor(
        message: string,
        public readonly type: string,
        public readonly code: string,
        public readonly statusCode: number,
    ) {
        super(message);
        this.name = 'GatewayError';
    }
}

export class ModelNotFoundError extends GatewayError {
    constructor(alias: string) {
        super(
            `Model alias not configured: ${alias}`,
            'invalid_request_error',
            'model_not_found',
            400,
        );
    }
}

export class AuthenticationError extends GatewayError {
    constructor() {
        super('Invalid or missing API key', 'authentication_error', 'invalid_api_key', 401);
    }
}

export class ValidationError extends GatewayError {
    constructor(message: string) {
        super(message, 'invalid_request_error', 'validation_error', 400);
    }
}

/** Returns true for errors that are safe to retry / fall back on. */
export function isRetryableError(err: unknown): boolean {
    const status =
        (err as Record<string, unknown>)?.status ??
        (err as Record<string, unknown>)?.statusCode;

    if (typeof status === 'number') {
        return [408, 429, 500, 502, 503, 504].includes(status);
    }

    const code = (err as Record<string, unknown>)?.code;
    if (typeof code === 'string') {
        return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(code);
    }

    return false;
}

/** Serializes any thrown value into an OpenAI-compatible error envelope. */
export function toErrorResponse(err: unknown): {
    error: { message: string; type: string; code: string };
} {
    if (err instanceof GatewayError) {
        return { error: { message: err.message, type: err.type, code: err.code } };
    }
    if (err instanceof Error) {
        return { error: { message: err.message, type: 'server_error', code: 'internal_error' } };
    }
    return {
        error: { message: 'An unexpected error occurred', type: 'server_error', code: 'internal_error' },
    };
}
