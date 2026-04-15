import { describe, it, expect, vi } from 'vitest';
import { resolveAlias, selectTarget, routeWithFallback } from '../core/router';
import { ModelNotFoundError } from '../util/errors';
import { RouteConfig } from '../config/modelMap';

const testConfig: Record<string, RouteConfig> = {
    fast: {
        targets: [
            { provider: 'openai', model: 'gpt-5.2-codex', weight: 60 },
            { provider: 'bedrock', model: 'amazon.nova-lite-v1:0', weight: 40 },
        ],
        fallbacks: ['gpt-5.2-codex'],
    },
    'gpt-5.2-codex': {
        targets: [{ provider: 'openai', model: 'gpt-5.2-codex', weight: 100 }],
    },
    'cycle-a': {
        targets: [{ provider: 'openai', model: 'gpt-5.2-codex', weight: 100 }],
        fallbacks: ['cycle-b'],
    },
    'cycle-b': {
        targets: [{ provider: 'openai', model: 'gpt-5.2-codex', weight: 100 }],
        fallbacks: ['cycle-a'],
    },
    // Key-pool alias: two OpenAI accounts, equal weight
    'multi-key': {
        targets: [
            { provider: 'openai', model: 'gpt-5.4', weight: 50, key_id: 'account1' },
            { provider: 'openai', model: 'gpt-5.4', weight: 50, key_id: 'account2' },
        ],
    },
    // Weighted key pool: primary account gets 70 % of traffic
    'weighted-keys': {
        targets: [
            { provider: 'openai', model: 'gpt-5.4', weight: 70, key_id: 'primary' },
            { provider: 'openai', model: 'gpt-5.4', weight: 30, key_id: 'secondary' },
        ],
    },
};

describe('resolveAlias', () => {
    it('returns route config for a known alias', () => {
        const route = resolveAlias('fast', testConfig);
        expect(route.targets).toHaveLength(2);
    });

    it('throws ModelNotFoundError for an unknown alias', () => {
        expect(() => resolveAlias('unknown', testConfig)).toThrow(ModelNotFoundError);
    });
});

describe('selectTarget', () => {
    it('always returns the only target in a single-entry list', () => {
        const targets = [{ provider: 'openai', model: 'gpt-5.4', weight: 100 }];
        expect(selectTarget(targets)).toEqual(targets[0]);
    });

    it('always returns one of the configured targets for a multi-target list', () => {
        const targets = [
            { provider: 'openai', model: 'gpt-5.2-codex', weight: 60 },
            { provider: 'bedrock', model: 'nova-lite', weight: 40 },
        ];
        for (let i = 0; i < 50; i++) {
            const t = selectTarget(targets);
            expect(['openai', 'bedrock']).toContain(t.provider);
        }
    });

    it('throws when targets list is empty', () => {
        expect(() => selectTarget([])).toThrow();
    });

    it('preserves key_id on the returned target', () => {
        const targets = [
            { provider: 'openai', model: 'gpt-5.4', weight: 100, key_id: 'account1' },
        ];
        expect(selectTarget(targets).key_id).toBe('account1');
    });

    it('returns targets with key_id from a multi-key pool', () => {
        const targets = [
            { provider: 'openai', model: 'gpt-5.4', weight: 50, key_id: 'account1' },
            { provider: 'openai', model: 'gpt-5.4', weight: 50, key_id: 'account2' },
        ];
        const selectedKeyIds = new Set<string | undefined>();
        for (let i = 0; i < 100; i++) {
            selectedKeyIds.add(selectTarget(targets).key_id);
        }
        // Both accounts should be selected over 100 iterations
        expect(selectedKeyIds).toContain('account1');
        expect(selectedKeyIds).toContain('account2');
    });
});

describe('routeWithFallback', () => {
    it('returns result directly from primary target on success', async () => {
        const invoke = vi.fn().mockResolvedValue('ok');
        const { result } = await routeWithFallback('fast', invoke, testConfig);
        expect(result).toBe('ok');
        expect(invoke).toHaveBeenCalledOnce();
    });

    it('falls back to next alias on retryable error', async () => {
        const retryable = Object.assign(new Error('503'), { status: 503 });
        const invoke = vi.fn().mockRejectedValueOnce(retryable).mockResolvedValue('fallback-ok');
        const { result } = await routeWithFallback('fast', invoke, testConfig);
        expect(result).toBe('fallback-ok');
        expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('does not fall back on non-retryable errors', async () => {
        const nonRetryable = Object.assign(new Error('401'), { status: 401 });
        const invoke = vi.fn().mockRejectedValue(nonRetryable);
        await expect(routeWithFallback('fast', invoke, testConfig)).rejects.toThrow('401');
        expect(invoke).toHaveBeenCalledOnce();
    });

    it('throws ModelNotFoundError for an unknown alias', async () => {
        const invoke = vi.fn();
        await expect(routeWithFallback('nonexistent', invoke, testConfig)).rejects.toThrow(ModelNotFoundError);
        expect(invoke).not.toHaveBeenCalled();
    });

    it('handles cyclic fallback references without infinite loops', async () => {
        const retryable = Object.assign(new Error('503'), { status: 503 });
        const invoke = vi.fn().mockRejectedValue(retryable);
        await expect(routeWithFallback('cycle-a', invoke, testConfig)).rejects.toThrow();
        expect(invoke.mock.calls.length).toBeLessThanOrEqual(4);
    });

    it('passes key_id from the selected target to the invoke callback', async () => {
        const capturedKeyIds: (string | undefined)[] = [];
        const invoke = vi.fn().mockImplementation((_prov, _model, _mode, keyId) => {
            capturedKeyIds.push(keyId);
            return Promise.resolve('ok');
        });
        await routeWithFallback('multi-key', invoke, testConfig);
        expect(invoke).toHaveBeenCalledOnce();
        expect(['account1', 'account2']).toContain(capturedKeyIds[0]);
    });

    it('includes keyId in the result from routeWithFallback', async () => {
        const invoke = vi.fn().mockResolvedValue('ok');
        const res = await routeWithFallback('multi-key', invoke, testConfig);
        expect(['account1', 'account2']).toContain(res.keyId);
    });

    it('passes undefined key_id when no key_id is configured on the target', async () => {
        const capturedKeyIds: (string | undefined)[] = [];
        const invoke = vi.fn().mockImplementation((_prov, _model, _mode, keyId) => {
            capturedKeyIds.push(keyId);
            return Promise.resolve('ok');
        });
        await routeWithFallback('gpt-5.2-codex', invoke, testConfig);
        expect(capturedKeyIds[0]).toBeUndefined();
    });
});
