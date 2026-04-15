import { describe, it, expect, beforeEach } from 'vitest';
import { parseKeyPool, selectKey, resetPoolCounters } from '../providers/keyPool';

beforeEach(() => {
    resetPoolCounters();
});

// ─── parseKeyPool ─────────────────────────────────────────────────────────────

describe('parseKeyPool', () => {
    it('returns a single-element array for a plain key string', () => {
        expect(parseKeyPool('sk-abc123')).toEqual(['sk-abc123']);
    });

    it('trims whitespace from a plain key string', () => {
        expect(parseKeyPool('  sk-abc123  ')).toEqual(['sk-abc123']);
    });

    it('parses a JSON array of keys', () => {
        const pool = parseKeyPool('["sk-key1","sk-key2","sk-key3"]');
        expect(pool).toEqual(['sk-key1', 'sk-key2', 'sk-key3']);
    });

    it('trims whitespace from keys inside a JSON array', () => {
        const pool = parseKeyPool('[" sk-key1 "," sk-key2 "]');
        expect(pool).toEqual(['sk-key1', 'sk-key2']);
    });

    it('parses a JSON array with a single key', () => {
        expect(parseKeyPool('["sk-only"]')).toEqual(['sk-only']);
    });

    it('throws on an empty string', () => {
        expect(() => parseKeyPool('')).toThrow('Secret value is empty');
        expect(() => parseKeyPool('   ')).toThrow('Secret value is empty');
    });

    it('throws on a JSON array that contains non-strings', () => {
        expect(() => parseKeyPool('[1, 2, 3]')).toThrow();
    });

    it('throws on a JSON array that contains empty strings', () => {
        expect(() => parseKeyPool('["sk-key1",""]')).toThrow();
    });

    it('throws on an empty JSON array', () => {
        expect(() => parseKeyPool('[]')).toThrow();
    });

    it('throws on malformed JSON starting with "["', () => {
        // A value that starts with '[' but is not valid JSON should throw a clear error,
        // not silently fall through to a plain-key interpretation.
        expect(() => parseKeyPool('[not-valid-json')).toThrow(/starts with "\[" but is not valid JSON/);
    });
});

// ─── selectKey ────────────────────────────────────────────────────────────────

describe('selectKey', () => {
    it('always returns the only key from a single-key pool', () => {
        const keys = ['sk-only'];
        for (let i = 0; i < 5; i++) {
            expect(selectKey('provider-a', keys)).toBe('sk-only');
        }
    });

    it('throws on an empty key pool', () => {
        expect(() => selectKey('provider-a', [])).toThrow();
    });

    it('rotates through all keys in round-robin order', () => {
        const keys = ['sk-key1', 'sk-key2', 'sk-key3'];
        expect(selectKey('provider-a', keys)).toBe('sk-key1');
        expect(selectKey('provider-a', keys)).toBe('sk-key2');
        expect(selectKey('provider-a', keys)).toBe('sk-key3');
        // Wraps around
        expect(selectKey('provider-a', keys)).toBe('sk-key1');
    });

    it('maintains independent counters per pool ID', () => {
        const keys = ['sk-key1', 'sk-key2'];
        expect(selectKey('pool-x', keys)).toBe('sk-key1');
        expect(selectKey('pool-y', keys)).toBe('sk-key1'); // pool-y starts fresh
        expect(selectKey('pool-x', keys)).toBe('sk-key2'); // pool-x advances
        expect(selectKey('pool-y', keys)).toBe('sk-key2'); // pool-y advances independently
    });

    it('distributes evenly across keys over many calls', () => {
        const keys = ['sk-key1', 'sk-key2', 'sk-key3'];
        const counts: Record<string, number> = { 'sk-key1': 0, 'sk-key2': 0, 'sk-key3': 0 };
        const total = 300;
        for (let i = 0; i < total; i++) {
            counts[selectKey('even-dist', keys)]++;
        }
        // Each key should appear exactly total/keys.length times with round-robin.
        expect(counts['sk-key1']).toBe(100);
        expect(counts['sk-key2']).toBe(100);
        expect(counts['sk-key3']).toBe(100);
    });

    it('resetPoolCounters resets round-robin state', () => {
        const keys = ['sk-key1', 'sk-key2'];
        selectKey('reset-test', keys); // advance to index 1
        resetPoolCounters();
        // Should start over from index 0
        expect(selectKey('reset-test', keys)).toBe('sk-key1');
    });
});
