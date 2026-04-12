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
 */
export async function getProviderAdapter(provider: string): Promise<ProviderAdapter> {
    const existing = adapterCache.get(provider);
    if (existing) return existing;

    let adapter: ProviderAdapter;

    switch (provider) {
        case 'openai': {
            const secretArn = process.env.OPENAI_SECRET_ARN;
            if (!secretArn) throw new Error('OPENAI_SECRET_ARN environment variable is not set');
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
            const secretArn = process.env.ANTHROPIC_SECRET_ARN;
            if (!secretArn) throw new Error('ANTHROPIC_SECRET_ARN environment variable is not set');
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

                if (!secretArn) throw new Error(`${secretArnEnv} environment variable is not set`);

                const apiKey = await fetchSecret(secretArn);
                adapter = new OpenAIAdapter(apiKey, { baseURL, name: provider });
                break;
            }

            throw new Error(`No adapter registered for provider: "${provider}"`);
        }
    }

    adapterCache.set(provider, adapter);
    return adapter;
}

/**
 * Convenience helper used by media endpoints (embeddings, images, audio).
 * Always returns the OpenAI adapter which implements all media interfaces.
 */
export async function getOpenAIAdapter(): Promise<OpenAIAdapter> {
    return (await getProviderAdapter('openai')) as OpenAIAdapter;
}
