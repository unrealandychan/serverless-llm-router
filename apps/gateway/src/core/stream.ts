import { ProviderChunk } from '../providers/types';

/**
 * Format an internal ProviderChunk as an SSE frame.
 * Returns an empty string for unknown chunk types (callers should skip empty strings).
 */
export function formatSseChunk(chunk: ProviderChunk): string {
    switch (chunk.type) {
        case 'message_start':
            return `event: message.start\ndata: ${JSON.stringify({ id: chunk.id })}\n\n`;
        case 'delta':
            return `event: delta\ndata: ${JSON.stringify({ content: chunk.text })}\n\n`;
        case 'message_end':
            return `event: message.end\ndata: ${JSON.stringify({ finish_reason: chunk.finish_reason ?? 'stop' })}\n\n`;
        case 'usage':
            return `event: usage\ndata: ${JSON.stringify({
                input_tokens: chunk.input_tokens,
                output_tokens: chunk.output_tokens,
            })}\n\n`;
        default:
            return '';
    }
}

/** Terminal SSE frame signalling the end of a stream. */
export const SSE_DONE = 'event: done\ndata: [DONE]\n\n';

/** Accumulate token usage across chunks. */
export function mergeUsage(
    acc: { input_tokens?: number; output_tokens?: number },
    chunk: ProviderChunk,
): { input_tokens?: number; output_tokens?: number } {
    if (chunk.type === 'usage') {
        return {
            input_tokens: (acc.input_tokens ?? 0) + (chunk.input_tokens ?? 0),
            output_tokens: (acc.output_tokens ?? 0) + (chunk.output_tokens ?? 0),
        };
    }
    return acc;
}
