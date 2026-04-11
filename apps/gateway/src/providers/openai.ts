import OpenAI, { toFile } from 'openai';
import {
    ProviderAdapter,
    NormalizedRequest,
    NormalizedResponse,
    ProviderChunk,
    EmbeddingAdapter,
    EmbeddingRequest,
    EmbeddingResponse,
    ImageGenerationAdapter,
    ImageGenerationRequest,
    ImageGenerationResponse,
    AudioAdapter,
    AudioTranscriptionRequest,
    AudioTranscriptionResponse,
    AudioSpeechRequest,
    AudioSpeechResponse,
} from './types';

export class OpenAIAdapter implements ProviderAdapter, EmbeddingAdapter, ImageGenerationAdapter, AudioAdapter {
    readonly name: string;

    private readonly client: OpenAI;

    constructor(apiKey: string, options?: { baseURL?: string; name?: string }) {
        this.client = new OpenAI({
            apiKey,
            ...(options?.baseURL ? { baseURL: options.baseURL } : {}),
        });
        this.name = options?.name ?? 'openai';
    }

    supports(model: string): boolean {
        return (
            model.startsWith('gpt-') ||
            model.startsWith('o1') ||
            model.startsWith('o3') ||
            model.startsWith('chatgpt-')
        );
    }

    async invoke(req: NormalizedRequest): Promise<NormalizedResponse> {
        try {
            const response = await this.client.chat.completions.create({
                model: req.model,
                messages: req.messages as OpenAI.ChatCompletionMessageParam[],
                temperature: req.temperature,
                max_tokens: req.max_tokens,
                stream: false,
            });

            const choice = response.choices[0];
            if (!choice) throw new Error('OpenAI returned no choices');

            return {
                id: response.id,
                content: choice.message.content ?? '',
                finish_reason: choice.finish_reason ?? undefined,
                input_tokens: response.usage?.prompt_tokens,
                output_tokens: response.usage?.completion_tokens,
            };
        } catch (err) {
            if (!this.isChatUnsupportedError(err)) throw err;

            // Some OpenAI-compatible models only expose /v1/completions.
            const response = await this.client.completions.create({
                model: req.model,
                prompt: this.messagesToPrompt(req.messages),
                temperature: req.temperature,
                max_tokens: req.max_tokens,
                stream: false,
            });

            const choice = response.choices[0];
            if (!choice) throw new Error('OpenAI-compatible completions returned no choices');

            return {
                id: response.id,
                content: choice.text ?? '',
                finish_reason: choice.finish_reason ?? undefined,
                input_tokens: response.usage?.prompt_tokens,
                output_tokens: response.usage?.completion_tokens,
            };
        }
    }

    async *stream(req: NormalizedRequest): AsyncGenerator<ProviderChunk> {
        try {
            const stream = await this.client.chat.completions.create({
                model: req.model,
                messages: req.messages as OpenAI.ChatCompletionMessageParam[],
                temperature: req.temperature,
                max_tokens: req.max_tokens,
                stream: true,
                stream_options: { include_usage: true },
            });

            let emittedStart = false;

            for await (const chunk of stream) {
                if (!emittedStart) {
                    yield { type: 'message_start', id: chunk.id };
                    emittedStart = true;
                }

                const delta = chunk.choices[0]?.delta?.content;
                if (delta) {
                    yield { type: 'delta', text: delta };
                }

                const finishReason = chunk.choices[0]?.finish_reason;
                if (finishReason) {
                    yield { type: 'message_end', finish_reason: finishReason };
                }

                if (chunk.usage) {
                    yield {
                        type: 'usage',
                        input_tokens: chunk.usage.prompt_tokens,
                        output_tokens: chunk.usage.completion_tokens,
                    };
                }
            }
            return;
        } catch (err) {
            if (!this.isChatUnsupportedError(err)) throw err;

            // Fallback for providers/models that only support /v1/completions streaming.
            const stream = await this.client.completions.create({
                model: req.model,
                prompt: this.messagesToPrompt(req.messages),
                temperature: req.temperature,
                max_tokens: req.max_tokens,
                stream: true,
            });

            let emittedStart = false;
            for await (const chunk of stream) {
                if (!emittedStart) {
                    yield { type: 'message_start', id: chunk.id };
                    emittedStart = true;
                }

                const delta = chunk.choices[0]?.text;
                if (delta) {
                    yield { type: 'delta', text: delta };
                }

                const finishReason = chunk.choices[0]?.finish_reason;
                if (finishReason) {
                    yield { type: 'message_end', finish_reason: finishReason };
                }
            }
        }
    }

    private isChatUnsupportedError(err: unknown): boolean {
        const msg = err instanceof Error ? err.message : String(err);
        return (
            msg.includes('not a chat model') ||
            (msg.includes('v1/chat/completions') && msg.includes('v1/completions'))
        );
    }

    private messagesToPrompt(messages: Array<{ role: string; content: string }>): string {
        const lines = messages.map((m) => `${m.role}: ${m.content}`);
        lines.push('assistant:');
        return lines.join('\n');
    }

    // ─── Embeddings ───────────────────────────────────────────────────────────

    async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
        const response = await this.client.embeddings.create({
            model: req.model,
            input: req.input,
            encoding_format: req.encoding_format ?? 'float',
            ...(req.dimensions ? { dimensions: req.dimensions } : {}),
            ...(req.user ? { user: req.user } : {}),
        });

        return {
            object: 'list',
            data: response.data.map((item) => ({
                object: 'embedding' as const,
                embedding: item.embedding,
                index: item.index,
            })),
            model: response.model,
            usage: {
                prompt_tokens: response.usage.prompt_tokens,
                total_tokens: response.usage.total_tokens,
            },
        };
    }

    // ─── Image generation ─────────────────────────────────────────────────────

    async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResponse> {
        const response = await this.client.images.generate({
            model: req.model ?? 'dall-e-3',
            prompt: req.prompt,
            ...(req.n ? { n: req.n } : {}),
            ...(req.size ? { size: req.size as OpenAI.ImageGenerateParams['size'] } : {}),
            ...(req.quality ? { quality: req.quality } : {}),
            response_format: req.response_format ?? 'url',
            ...(req.style ? { style: req.style } : {}),
            ...(req.user ? { user: req.user } : {}),
        });

        return {
            created: response.created,
            data: (response.data ?? []).map((img) => ({
                url: img.url,
                b64_json: img.b64_json,
                revised_prompt: img.revised_prompt,
            })),
        };
    }

    // ─── Audio ────────────────────────────────────────────────────────────────

    async transcribe(req: AudioTranscriptionRequest): Promise<AudioTranscriptionResponse> {
        const audioBuffer = Buffer.from(req.audio, 'base64');
        const mimeType = req.filename.endsWith('.mp4') || req.filename.endsWith('.m4a')
            ? 'audio/mp4'
            : req.filename.endsWith('.ogg') || req.filename.endsWith('.oga')
                ? 'audio/ogg'
                : req.filename.endsWith('.wav')
                    ? 'audio/wav'
                    : req.filename.endsWith('.webm')
                        ? 'audio/webm'
                        : req.filename.endsWith('.flac')
                            ? 'audio/flac'
                            : 'audio/mpeg';

        const file = await toFile(audioBuffer, req.filename, { type: mimeType });

        const response = await this.client.audio.transcriptions.create({
            model: req.model,
            file,
            ...(req.language ? { language: req.language } : {}),
            ...(req.prompt ? { prompt: req.prompt } : {}),
            response_format: 'json',
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        });

        return { text: response.text };
    }

    async speak(req: AudioSpeechRequest): Promise<AudioSpeechResponse> {
        const response = await this.client.audio.speech.create({
            model: req.model,
            voice: req.voice,
            input: req.input,
            response_format: req.response_format ?? 'mp3',
            ...(req.speed !== undefined ? { speed: req.speed } : {}),
        });

        const buffer = Buffer.from(await response.arrayBuffer());
        return {
            audio: buffer.toString('base64'),
            format: req.response_format ?? 'mp3',
        };
    }
}
