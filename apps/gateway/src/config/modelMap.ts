export type ProviderTarget = {
    provider: string;
    /** Provider-native model name, e.g. "gpt-5.2-codex" or "amazon.nova-lite-v1:0". */
    model: string;
    /** Relative weight for random selection. Must be a positive integer. */
    weight: number;
    /**
     * Optional endpoint override used by OpenAI-compatible adapters.
     * - chat: force /v1/chat/completions
     * - completions: force /v1/completions
     * - auto: try chat first, then fallback to completions on compatibility errors
     */
    endpoint_mode?: 'chat' | 'completions' | 'auto';
};

export type RouteConfig = {
    targets: ProviderTarget[];
    /** Ordered list of alias names to try when the primary target fails retryably. */
    fallbacks?: string[];
};

/** Static routing config — Phase 1 + 2. DynamoDB rows override these at runtime via routeLoader. */
export const modelMap: Record<string, RouteConfig> = {
    // ── OpenAI ──────────────────────────────────────────────────────────────────
    'gpt-5.4': {
        targets: [{ provider: 'openai', model: 'gpt-5.4', weight: 100, endpoint_mode: 'chat' }],
        fallbacks: ['gpt-5.2-codex'],
    },
    'gpt-5.2-codex': {
        targets: [{ provider: 'openai', model: 'gpt-5.2-codex', weight: 100, endpoint_mode: 'chat' }],
    },

    // ── OpenAI-compatible (Gemini via OpenAI-compatible API) ──────────────────
    'gemini-2.5-pro': {
        targets: [{ provider: 'openai_compatible:gemini', model: 'gemini-2.5-pro', weight: 100, endpoint_mode: 'chat' }],
    },
    'gemini-2.5-flash': {
        targets: [{ provider: 'openai_compatible:gemini', model: 'gemini-2.5-flash', weight: 100, endpoint_mode: 'chat' }],
    },

    // ── OpenAI-compatible (Vertex AI endpoint) ─────────────────────────────────
    'vertex-gemini-2.5-pro': {
        targets: [{ provider: 'openai_compatible:vertex', model: 'google/gemini-2.5-pro', weight: 100, endpoint_mode: 'chat' }],
    },
    'vertex-gemini-2.5-flash': {
        targets: [{ provider: 'openai_compatible:vertex', model: 'google/gemini-2.5-flash', weight: 100, endpoint_mode: 'chat' }],
    },

    // ── Amazon Bedrock Nova ──────────────────────────────────────────────────────
    'nova-lite': {
        targets: [{ provider: 'bedrock', model: 'amazon.nova-lite-v1:0', weight: 100 }],
    },
    'nova-pro': {
        targets: [{ provider: 'bedrock', model: 'amazon.nova-pro-v1:0', weight: 100 }],
    },
    'nova-micro': {
        targets: [{ provider: 'bedrock', model: 'amazon.nova-micro-v1:0', weight: 100 }],
    },

    // ── Anthropic Direct ─────────────────────────────────────────────────────────
    'claude-sonnet': {
        targets: [{ provider: 'anthropic', model: 'claude-sonnet-4-5', weight: 100 }],
    },
    'claude-haiku': {
        targets: [{ provider: 'anthropic', model: 'claude-haiku-3-5', weight: 100 }],
    },

    // ── Multi-provider aliases (weighted routing) ────────────────────────────────
    'fast': {
        targets: [
            { provider: 'openai', model: 'gpt-5.2-codex', weight: 60, endpoint_mode: 'chat' },
            { provider: 'bedrock', model: 'amazon.nova-lite-v1:0', weight: 40 },
        ],
        fallbacks: ['gpt-5.2-codex'],
    },
    'smart': {
        targets: [
            { provider: 'openai', model: 'gpt-5.4', weight: 50 },
            { provider: 'anthropic', model: 'claude-sonnet-4-5', weight: 50 },
        ],
        fallbacks: ['gpt-5.4'],
    },

    // ── Embeddings ───────────────────────────────────────────────────────────────
    'text-embedding-3-small': {
        targets: [{ provider: 'openai', model: 'text-embedding-3-small', weight: 100 }],
    },
    'text-embedding-3-large': {
        targets: [{ provider: 'openai', model: 'text-embedding-3-large', weight: 100 }],
    },

    // ── Image Generation ─────────────────────────────────────────────────────────
    'dall-e-3': {
        targets: [{ provider: 'openai', model: 'dall-e-3', weight: 100 }],
    },
    'dall-e-2': {
        targets: [{ provider: 'openai', model: 'dall-e-2', weight: 100 }],
    },
};

/** Public alias names exposed by GET /v1/models. Excludes internal/embedding/image aliases. */
export const publicAliases: string[] = [
    'gpt-5.4', 'gpt-5.2-codex',
    'gemini-2.5-pro', 'gemini-2.5-flash',
    'vertex-gemini-2.5-pro', 'vertex-gemini-2.5-flash',
    'nova-lite', 'nova-pro', 'nova-micro',
    'claude-sonnet', 'claude-haiku',
    'fast', 'smart',
    'text-embedding-3-small', 'text-embedding-3-large',
    'dall-e-3', 'dall-e-2',
];
