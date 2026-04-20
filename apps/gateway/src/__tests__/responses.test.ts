import { describe, it, expect } from 'vitest';
import {
    inputToMessages,
    generateResponseId,
    generateMessageId,
    buildResponseBody,
    formatResponseSseEvent,
    ResponsesRequestSchema,
} from '../core/responses';

describe('ResponsesRequestSchema', () => {
    it('accepts a string input', () => {
        const result = ResponsesRequestSchema.safeParse({ model: 'gpt-4o', input: 'Hello' });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.input).toBe('Hello');
            expect(result.data.stream).toBe(false);
        }
    });

    it('accepts an array input', () => {
        const result = ResponsesRequestSchema.safeParse({
            model: 'gpt-4o',
            input: [{ role: 'user', content: 'Hi' }],
        });
        expect(result.success).toBe(true);
    });

    it('accepts instructions', () => {
        const result = ResponsesRequestSchema.safeParse({
            model: 'gpt-4o',
            input: 'Hello',
            instructions: 'Be concise',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.instructions).toBe('Be concise');
        }
    });

    it('accepts max_output_tokens', () => {
        const result = ResponsesRequestSchema.safeParse({
            model: 'gpt-4o',
            input: 'Hello',
            max_output_tokens: 1024,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.max_output_tokens).toBe(1024);
        }
    });

    it('rejects missing model', () => {
        const result = ResponsesRequestSchema.safeParse({ input: 'Hello' });
        expect(result.success).toBe(false);
    });

    it('rejects missing input', () => {
        const result = ResponsesRequestSchema.safeParse({ model: 'gpt-4o' });
        expect(result.success).toBe(false);
    });
});

describe('inputToMessages', () => {
    it('converts string input to a single user message', () => {
        const msgs = inputToMessages({ model: 'gpt-4o', input: 'Hello', stream: false });
        expect(msgs).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('prepends instructions as a system message', () => {
        const msgs = inputToMessages({
            model: 'gpt-4o',
            input: 'Hello',
            instructions: 'Be helpful',
            stream: false,
        });
        expect(msgs[0]).toEqual({ role: 'system', content: 'Be helpful' });
        expect(msgs[1]).toEqual({ role: 'user', content: 'Hello' });
    });

    it('converts array input with string content', () => {
        const msgs = inputToMessages({
            model: 'gpt-4o',
            input: [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there' },
            ],
            stream: false,
        });
        expect(msgs).toEqual([
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
        ]);
    });

    it('joins content parts from array input', () => {
        const msgs = inputToMessages({
            model: 'gpt-4o',
            input: [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: 'Part one. ' },
                        { type: 'input_text', text: 'Part two.' },
                    ],
                },
            ],
            stream: false,
        });
        expect(msgs).toEqual([{ role: 'user', content: 'Part one. Part two.' }]);
    });

    it('returns empty array when input is empty array and no instructions', () => {
        const msgs = inputToMessages({ model: 'gpt-4o', input: [], stream: false });
        expect(msgs).toEqual([]);
    });

    it('includes only system message when input is empty array but instructions is set', () => {
        const msgs = inputToMessages({
            model: 'gpt-4o',
            input: [],
            instructions: 'Be brief',
            stream: false,
        });
        expect(msgs).toEqual([{ role: 'system', content: 'Be brief' }]);
    });
});

describe('generateResponseId / generateMessageId', () => {
    it('generateResponseId returns a string starting with resp_', () => {
        const id = generateResponseId();
        expect(id).toMatch(/^resp_[a-f0-9]{24}$/);
    });

    it('generateMessageId returns a string starting with msg_', () => {
        const id = generateMessageId();
        expect(id).toMatch(/^msg_[a-f0-9]{24}$/);
    });

    it('generates unique IDs', () => {
        const ids = new Set(Array.from({ length: 50 }, generateResponseId));
        expect(ids.size).toBe(50);
    });
});

describe('buildResponseBody', () => {
    it('returns correct structure for non-streaming response', () => {
        const body = buildResponseBody('resp_abc', 'gpt-4o', 'Hello!', 10, 5) as Record<string, unknown>;
        expect(body['id']).toBe('resp_abc');
        expect(body['object']).toBe('response');
        expect(body['status']).toBe('completed');
        expect(body['model']).toBe('gpt-4o');

        const output = body['output'] as Array<Record<string, unknown>>;
        expect(output).toHaveLength(1);
        expect(output[0]['type']).toBe('message');
        expect(output[0]['role']).toBe('assistant');

        const content = output[0]['content'] as Array<Record<string, unknown>>;
        expect(content[0]['type']).toBe('output_text');
        expect(content[0]['text']).toBe('Hello!');

        const usage = body['usage'] as Record<string, unknown>;
        expect(usage['input_tokens']).toBe(10);
        expect(usage['output_tokens']).toBe(5);
        expect(usage['total_tokens']).toBe(15);
    });
});

describe('formatResponseSseEvent', () => {
    it('formats a valid SSE frame', () => {
        const frame = formatResponseSseEvent('response.completed', { type: 'response.completed' });
        expect(frame).toContain('event: response.completed\n');
        expect(frame).toContain('data: {"type":"response.completed"}');
        expect(frame.endsWith('\n\n')).toBe(true);
    });
});

describe('ResponsesRequestSchema — tools', () => {
    it('accepts a tools array with function definitions', () => {
        const result = ResponsesRequestSchema.safeParse({
            model: 'gpt-4o',
            input: 'What is the weather?',
            tools: [
                {
                    type: 'function',
                    function: {
                        name: 'get_weather',
                        description: 'Get weather for a location',
                        parameters: { type: 'object', properties: { location: { type: 'string' } } },
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

    it('accepts tool_choice as a string literal', () => {
        const result = ResponsesRequestSchema.safeParse({
            model: 'gpt-4o',
            input: 'Hello',
            tool_choice: 'auto',
        });
        expect(result.success).toBe(true);
    });

    it('accepts tool_choice as a function object', () => {
        const result = ResponsesRequestSchema.safeParse({
            model: 'gpt-4o',
            input: 'Hello',
            tool_choice: { type: 'function', function: { name: 'my_tool' } },
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.tool_choice).toEqual({ type: 'function', function: { name: 'my_tool' } });
        }
    });

    it('accepts parallel_tool_calls', () => {
        const result = ResponsesRequestSchema.safeParse({
            model: 'gpt-4o',
            input: 'Hello',
            parallel_tool_calls: false,
        });
        expect(result.success).toBe(true);
    });
});
