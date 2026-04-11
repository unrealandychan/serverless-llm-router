import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({});

type ApiKeyRecord = {
    tenantId: string;
    label?: string;
};

// In-memory cache: survives Lambda warm invocations.
// The Authorizer Lambda is also cached at API Gateway level (5 min TTL),
// but this cache avoids Secrets Manager calls for the Lambda's own warm lifetime.
let secretCache: Record<string, ApiKeyRecord> | undefined;
let secretCachedAt = 0;
/** Re-fetch the secret after 5 minutes of warm-Lambda uptime (belt-and-suspenders). */
const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;

async function loadKeys(): Promise<Record<string, ApiKeyRecord>> {
    if (secretCache && Date.now() - secretCachedAt < SECRET_CACHE_TTL_MS) {
        return secretCache;
    }

    const secretArn = process.env.API_KEYS_SECRET_ARN;
    if (!secretArn) throw new Error('API_KEYS_SECRET_ARN is not set');

    const response = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!response.SecretString) throw new Error('API keys secret has no string value');

    const parsed = JSON.parse(response.SecretString) as Record<string, ApiKeyRecord>;
    secretCache = parsed;
    secretCachedAt = Date.now();
    return parsed;
}

/**
 * Validate a raw bearer token (the key after stripping "Bearer ").
 * Returns the key record if valid, or null if not found.
 */
export async function validateKey(
    token: string,
): Promise<ApiKeyRecord | null> {
    const keys = await loadKeys();
    return keys[token] ?? null;
}
