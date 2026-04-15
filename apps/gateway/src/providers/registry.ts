import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { GoogleAuth } from 'google-auth-library';
import { ProviderAdapter } from './types';
import { OpenAIAdapter } from './openai';
import { BedrockAdapter } from './bedrock';
import { AnthropicAdapter } from './anthropic';
import { parseKeyPool, selectKey } from './keyPool';

const sm = new SecretsManagerClient({});

// Cache of parsed key pools keyed by secret ARN.
const keyPoolCache = new Map<string, string[]>();

async function fetchKeyPool(secretArn: string): Promise<string[]> {
    const cached = keyPoolCache.get(secretArn);
    if (cached) return cached;

    const response = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!response.SecretString) throw new Error(`Secret ${secretArn} has no string value`);

    const pool = parseKeyPool(response.SecretString);
    keyPoolCache.set(secretArn, pool);
    return pool;
}

// Adapter cache for single-key providers (retains existing warm-Lambda behaviour).
const adapterCache = new Map<string, ProviderAdapter>();

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
 * Return a ProviderAdapter for the given provider name.
 *
 * When the provider's secret contains a single API key the adapter is cached
 * across warm Lambda invocations (original behaviour).  When the secret holds a
 * JSON array of keys a fresh adapter is created for every call so requests are
 * spread across the key pool using round-robin selection.
 *
 * Key pool secret format (AWS Secrets Manager):
 *   Single key : plain string, e.g.  `sk-abc123`
 *   Key pool   : JSON array,  e.g.  `["sk-key1","sk-key2","sk-key3"]`
 */
export async function getProviderAdapter(provider: string): Promise<ProviderAdapter> {
    let adapter: ProviderAdapter;

    switch (provider) {
        case 'openai': {
            const secretArn = process.env.OPENAI_SECRET_ARN;
            if (!secretArn) throw new Error('OPENAI_SECRET_ARN environment variable is not set');
            const keys = await fetchKeyPool(secretArn);
            if (keys.length === 1) {
                const cached = adapterCache.get(provider);
                if (cached) return cached;
                adapter = new OpenAIAdapter(keys[0]);
                adapterCache.set(provider, adapter);
            } else {
                adapter = new OpenAIAdapter(selectKey(provider, keys));
            }
            break;
        }
        case 'bedrock': {
            // Bedrock uses the Lambda execution role — no API key needed.
            const cached = adapterCache.get(provider);
            if (cached) return cached;
            adapter = new BedrockAdapter();
            adapterCache.set(provider, adapter);
            break;
        }
        case 'anthropic': {
            const secretArn = process.env.ANTHROPIC_SECRET_ARN;
            if (!secretArn) throw new Error('ANTHROPIC_SECRET_ARN environment variable is not set');
            const keys = await fetchKeyPool(secretArn);
            if (keys.length === 1) {
                const cached = adapterCache.get(provider);
                if (cached) return cached;
                adapter = new AnthropicAdapter(keys[0]);
                adapterCache.set(provider, adapter);
            } else {
                adapter = new AnthropicAdapter(selectKey(provider, keys));
            }
            break;
        }
        default: {
            // Generic OpenAI-compatible providers:
            // provider name format: "openai_compatible:<profile>"
            // env vars:
            //   OPENAI_COMPAT_<PROFILE>_BASE_URL
            //   OPENAI_COMPAT_<PROFILE>_SECRET_ARN
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
                const secretArn = process.env[secretArnEnv];
                const credentialsSecretArn = process.env[credsSecretArnEnv];

                if (!baseURL) throw new Error(`${baseUrlEnv} environment variable is not set`);

                if (normalizedProfile === 'VERTEX') {
                    // Vertex uses OAuth credentials JSON, not a plain API key.
                    // Key pools are not applicable for Vertex — always cache the adapter.
                    const cached = adapterCache.get(provider);
                    if (cached) return cached;

                    const vertexSecretArn = credentialsSecretArn ?? secretArn;
                    if (!vertexSecretArn) {
                        throw new Error(
                            `${credsSecretArnEnv} (or legacy ${secretArnEnv}) environment variable is not set`,
                        );
                    }

                    // Vertex credentials are stored as a single JSON object (service account key),
                    // not as a key pool.  parseKeyPool always returns at least one element.
                    const credentialsJson = (await fetchKeyPool(vertexSecretArn))[0];
                    const authHeaderProvider = createGoogleAuthHeaderProvider(credentialsJson);
                    adapter = new OpenAIAdapter('vertex-oauth', {
                        baseURL,
                        name: provider,
                        authHeaderProvider,
                    });
                    adapterCache.set(provider, adapter);
                    break;
                }

                if (!secretArn) throw new Error(`${secretArnEnv} environment variable is not set`);

                const keys = await fetchKeyPool(secretArn);
                if (keys.length === 1) {
                    const cached = adapterCache.get(provider);
                    if (cached) return cached;
                    adapter = new OpenAIAdapter(keys[0], { baseURL, name: provider });
                    adapterCache.set(provider, adapter);
                } else {
                    adapter = new OpenAIAdapter(selectKey(provider, keys), { baseURL, name: provider });
                }
                break;
            }

            throw new Error(`No adapter registered for provider: "${provider}"`);
        }
    }

    return adapter;
}

/**
 * Convenience helper used by media endpoints (embeddings, images, audio).
 * Always returns the OpenAI adapter which implements all media interfaces.
 */
export async function getOpenAIAdapter(): Promise<OpenAIAdapter> {
    return (await getProviderAdapter('openai')) as OpenAIAdapter;
}
