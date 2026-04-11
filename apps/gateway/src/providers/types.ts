/** Internal normalized request passed to every provider adapter. */
export type NormalizedRequest = {
    model: string;
    messages: Array<{ role: string; content: string }>;
    stream: boolean;
    temperature?: number;
    max_tokens?: number;
};

/** Internal normalized response from a non-streaming invocation. */
export type NormalizedResponse = {
    id: string;
    content: string;
    finish_reason?: string;
    input_tokens?: number;
    output_tokens?: number;
};

/** Tagged union of events emitted by a streaming provider adapter. */
export type ProviderChunk =
    | { type: 'message_start'; id: string }
    | { type: 'delta'; text: string }
    | { type: 'message_end'; finish_reason?: string }
    | { type: 'usage'; input_tokens?: number; output_tokens?: number };

/** Contract every provider adapter must implement. */
export interface ProviderAdapter {
    /** Unique provider identifier, e.g. "openai", "bedrock", "anthropic". */
    readonly name: string;

    /** Returns true if this adapter can handle the given provider-native model name. */
    supports(model: string): boolean;

    /** Non-streaming invocation. Resolves with the complete response. */
    invoke(req: NormalizedRequest): Promise<NormalizedResponse>;

    /** Streaming invocation. Yields ProviderChunk events until the stream ends. */
    stream(req: NormalizedRequest): AsyncGenerator<ProviderChunk>;
}

// ─── Embeddings ───────────────────────────────────────────────────────────────

export type EmbeddingRequest = {
    input: string | string[];
    model: string;
    encoding_format?: 'float' | 'base64';
    dimensions?: number;
    user?: string;
};

export type EmbeddingData = {
    object: 'embedding';
    embedding: number[];
    index: number;
};

export type EmbeddingResponse = {
    object: 'list';
    data: EmbeddingData[];
    model: string;
    usage: { prompt_tokens: number; total_tokens: number };
};

export interface EmbeddingAdapter {
    embed(req: EmbeddingRequest): Promise<EmbeddingResponse>;
}

// ─── Image Generation ─────────────────────────────────────────────────────────

export type ImageGenerationRequest = {
    prompt: string;
    model?: string;
    n?: number;
    size?: string;
    quality?: 'standard' | 'hd';
    response_format?: 'url' | 'b64_json';
    style?: 'vivid' | 'natural';
    user?: string;
};

export type ImageData = {
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
};

export type ImageGenerationResponse = {
    created: number;
    data: ImageData[];
};

export interface ImageGenerationAdapter {
    generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResponse>;
}

// ─── Audio ────────────────────────────────────────────────────────────────────

export type AudioTranscriptionRequest = {
    /** Base64-encoded audio bytes. */
    audio: string;
    /** Original filename used to infer MIME type (e.g. "recording.mp3"). */
    filename: string;
    model: string;
    language?: string;
    prompt?: string;
    temperature?: number;
};

export type AudioTranscriptionResponse = {
    text: string;
};

export type AudioSpeechRequest = {
    model: string;
    input: string;
    voice: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
    response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
    speed?: number;
};

export type AudioSpeechResponse = {
    /** Base64-encoded audio bytes. */
    audio: string;
    format: string;
};

export interface AudioAdapter {
    transcribe(req: AudioTranscriptionRequest): Promise<AudioTranscriptionResponse>;
    speak(req: AudioSpeechRequest): Promise<AudioSpeechResponse>;
}
