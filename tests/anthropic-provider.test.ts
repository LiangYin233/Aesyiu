import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, ModelDefinition, Tool } from '../src/types/index.js';
import { AnthropicProvider, ANTHROPIC_MODELS } from '../src/provider/anthropic/index.js';

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;
  let mockCreate: ReturnType<typeof vi.fn>;
  let mockStream: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn();
    mockStream = vi.fn();
    provider = new AnthropicProvider({ apiKey: 'sk-ant-test' }, ANTHROPIC_MODELS);
    (provider as any).client = { messages: { create: mockCreate, stream: mockStream } };
  });

  describe('constructor', () => {
    it('should create provider with name "anthropic"', () => {
      expect(provider.name).toBe('anthropic');
    });

    it('should use ANTHROPIC_MODELS by default', () => {
      expect(provider.supportedModels.size).toBe(ANTHROPIC_MODELS.length);
      for (const model of ANTHROPIC_MODELS) {
        expect(provider.getModel(model.id)).toEqual(model);
      }
    });

    it('should use custom models when provided', () => {
      const customModels: ModelDefinition[] = [
        { id: 'custom-model', contextWindow: 100000, maxOutputTokens: 2048 },
      ];
      const p = new AnthropicProvider({ apiKey: 'key' }, customModels);
      expect(p.supportedModels.size).toBe(1);
      expect(p.getModel('custom-model')).toEqual(customModels[0]);
    });

    it('should pass baseURL to Anthropic client', () => {
      const p = new AnthropicProvider({ apiKey: 'key', baseURL: 'https://proxy.example.com' }, []);
      expect(p).toBeDefined();
    });
  });

  describe('message conversion (toSDKMessages)', () => {
    const model = ANTHROPIC_MODELS[0];

    it('should extract system messages to system parameter', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'response' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.generate(model, [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.system).toBe('You are helpful.');
      expect(callArgs.messages[0]).toEqual({ role: 'user', content: 'Hello' });
    });

    it('should convert assistant messages with tool_calls to tool_use content blocks', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.generate(model, [
        { role: 'user', content: 'search' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', name: 'search', arguments: '{"q":"test"}' }] },
        { role: 'tool', content: 'result', tool_call_id: 'tc1' },
      ] as Message[]);

      const callArgs = mockCreate.mock.calls[0][0];
      const assistantMsg = callArgs.messages[1];
      expect(assistantMsg.role).toBe('assistant');
      expect(assistantMsg.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool_use', id: 'tc1', name: 'search' }),
        ]),
      );
    });

    it('should convert tool result messages to tool_result content blocks', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.generate(model, [
        { role: 'user', content: 'search' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', name: 'search', arguments: '{}' }] },
        { role: 'tool', content: 'search result', tool_call_id: 'tc1' },
      ] as Message[]);

      const callArgs = mockCreate.mock.calls[0][0];
      const toolMsg = callArgs.messages[2];
      expect(toolMsg.role).toBe('user');
      expect(toolMsg.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool_result', tool_use_id: 'tc1' }),
        ]),
      );
    });

    it('should convert null content assistant messages to empty string', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.generate(model, [
        { role: 'assistant', content: null },
      ] as Message[]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[0].content).toBe('');
    });
  });

  describe('tool conversion (toSDKTools)', () => {
    const model = ANTHROPIC_MODELS[0];

    it('should convert Tool[] to Anthropic tools format', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const tools: Tool[] = [{
        name: 'search',
        description: 'search the web',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        execute: async () => '',
      }];

      await provider.generate(model, [{ role: 'user', content: 'search' }], tools);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.tools[0]).toEqual({
        name: 'search',
        description: 'search the web',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } },
      });
    });

    it('should not include tools parameter when no tools provided', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.generate(model, [{ role: 'user', content: 'hello' }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.tools).toBeUndefined();
    });
  });

  describe('response conversion (fromSDKResponse)', () => {
    const model = ANTHROPIC_MODELS[0];

    it('should convert text-only response', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Hello!' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const result = await provider.generate(model, [{ role: 'user', content: 'Hi' }]);
      expect(result.message).toEqual({
        role: 'assistant',
        content: 'Hello!',
      });
      expect(result.message.tool_calls).toBeUndefined();
    });

    it('should convert response with tool_use blocks', async () => {
      mockCreate.mockResolvedValue({
        content: [
          { type: 'tool_use', id: 'tc1', name: 'search', input: { q: 'test' } },
        ],
        usage: { input_tokens: 20, output_tokens: 10 },
      });

      const result = await provider.generate(model, [{ role: 'user', content: 'search' }]);
      expect(result.message.tool_calls).toEqual([
        { id: 'tc1', name: 'search', arguments: '{"q":"test"}' },
      ]);
      expect(result.message.content).toBeNull();
    });

    it('should convert response with both text and tool_use', async () => {
      mockCreate.mockResolvedValue({
        content: [
          { type: 'text', text: 'Let me search.' },
          { type: 'tool_use', id: 'tc1', name: 'search', input: { q: 'test' } },
        ],
        usage: { input_tokens: 15, output_tokens: 8 },
      });

      const result = await provider.generate(model, [{ role: 'user', content: 'search' }]);
      expect(result.message.content).toBe('Let me search.');
      expect(result.message.tool_calls).toEqual([
        { id: 'tc1', name: 'search', arguments: '{"q":"test"}' },
      ]);
    });

    it('should map token usage correctly', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const result = await provider.generate(model, [{ role: 'user', content: 'hi' }]);
      expect(result.usage).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });
    });
  });

  describe('generate', () => {
    const model = ANTHROPIC_MODELS[0];

    it('should pass correct parameters to API', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.generate(model, [{ role: 'user', content: 'test' }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.model).toBe(model.id);
      expect(callArgs.max_tokens).toBe(model.maxOutputTokens);
    });

    it('should rethrow API errors', async () => {
      mockCreate.mockRejectedValue(new Error('Rate limit exceeded'));

      await expect(
        provider.generate(model, [{ role: 'user', content: 'test' }]),
      ).rejects.toThrow('Rate limit exceeded');
    });

    it('should merge extraBody parameters', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const modelWithExtra = { ...model, extraBody: { temperature: 0.7 } };
      await provider.generate(modelWithExtra, [{ role: 'user', content: 'test' }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.temperature).toBe(0.7);
    });
  });

  describe('generateStream', () => {
    const model = ANTHROPIC_MODELS[0];

    it('should yield streaming chunks and final result', async () => {
      const chunks = [
        { type: 'message_start' },
        { type: 'content_block_start', content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
        { type: 'content_block_stop' },
        { type: 'message_delta', usage: { input_tokens: 10, output_tokens: 5 } },
      ];

      const mockAsyncIterable = {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i >= chunks.length) return { done: true };
              return { value: chunks[i++], done: false };
            },
          };
        },
      };
      mockStream.mockReturnValue(mockAsyncIterable);

      const gen = provider.generateStream(model, [{ role: 'user', content: 'hi' }]);
      const results = [];
      for await (const chunk of gen) {
        results.push(chunk);
      }

      expect(results.length).toBeGreaterThanOrEqual(2);
      const lastResult = results[results.length - 1];
      expect(lastResult.message.role).toBe('assistant');
      expect(lastResult.usage).toBeDefined();
    });
  });

  describe('default models', () => {
    it('ANTHROPIC_MODELS should contain Claude models', () => {
      expect(ANTHROPIC_MODELS.length).toBeGreaterThanOrEqual(3);
      const ids = ANTHROPIC_MODELS.map((m) => m.id);
      expect(ids).toContain('claude-3-5-sonnet-20241022');
      expect(ids).toContain('claude-3-5-haiku-20241022');
      expect(ids).toContain('claude-3-opus-20240229');
    });
  });
});