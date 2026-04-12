import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, ModelDefinition, Tool, TokenUsage } from '../src/types/index.js';

const mockCreate = vi.fn();

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: mockCreate,
      },
    };
  }
  return { default: MockOpenAI };
});

import { OpenAICompletionProvider, OPENAI_COMPLETION_MODELS } from '../src/provider/openai-completion/index.js';

describe('OpenAICompletionProvider', () => {
  let provider: OpenAICompletionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockReset();
    provider = new OpenAICompletionProvider({ apiKey: 'sk-test' }, OPENAI_COMPLETION_MODELS);
  });

  describe('constructor', () => {
    it('should create provider with name "openai-completion"', () => {
      expect(provider.name).toBe('openai-completion');
    });

    it('should use OPENAI_COMPLETION_MODELS by default', () => {
      expect(provider.supportedModels.size).toBe(OPENAI_COMPLETION_MODELS.length);
      for (const model of OPENAI_COMPLETION_MODELS) {
        expect(provider.getModel(model.id)).toEqual(model);
      }
    });

    it('should use custom models when provided', () => {
      const customModels: ModelDefinition[] = [
        { id: 'custom-model', contextWindow: 100000, maxOutputTokens: 2048 },
      ];
      const p = new OpenAICompletionProvider({ apiKey: 'key' }, customModels);
      expect(p.supportedModels.size).toBe(1);
      expect(p.getModel('custom-model')).toEqual(customModels[0]);
    });

    it('should pass baseURL to OpenAI client', () => {
      const p = new OpenAICompletionProvider({ apiKey: 'key', baseURL: 'https://proxy.example.com/v1' }, []);
      expect(p).toBeDefined();
    });
  });

  describe('message conversion (toSDKMessages)', () => {
    const model = OPENAI_COMPLETION_MODELS[0];

    it('should convert system messages', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      await provider.generate(model, [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    });

    it('should convert assistant messages with tool_calls', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      await provider.generate(model, [
        { role: 'user', content: 'search' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', name: 'search', arguments: '{"q":"test"}' }] },
      ] as Message[]);

      const callArgs = mockCreate.mock.calls[0][0];
      const assistantMsg = callArgs.messages[1];
      expect(assistantMsg.role).toBe('assistant');
      expect(assistantMsg.content).toBeNull();
      expect(assistantMsg.tool_calls).toEqual([
        { id: 'tc1', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } },
      ]);
    });

    it('should convert tool result messages', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      await provider.generate(model, [
        { role: 'user', content: 'search' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', name: 'search', arguments: '{}' }] },
        { role: 'tool', content: 'search result', tool_call_id: 'tc1' },
      ] as Message[]);

      const callArgs = mockCreate.mock.calls[0][0];
      const toolMsg = callArgs.messages[2];
      expect(toolMsg).toEqual({ role: 'tool', tool_call_id: 'tc1', content: 'search result' });
    });

    it('should handle null content in messages', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      await provider.generate(model, [
        { role: 'assistant', content: null },
      ] as Message[]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[0].content).toBeNull();
    });
  });

  describe('tool conversion (toSDKTools)', () => {
    const model = OPENAI_COMPLETION_MODELS[0];

    it('should convert Tool[] to OpenAI function tools format', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
        type: 'function',
        function: {
          name: 'search',
          description: 'search the web',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      });
    });

    it('should not include tools parameter when no tools provided', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      await provider.generate(model, [{ role: 'user', content: 'hello' }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.tools).toBeUndefined();
    });
  });

  describe('response conversion (fromSDKResponse)', () => {
    const model = OPENAI_COMPLETION_MODELS[0];

    it('should convert text-only response', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'Hello!' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const result = await provider.generate(model, [{ role: 'user', content: 'Hi' }]);
      expect(result.message).toEqual({
        role: 'assistant',
        content: 'Hello!',
      });
      expect(result.message.tool_calls).toBeUndefined();
    });

    it('should convert response with tool_calls', async () => {
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } }],
          },
        }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });

      const result = await provider.generate(model, [{ role: 'user', content: 'search' }]);
      expect(result.message.tool_calls).toEqual([
        { id: 'tc1', name: 'search', arguments: '{"q":"test"}' },
      ]);
    });

    it('should convert response with content and tool_calls', async () => {
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            role: 'assistant',
            content: 'Let me search.',
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } }],
          },
        }],
        usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
      });

      const result = await provider.generate(model, [{ role: 'user', content: 'search' }]);
      expect(result.message.content).toBe('Let me search.');
      expect(result.message.tool_calls).toEqual([
        { id: 'tc1', name: 'search', arguments: '{"q":"test"}' },
      ]);
    });

    it('should map token usage correctly', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
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
    const model = OPENAI_COMPLETION_MODELS[0];

    it('should pass correct parameters to API', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      await provider.generate(model, [{ role: 'user', content: 'test' }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.model).toBe(model.id);
      expect(callArgs.messages).toBeDefined();
    });

    it('should rethrow API errors', async () => {
      mockCreate.mockRejectedValue(new Error('Rate limit exceeded'));

      await expect(
        provider.generate(model, [{ role: 'user', content: 'test' }]),
      ).rejects.toThrow('Rate limit exceeded');
    });

    it('should merge extraBody parameters', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const modelWithExtra = { ...model, extraBody: { temperature: 0.7 } };
      await provider.generate(modelWithExtra, [{ role: 'user', content: 'test' }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.temperature).toBe(0.7);
    });

    it('should not let extraBody override core parameters', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const modelWithExtra = { ...model, extraBody: { model: 'wrong-model', messages: 'bad' } };
      await provider.generate(modelWithExtra, [{ role: 'user', content: 'test' }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.model).toBe(model.id);
      expect(callArgs.messages).toBeDefined();
      expect(callArgs.messages).not.toBe('bad');
    });
  });

  describe('generateStream', () => {
    const model = OPENAI_COMPLETION_MODELS[0];

    it('should yield streaming chunks and final result', async () => {
      const chunks = [
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
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
      mockCreate.mockResolvedValue(mockAsyncIterable);

      const gen = provider.generateStream(model, [{ role: 'user', content: 'hi' }]);
      const results = [];
      for await (const chunk of gen) {
        results.push(chunk);
      }

      expect(results.length).toBeGreaterThanOrEqual(2);
      const lastResult = results[results.length - 1];
      expect(lastResult.message.role).toBe('assistant');
    });
  });

  describe('default models', () => {
    it('OPENAI_COMPLETION_MODELS should contain GPT models', () => {
      expect(OPENAI_COMPLETION_MODELS.length).toBeGreaterThanOrEqual(3);
      const ids = OPENAI_COMPLETION_MODELS.map((m) => m.id);
      expect(ids).toContain('gpt-4o');
      expect(ids).toContain('gpt-4o-mini');
      expect(ids).toContain('gpt-4-turbo');
    });
  });
});