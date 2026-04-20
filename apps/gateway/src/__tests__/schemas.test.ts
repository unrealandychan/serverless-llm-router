import { describe, it, expect } from 'vitest';
import { ChatRequestSchema } from '../core/schemas';

describe('ChatRequestSchema — tools', () => {
    it('accepts a tools array with function definitions', () => {
        const result = ChatRequestSchema.safeParse({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'What is the weather in NYC?' }],
            tools: [
                {
                    type: 'function',
                    function: {
                        name: 'get_weather',
                        description: 'Get weather for a location',
                        parameters: {
                            type: 'object',
                            properties: { location: { type: 'string' } },
                            required: ['location'],
                        },
                    },
                },
            ],
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.tools).toHaveLength(1);
            expect(result.data.tools![0].function.name).toBe('get_weather');
        }
    });

    it('accepts tool_choice as "auto"', () => {
        const result = ChatRequestSchema.safeParse({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hello' }],
            tool_choice: 'auto',
        });
        expect(result.success).toBe(true);
    });

    it('accepts tool_choice as "none"', () => {
        const result = ChatRequestSchema.safeParse({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hello' }],
            tool_choice: 'none',
        });
        expect(result.success).toBe(true);
    });

    it('accepts tool_choice as "required"', () => {
        const result = ChatRequestSchema.safeParse({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hello' }],
            tool_choice: 'required',
        });
        expect(result.success).toBe(true);
    });

    it('accepts tool_choice as a specific function object', () => {
        const result = ChatRequestSchema.safeParse({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hello' }],
            tool_choice: { type: 'function', function: { name: 'get_weather' } },
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
        }
    });

    it('accepts parallel_tool_calls', () => {
        const result = ChatRequestSchema.safeParse({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hello' }],
            parallel_tool_calls: false,
        });
        expect(result.success).toBe(true);
    });

    it('accepts a tool-result message with tool_call_id', () => {
        const result = ChatRequestSchema.safeParse({
            model: 'gpt-4o',
            messages: [
                { role: 'user', content: 'What is the weather?' },
                {
                    role: 'tool',
                    content: '{"temperature": 72}',
                    tool_call_id: 'call_abc123',
                },
            ],
        });
        expect(result.success).toBe(true);
    });

    it('omits tools when not provided', () => {
        const result = ChatRequestSchema.safeParse({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hello' }],
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.tools).toBeUndefined();
            expect(result.data.tool_choice).toBeUndefined();
        }
    });
});
