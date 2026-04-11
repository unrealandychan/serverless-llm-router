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
});
