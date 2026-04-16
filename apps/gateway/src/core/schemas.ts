import { z } from 'zod';

export const ChatMessageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool', 'developer']),
    content: z.string(),
});

export const ChatRequestSchema = z.object({
    model: z.string().min(1, 'model is required'),
    messages: z.array(ChatMessageSchema).min(1, 'messages must contain at least one entry'),
    stream: z.boolean().default(false),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    user: z.string().optional(),
    metadata: z.record(z.string()).optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
