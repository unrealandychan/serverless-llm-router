import { describe, it, expect } from 'vitest';
import { formatSseChunk, mergeUsage, SSE_DONE } from '../core/stream';
import { ProviderChunk } from '../providers/types';

describe('formatSseChunk', () => {
    it('formats a message_start chunk', () => {
        const chunk: ProviderChunk = { type: 'message_start', id: 'req_abc' };
        const result = formatSseChunk(chunk);
        expect(result).toBe('event: message.start\ndata: {"id":"req_abc"}\n\n');
    });

    it('formats a delta chunk', () => {
        const chunk: ProviderChunk = { type: 'delta', text: 'Hello world' };
        const result = formatSseChunk(chunk);
        expect(result).toBe('event: delta\ndata: {"content":"Hello world"}\n\n');
    });

    it('formats a message_end chunk with finish_reason', () => {
        const chunk: ProviderChunk = { type: 'message_end', finish_reason: 'stop' };
        const result = formatSseChunk(chunk);
        expect(result).toBe('event: message.end\ndata: {"finish_reason":"stop"}\n\n');
    });

    it('formats a message_end chunk without finish_reason (defaults to stop)', () => {
        const chunk: ProviderChunk = { type: 'message_end' };
        const result = formatSseChunk(chunk);
        expect(result).toContain('"finish_reason":"stop"');
    });

    it('formats a usage chunk', () => {
        const chunk: ProviderChunk = { type: 'usage', input_tokens: 10, output_tokens: 30 };
        const result = formatSseChunk(chunk);
        expect(result).toBe(
            'event: usage\ndata: {"input_tokens":10,"output_tokens":30}\n\n',
        );
    });

    it('returns an empty string for unrecognised chunk types', () => {
        // Cast to force an unknown type through
        const chunk = { type: 'unknown' } as unknown as ProviderChunk;
        expect(formatSseChunk(chunk)).toBe('');
    });
});

describe('SSE_DONE', () => {
    it('is the correct terminal SSE frame', () => {
        expect(SSE_DONE).toBe('event: done\ndata: [DONE]\n\n');
    });
});

describe('mergeUsage', () => {
    it('accumulates token counts from usage chunks', () => {
        let acc: { input_tokens?: number; output_tokens?: number } = {};
        acc = mergeUsage(acc, { type: 'usage', input_tokens: 10, output_tokens: 20 });
        acc = mergeUsage(acc, { type: 'usage', input_tokens: 5, output_tokens: 8 });
        expect(acc).toEqual({ input_tokens: 15, output_tokens: 28 });
    });

    it('returns accumulator unchanged for non-usage chunks', () => {
        const acc = { input_tokens: 5, output_tokens: 10 };
        const result = mergeUsage(acc, { type: 'delta', text: 'hi' });
        expect(result).toEqual(acc);
    });

    it('initialises from zero when accumulator is empty', () => {
        const result = mergeUsage({}, { type: 'usage', input_tokens: 7 });
        expect(result.input_tokens).toBe(7);
        expect(result.output_tokens).toBe(0);
    });
});
