import { z } from 'zod';
import { randomUUID } from 'crypto';

// ─── Zod schema ───────────────────────────────────────────────────────────────

const ContentPartSchema = z.object({
    type: z.string(),
    text: z.string(),
});

const ResponseInputMessageSchema = z.object({
    type: z.literal('message').optional(),
    role: z.enum(['user', 'assistant', 'system']),
    content: z.union([z.string(), z.array(ContentPartSchema)]),
});

export const ResponsesRequestSchema = z.object({
    model: z.string().min(1, 'model is required'),
    input: z.union([z.string(), z.array(ResponseInputMessageSchema)]),
    instructions: z.string().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    stream: z.boolean().default(false),
    user: z.string().optional(),
    metadata: z.record(z.string()).optional(),
});

export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;

// ─── Conversion helpers ───────────────────────────────────────────────────────

/** Convert the Responses API `input` field (+ optional `instructions`) into normalized messages. */
export function inputToMessages(req: ResponsesRequest): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];

    if (req.instructions) {
        messages.push({ role: 'system', content: req.instructions });
    }

    if (typeof req.input === 'string') {
        messages.push({ role: 'user', content: req.input });
    } else {
        for (const msg of req.input) {
            const content =
                typeof msg.content === 'string'
                    ? msg.content
                    : msg.content.map((part) => part.text).join('');
            messages.push({ role: msg.role, content });
        }
    }

    return messages;
}

/** Generate a Responses API response ID (e.g. `resp_01ab…`). */
export function generateResponseId(): string {
    return `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Generate a Responses API message item ID (e.g. `msg_01ab…`). */
export function generateMessageId(): string {
    return `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Build the non-streaming Responses API response body. */
export function buildResponseBody(
    responseId: string,
    model: string,
    content: string,
    inputTokens: number,
    outputTokens: number,
): object {
    const msgId = generateMessageId();
    return {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        model,
        output: [
            {
                type: 'message',
                id: msgId,
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: content, annotations: [] }],
            },
        ],
        usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            output_tokens_details: { reasoning_tokens: 0 },
        },
    };
}

/** Format a single SSE frame for the Responses API streaming protocol. */
export function formatResponseSseEvent(eventType: string, data: unknown): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}
