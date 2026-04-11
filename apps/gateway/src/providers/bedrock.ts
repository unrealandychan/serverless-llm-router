import {
    BedrockRuntimeClient,
    ConverseCommand,
    ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { ProviderAdapter, NormalizedRequest, NormalizedResponse, ProviderChunk } from './types';
import { generateRequestId } from '../util/ids';

type BedrockMessage = {
    role: 'user' | 'assistant';
    content: Array<{ text: string }>;
};

function toBedrockMessages(messages: NormalizedRequest['messages']): {
    messages: BedrockMessage[];
    system?: Array<{ text: string }>;
} {
    const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => ({ text: m.content }));

    const chatMessages = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: [{ text: m.content }],
        }));

    return {
        messages: chatMessages,
        ...(system.length > 0 ? { system } : {}),
    };
}

/**
 * Provider adapter for AWS Bedrock using the unified Converse API.
 * Supports Amazon Nova, Anthropic Claude on Bedrock, and other converse-compatible models.
 * Uses the Lambda execution role for auth — no API key needed.
 */
export class BedrockAdapter implements ProviderAdapter {
    readonly name = 'bedrock';

    private readonly client: BedrockRuntimeClient;

    constructor(region?: string) {
        this.client = new BedrockRuntimeClient({
            region: region ?? process.env.AWS_REGION ?? 'us-east-1',
        });
    }

    supports(model: string): boolean {
        return (
            model.startsWith('amazon.') ||
            model.startsWith('anthropic.') ||
            model.startsWith('meta.llama') ||
            model.startsWith('mistral.') ||
            model.startsWith('cohere.')
        );
    }

    async invoke(req: NormalizedRequest): Promise<NormalizedResponse> {
        const { messages, system } = toBedrockMessages(req.messages);

        const response = await this.client.send(
            new ConverseCommand({
                modelId: req.model,
                messages,
                ...(system && system.length > 0 ? { system } : {}),
                inferenceConfig: {
                    ...(req.max_tokens ? { maxTokens: req.max_tokens } : {}),
                    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
                },
            }),
        );

        const outputContent = response.output?.message?.content ?? [];
        const textBlock = outputContent.find((c) => 'text' in c);
        const text = textBlock && 'text' in textBlock ? (textBlock.text ?? '') : '';

        return {
            id: response.$metadata.requestId ?? generateRequestId(),
            content: text,
            finish_reason: response.stopReason,
            input_tokens: response.usage?.inputTokens,
            output_tokens: response.usage?.outputTokens,
        };
    }

    async *stream(req: NormalizedRequest): AsyncGenerator<ProviderChunk> {
        const { messages, system } = toBedrockMessages(req.messages);
        const msgId = generateRequestId();

        const response = await this.client.send(
            new ConverseStreamCommand({
                modelId: req.model,
                messages,
                ...(system && system.length > 0 ? { system } : {}),
                inferenceConfig: {
                    ...(req.max_tokens ? { maxTokens: req.max_tokens } : {}),
                    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
                },
            }),
        );

        let emittedStart = false;

        for await (const event of response.stream ?? []) {
            if (!emittedStart) {
                yield { type: 'message_start', id: msgId };
                emittedStart = true;
            }

            const delta = event.contentBlockDelta?.delta;
            if (delta && 'text' in delta) {
                yield { type: 'delta', text: delta.text ?? '' };
            }

            if (event.messageStop) {
                yield {
                    type: 'message_end',
                    finish_reason: event.messageStop.stopReason ?? undefined,
                };
            }

            if (event.metadata?.usage) {
                yield {
                    type: 'usage',
                    input_tokens: event.metadata.usage.inputTokens,
                    output_tokens: event.metadata.usage.outputTokens,
                };
            }
        }
    }
}
