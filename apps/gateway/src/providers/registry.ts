import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { GoogleAuth } from 'google-auth-library';
import { ProviderAdapter } from './types';
import { OpenAIAdapter } from './openai';
import { BedrockAdapter } from './bedrock';
import { AnthropicAdapter } from './anthropic';

const sm = new SecretsManagerClient({});
const secretCache = new Map<string, string>();

async function fetchSecret(secretArn: string): Promise<string> {
    const cached = secretCache.get(secretArn);
    if (cached) return cached;

    const response = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!response.SecretString) throw new Error(`Secret ${secretArn} has no string value`);

    secretCache.set(secretArn, response.SecretString);
    return response.SecretString;
}

const adapterCache = new Map<string, ProviderAdapter>();

/**
 * Normalize a key_id string to an uppercase env-var-safe suffix.
 * e.g. "account-1" → "ACCOUNT_1"
 */
function normalizeKeyId(keyId: string): string {
    return keyId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * Resolve the Secrets Manager ARN for a provider's API key.
 * When keyId is provided, looks up `<BASE_ENV>_<KEY_ID>` first (e.g. OPENAI_SECRET_ARN_ACCOUNT1).
 * Falls back to `<BASE_ENV>` for the default single-key case.
 */
function resolveSecretArn(baseEnv: string, keyId?: string): string | undefined {
    if (keyId) {
        const keySpecificEnv = `${baseEnv}_${normalizeKeyId(keyId)}`;
        const keySpecificArn = process.env[keySpecificEnv];
        if (keySpecificArn) return keySpecificArn;
        // Fall through to base env if key-specific env is not set
    }
    return process.env[baseEnv];
}

function createGoogleAuthHeaderProvider(credentialsJson: string): () => Promise<string> {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(credentialsJson) as Record<string, unknown>;
    } catch {
        throw new Error('Vertex credentials secret must be valid JSON credentials');
    }

    const auth = new GoogleAuth({
        credentials: parsed,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    return async () => {
        const headers = await auth.getRequestHeaders();
        const authHeader = headers.get('authorization') ?? headers.get('Authorization');
        if (!authHeader) throw new Error('Failed to obtain Google OAuth Authorization header');
        return authHeader;
    };
}

/**
 * Return a lazily-initialized, cached ProviderAdapter for the given provider name.
 * API keys are fetched once from Secrets Manager and cached in memory for the Lambda lifetime.
 *
 * When keyId is provided the registry looks up `<PROVIDER>_SECRET_ARN_<KEY_ID>` (e.g.
 * OPENAI_SECRET_ARN_ACCOUNT1) and caches the resulting adapter separately, enabling multiple
 * API keys per provider for load-balancing across accounts.
 */
export async function getProviderAdapter(provider: string, keyId?: string): Promise<ProviderAdapter> {
    const cacheKey = keyId ? `${provider}:${keyId}` : provider;
    const existing = adapterCache.get(cacheKey);
    if (existing) return existing;

    let adapter: ProviderAdapter;

    switch (provider) {
        case 'openai': {
            const secretArn = resolveSecretArn('OPENAI_SECRET_ARN', keyId);
            if (!secretArn) {
                const envName = keyId ? `OPENAI_SECRET_ARN_${normalizeKeyId(keyId)} (or OPENAI_SECRET_ARN)` : 'OPENAI_SECRET_ARN';
                throw new Error(`${envName} environment variable is not set`);
            }
            const apiKey = await fetchSecret(secretArn);
            adapter = new OpenAIAdapter(apiKey);
            break;
        }
        case 'bedrock': {
            // Bedrock uses the Lambda execution role — no API key needed
            adapter = new BedrockAdapter();
            break;
        }
        case 'anthropic': {
            const secretArn = resolveSecretArn('ANTHROPIC_SECRET_ARN', keyId);
            if (!secretArn) {
                const envName = keyId ? `ANTHROPIC_SECRET_ARN_${normalizeKeyId(keyId)} (or ANTHROPIC_SECRET_ARN)` : 'ANTHROPIC_SECRET_ARN';
                throw new Error(`${envName} environment variable is not set`);
            }
            const apiKey = await fetchSecret(secretArn);
            adapter = new AnthropicAdapter(apiKey);
            break;
        }
        default: {
            // Generic OpenAI-compatible providers:
            // provider name format: "openai_compatible:<profile>"
            // env vars:
            //   OPENAI_COMPAT_<PROFILE>_BASE_URL
            //   OPENAI_COMPAT_<PROFILE>_SECRET_ARN
            //   OPENAI_COMPAT_<PROFILE>_SECRET_ARN_<KEY_ID>  (multi-key pool)
            // Vertex profile also supports:
            //   OPENAI_COMPAT_VERTEX_CREDENTIALS_SECRET_ARN (preferred)
            if (provider.startsWith('openai_compatible:')) {
                const profile = provider.slice('openai_compatible:'.length).trim();
                if (!profile) {
                    throw new Error('OpenAI-compatible provider profile is missing');
                }

                const normalizedProfile = profile
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/g, '_');

                const baseUrlEnv = `OPENAI_COMPAT_${normalizedProfile}_BASE_URL`;
                const secretArnEnv = `OPENAI_COMPAT_${normalizedProfile}_SECRET_ARN`;
                const credsSecretArnEnv = `OPENAI_COMPAT_${normalizedProfile}_CREDENTIALS_SECRET_ARN`;

                const baseURL = process.env[baseUrlEnv];
                const secretArn = resolveSecretArn(secretArnEnv, keyId);
                const credentialsSecretArn = process.env[credsSecretArnEnv];

                if (!baseURL) throw new Error(`${baseUrlEnv} environment variable is not set`);
                if (normalizedProfile === 'VERTEX') {
                    const vertexSecretArn = credentialsSecretArn ?? secretArn;
                    if (!vertexSecretArn) {
                        throw new Error(
                            `${credsSecretArnEnv} (or legacy ${secretArnEnv}) environment variable is not set`,
                        );
                    }

                    const credentialsJson = await fetchSecret(vertexSecretArn);
                    const authHeaderProvider = createGoogleAuthHeaderProvider(credentialsJson);
                    adapter = new OpenAIAdapter('vertex-oauth', {
                        baseURL,
                        name: provider,
                        authHeaderProvider,
                    });
                    break;
                }

                if (!secretArn) {
                    const envName = keyId ? `${secretArnEnv}_${normalizeKeyId(keyId)} (or ${secretArnEnv})` : secretArnEnv;
                    throw new Error(`${envName} environment variable is not set`);
                }

                const apiKey = await fetchSecret(secretArn);
                adapter = new OpenAIAdapter(apiKey, { baseURL, name: provider });
                break;
            }

            throw new Error(`No adapter registered for provider: "${provider}"`);
        }
    }

    adapterCache.set(cacheKey, adapter);
    return adapter;
}

/**
 * Convenience helper used by media endpoints (embeddings, images, audio).
 * Always returns the OpenAI adapter which implements all media interfaces.
 */
export async function getOpenAIAdapter(): Promise<OpenAIAdapter> {
    return (await getProviderAdapter('openai')) as OpenAIAdapter;
}
