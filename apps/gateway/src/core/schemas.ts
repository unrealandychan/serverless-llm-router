import { z } from 'zod';

const ToolCallSchema = z.object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({
        name: z.string(),
        arguments: z.string(),
    }),
});

export const ChatMessageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool', 'developer']),
    content: z.string().nullable(),
    // Tool result fields (when role === 'tool')
    tool_call_id: z.string().optional(),
    // Tool call fields (when role === 'assistant' with tool calls)
    tool_calls: z.array(ToolCallSchema).optional(),
    name: z.string().optional(),
});

const ToolFunctionSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
    strict: z.boolean().optional(),
});

export const ToolSchema = z.object({
    type: z.literal('function'),
    function: ToolFunctionSchema,
});

const ToolChoiceObjectSchema = z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string() }),
});

export const ChatRequestSchema = z.object({
    model: z.string().min(1, 'model is required'),
    messages: z.array(ChatMessageSchema).min(1, 'messages must contain at least one entry'),
    stream: z.boolean().default(false),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    user: z.string().optional(),
    metadata: z.record(z.string()).optional(),
    tools: z.array(ToolSchema).optional(),
    tool_choice: z
        .union([
            z.literal('none'),
            z.literal('auto'),
            z.literal('required'),
            ToolChoiceObjectSchema,
        ])
        .optional(),
    parallel_tool_calls: z.boolean().optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type Tool = z.infer<typeof ToolSchema>;
