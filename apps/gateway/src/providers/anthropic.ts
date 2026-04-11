import Anthropic from '@anthropic-ai/sdk';
import { ProviderAdapter, NormalizedRequest, NormalizedResponse, ProviderChunk } from './types';

/**
 * Provider adapter for the Anthropic API (direct, not via Bedrock).
 * Supports claude-opus-*, claude-sonnet-*, claude-haiku-* model families.
 */
export class AnthropicAdapter implements ProviderAdapter {
    readonly name = 'anthropic';

    private readonly client: Anthropic;

    constructor(apiKey: string) {
        this.client = new Anthropic({ apiKey });
    }

    supports(model: string): boolean {
        return model.startsWith('claude-');
    }

    async invoke(req: NormalizedRequest): Promise<NormalizedResponse> {
        const systemMsg = req.messages.find((m) => m.role === 'system')?.content;
        const messages = req.messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

        const response = await this.client.messages.create({
            model: req.model,
            messages,
            ...(systemMsg ? { system: systemMsg } : {}),
            max_tokens: req.max_tokens ?? 2048,
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            stream: false,
        });

        const textBlock = response.content.find((b) => b.type === 'text');
        return {
            id: response.id,
            content: textBlock?.type === 'text' ? textBlock.text : '',
            finish_reason: response.stop_reason ?? undefined,
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
        };
    }

    async *stream(req: NormalizedRequest): AsyncGenerator<ProviderChunk> {
        const systemMsg = req.messages.find((m) => m.role === 'system')?.content;
        const messages = req.messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

        const stream = await this.client.messages.create({
            model: req.model,
            messages,
            ...(systemMsg ? { system: systemMsg } : {}),
            max_tokens: req.max_tokens ?? 2048,
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            stream: true,
        });

        let emittedStart = false;

        for await (const event of stream) {
            if (event.type === 'message_start') {
                if (!emittedStart) {
                    yield { type: 'message_start', id: event.message.id };
                    emittedStart = true;
                }
            } else if (
                event.type === 'content_block_delta' &&
                event.delta.type === 'text_delta'
            ) {
                yield { type: 'delta', text: event.delta.text };
            } else if (event.type === 'message_delta') {
                if (event.delta.stop_reason) {
                    yield { type: 'message_end', finish_reason: event.delta.stop_reason };
                }
                if (event.usage) {
                    yield {
                        type: 'usage',
                        input_tokens: undefined,
                        output_tokens: event.usage.output_tokens,
                    };
                }
            }
        }
    }
}
