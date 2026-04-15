/**
 * Provider key pool — supports multiple API keys per provider with round-robin selection.
 *
 * Secret format (stored in AWS Secrets Manager):
 *   - Single key:  plain string, e.g. `sk-abc123`
 *   - Key pool:    JSON array of strings, e.g. `["sk-key1","sk-key2","sk-key3"]`
 *
 * When a pool contains more than one key, each call to `selectKey` advances
 * the round-robin counter so requests are spread evenly across keys within a
 * single Lambda warm instance.
 */

// Round-robin counter per pool ID (typically the provider name).
// Using module-level state so the counter persists across warm Lambda invocations.
const poolCounters = new Map<string, number>();

/**
 * Parse a secret value into an array of API keys.
 *
 * Accepts either:
 * - A plain API key string  → returns `[key]`
 * - A JSON array of strings → returns the array
 *
 * Throws if the value is empty or the array is empty / contains non-strings.
 */
export function parseKeyPool(secretValue: string): string[] {
    const trimmed = secretValue.trim();
    if (!trimmed) throw new Error('Secret value is empty');

    // Attempt JSON array parse when the value looks like a JSON array.
    // Values that start with '[' are treated as intended JSON arrays; malformed JSON
    // in this case throws a clear error rather than silently falling back to a plain-key
    // interpretation (which would mask configuration mistakes).
    if (trimmed.startsWith('[')) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            throw new Error(
                'Secret value starts with "[" but is not valid JSON. ' +
                'Key pool secrets must be a JSON array of strings (e.g. ["key1","key2"]), ' +
                'or a plain string for a single key.',
            );
        }
        if (
            Array.isArray(parsed) &&
            parsed.length > 0 &&
            parsed.every((k) => typeof k === 'string' && k.trim().length > 0)
        ) {
            return parsed.map((k) => (k as string).trim());
        }
        throw new Error(
            'Key pool secret must be a non-empty JSON array of non-empty strings',
        );
    }

    return [trimmed];
}

/**
 * Select the next key from a pool using round-robin ordering.
 *
 * @param poolId - Unique identifier for this pool (used to maintain per-pool state).
 *                 Typically the provider name, e.g. `"openai"` or `"anthropic"`.
 * @param keys   - The list of keys in the pool.
 * @returns The selected API key.
 */
export function selectKey(poolId: string, keys: string[]): string {
    if (keys.length === 0) throw new Error(`Key pool "${poolId}" is empty`);
    if (keys.length === 1) return keys[0];

    const current = poolCounters.get(poolId) ?? 0;
    const idx = current % keys.length;
    // Store the next index modulo pool size to prevent unbounded counter growth.
    poolCounters.set(poolId, (current + 1) % keys.length);
    return keys[idx];
}

/**
 * Reset all round-robin counters.
 * Intended for use in tests only.
 */
export function resetPoolCounters(): void {
    poolCounters.clear();
}
