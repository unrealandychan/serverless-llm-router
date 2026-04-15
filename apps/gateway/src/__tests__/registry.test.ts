import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We test the exported getProviderAdapter by mocking the AWS SDK and adapter
// constructors so no real HTTP calls are made.
vi.mock('@aws-sdk/client-secrets-manager', () => {
    const send = vi.fn();
    return {
        SecretsManagerClient: vi.fn().mockImplementation(() => ({ send })),
        GetSecretValueCommand: vi.fn().mockImplementation((args) => args),
        __send: send,
    };
});

vi.mock('google-auth-library', () => ({
    GoogleAuth: vi.fn().mockImplementation(() => ({
        getRequestHeaders: vi.fn().mockResolvedValue(new Map([['authorization', 'Bearer test']])),
    })),
}));

vi.mock('../providers/openai', () => ({
    OpenAIAdapter: vi.fn().mockImplementation((apiKey, opts) => ({ type: 'openai', apiKey, opts })),
}));

vi.mock('../providers/anthropic', () => ({
    AnthropicAdapter: vi.fn().mockImplementation((apiKey) => ({ type: 'anthropic', apiKey })),
}));

vi.mock('../providers/bedrock', () => ({
    BedrockAdapter: vi.fn().mockImplementation(() => ({ type: 'bedrock' })),
}));

import * as smMod from '@aws-sdk/client-secrets-manager';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSend = (smMod as any).__send as ReturnType<typeof vi.fn>;

// Re-import after mocks are in place so the module picks them up.
// We need to import the module dynamically to reset the adapter/secret caches.
async function freshRegistry() {
    // Force a fresh module evaluation on each test by using a cache-busting import
    const mod = await import('../providers/registry?t=' + Date.now());
    return mod;
}

describe('registry — key_id resolution', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        mockSend.mockReset();
        vi.resetModules(); // clear module cache so adapter/secret caches are fresh
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('uses OPENAI_SECRET_ARN when no key_id is provided', async () => {
        process.env.OPENAI_SECRET_ARN = 'arn:default';
        mockSend.mockResolvedValue({ SecretString: 'sk-default' });

        const { getProviderAdapter } = await freshRegistry();
        const adapter = await getProviderAdapter('openai');

        expect(mockSend).toHaveBeenCalledOnce();
        // The ARN passed to GetSecretValueCommand should be the default
        expect(mockSend.mock.calls[0][0]).toMatchObject({ SecretId: 'arn:default' });
        expect((adapter as { apiKey: string }).apiKey).toBe('sk-default');
    });

    it('uses OPENAI_SECRET_ARN_<KEY_ID> when key_id is provided and the env var exists', async () => {
        process.env.OPENAI_SECRET_ARN = 'arn:default';
        process.env.OPENAI_SECRET_ARN_ACCOUNT1 = 'arn:account1';
        mockSend.mockResolvedValue({ SecretString: 'sk-account1' });

        const { getProviderAdapter } = await freshRegistry();
        const adapter = await getProviderAdapter('openai', 'account1');

        expect(mockSend).toHaveBeenCalledOnce();
        expect(mockSend.mock.calls[0][0]).toMatchObject({ SecretId: 'arn:account1' });
        expect((adapter as { apiKey: string }).apiKey).toBe('sk-account1');
    });

    it('falls back to OPENAI_SECRET_ARN when key-specific env var is absent', async () => {
        process.env.OPENAI_SECRET_ARN = 'arn:default';
        // OPENAI_SECRET_ARN_MISSING is intentionally not set
        mockSend.mockResolvedValue({ SecretString: 'sk-fallback' });

        const { getProviderAdapter } = await freshRegistry();
        const adapter = await getProviderAdapter('openai', 'missing');

        expect(mockSend).toHaveBeenCalledOnce();
        expect(mockSend.mock.calls[0][0]).toMatchObject({ SecretId: 'arn:default' });
        expect((adapter as { apiKey: string }).apiKey).toBe('sk-fallback');
    });

    it('normalizes key_id with non-alphanumeric characters', async () => {
        process.env['OPENAI_SECRET_ARN_ACCOUNT_1'] = 'arn:account-1';
        mockSend.mockResolvedValue({ SecretString: 'sk-account-1' });

        const { getProviderAdapter } = await freshRegistry();
        // key_id "account-1" should be normalized to ACCOUNT_1
        const adapter = await getProviderAdapter('openai', 'account-1');

        expect(mockSend.mock.calls[0][0]).toMatchObject({ SecretId: 'arn:account-1' });
        expect((adapter as { apiKey: string }).apiKey).toBe('sk-account-1');
    });

    it('caches adapters separately for each (provider, key_id) combination', async () => {
        process.env.OPENAI_SECRET_ARN_KEY1 = 'arn:key1';
        process.env.OPENAI_SECRET_ARN_KEY2 = 'arn:key2';
        mockSend
            .mockResolvedValueOnce({ SecretString: 'sk-key1' })
            .mockResolvedValueOnce({ SecretString: 'sk-key2' });

        const { getProviderAdapter } = await freshRegistry();
        const adapter1a = await getProviderAdapter('openai', 'key1');
        const adapter1b = await getProviderAdapter('openai', 'key1'); // should be cached
        const adapter2 = await getProviderAdapter('openai', 'key2');

        // Secrets Manager should be called once per unique (provider, key_id) pair
        expect(mockSend).toHaveBeenCalledTimes(2);
        // The same key_id returns the same adapter instance
        expect(adapter1a).toBe(adapter1b);
        // Different key_ids return different adapter instances
        expect(adapter1a).not.toBe(adapter2);
    });

    it('throws a descriptive error when neither key-specific nor default ARN is set', async () => {
        delete process.env.OPENAI_SECRET_ARN;
        delete process.env.OPENAI_SECRET_ARN_NOPE;

        const { getProviderAdapter } = await freshRegistry();
        await expect(getProviderAdapter('openai', 'nope')).rejects.toThrow(
            /OPENAI_SECRET_ARN_NOPE \(or OPENAI_SECRET_ARN\)/,
        );
    });

    it('uses ANTHROPIC_SECRET_ARN_<KEY_ID> for anthropic provider', async () => {
        process.env.ANTHROPIC_SECRET_ARN_CORP = 'arn:anthropic-corp';
        mockSend.mockResolvedValue({ SecretString: 'ant-corp-key' });

        const { getProviderAdapter } = await freshRegistry();
        const adapter = await getProviderAdapter('anthropic', 'corp');

        expect(mockSend.mock.calls[0][0]).toMatchObject({ SecretId: 'arn:anthropic-corp' });
        expect((adapter as { apiKey: string }).apiKey).toBe('ant-corp-key');
    });
});
