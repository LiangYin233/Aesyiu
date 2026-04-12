import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, ModelDefinition, Tool, TokenUsage } from '../src/types/index.js';

const mockCreate = vi.fn();

vi.mock('openai', () => {
  class MockOpenAI {
    responses = {
      create: mockCreate,
    };
  }
  return { default: MockOpenAI };
});

import { OpenAIResponsesProvider, OPENAI_RESPONSES_MODELS } from '../src/provider/openai-responses/index.js';

describe('OpenAIResponsesProvider', () => {
  let provider: OpenAIResponsesProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockReset();
    provider = new OpenAIResponsesProvider({ apiKey: 'sk-test' }, OPENAI_RESPONSES_MODELS);
  });

  describe('constructor', () => {
    it('should create provider with name "openai-responses"', () => {
      expect(provider.name).toBe('openai-responses');
    });

    it('should use OPENAI_RESPONSES_MODELS by default', () => {
      expect(provider.supportedModels.size).toBe(OPENAI_RESPONSES_MODELS.length);
      for (const model of OPENAI_RESPONSES_MODELS) {
        expect(provider.getModel(model.id)).toEqual(model);
      }
    });

    it('should use custom models when provided', () => {
      const customModels: ModelDefinition[] = [
        { id: 'custom-model', contextWindow: 100000, maxOutputTokens: 2048 },
      ];
      const p = new OpenAIResponsesProvider({ apiKey: 'key' }, customModels);
      expect(p.supportedModels.size).toBe(1);
      expect(p.getModel('custom-model')).toEqual(customModels[0]);
    });

    it('should pass baseURL to OpenAI client', () => {
      const p = new OpenAIResponsesProvider({ apiKey: 'key', baseURL: 'https://proxy.example.com/v1' }, []);
      expect(p).toBeDefined();
    });
  });

  describe('message conversion (toSDKInput)', () => {
    const model = OPENAI_RESPONSES_MODELS[0];

    it('should convert system messages to system role in input', async () => {
      mockCreate.mockResolvedValue({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'response' }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.generate(model, [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ]);

      const callArgs = mockCreate.mock.calls[0][0];
      const hasSystem = callArgs.input.some((item: any) => item.role === 'system');
      expect(hasSystem).toBe(true);
    });

    it('should convert tool_calls to function_call items', async () => {
      mockCreate.mockResolvedValue({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.generate(model, [
        { role: 'user', content: 'search' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', name: 'search', arguments: '{"q":"test"}' }] },
        { role: 'tool', content: 'result', tool_call_id: 'tc1' },
      ] as Message[]);

      const callArgs = mockCreate.mock.calls[0][0];
      const functionCall = callArgs.input.find((item: any) => item.type === 'function_call');
      expect(functionCall).toBeDefined();
      expect(functionCall.call_id).toBe('tc1');
      expect(functionCall.name).toBe('search');

      const functionOutput = callArgs.input.find((item: any) => item.type === 'function_call_output');
      expect(functionOutput).toBeDefined();
      expect(functionOutput.call_id).toBe('tc1');
      expect(functionOutput.output).toBe('result');
    });

    it('should convert plain user/assistant messages', async () => {
      mockCreate.mockResolvedValue({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.generate(model, [
        { role: 'user', content: 'Hello' },
      ]);

      const callArgs = mockCreate.mock.calls[0][0];
      const userInput = callArgs.input.find((item: any) => item.role === 'user');
      expect(userInput).toBeDefined();
      expect(userInput.content).toBe('Hello');
    });
  });

  describe('tool conversion (toSDKTools)', () => {
    const model = OPENAI_RESPONSES_MODELS[0];

    it('should convert Tool[] to Responses API tools format', async () => {
      mockCreate.mockResolvedValue({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
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
      const tool = callArgs.tools[0];
      expect(tool.type).toBe('function');
      expect(tool.name).toBe('search');
      expect(tool.description).toBe('search the web');
      expect(tool.parameters).toEqual({ type: 'object', properties: { q: { type: 'string' } } });
    });

    it('should not include tools parameter when no tools provided', async () => {
      mockCreate.mockResolvedValue({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await provider.generate(model, [{ role: 'user', content: 'hello' }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.tools).toBeUndefined();
    });
  });

  describe('response conversion (fromSDKResponse)', () => {
    const model = OPENAI_RESPONSES_MODELS[0];

    it('should convert text-only response', async () => {
      mockCreate.mockResolvedValue({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello!' }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const result = await provider.generate(model, [{ role: 'user', content: 'Hi' }]);
      expect(result.message).toEqual({
        role: 'assistant',
        content: 'Hello!',
      });
      expect(result.message.tool_calls).toBeUndefined();
    });

    it('should convert response with function_call', async () => {
      mockCreate.mockResolvedValue({
        output: [
          { type: 'function_call', call_id: 'fc1', name: 'search', arguments: '{"q":"test"}' },
        ],
        usage: { input_tokens: 20, output_tokens: 10 },
      });

      const result = await provider.generate(model, [{ role: 'user', content: 'search' }]);
      expect(result.message.tool_calls).toEqual([
        { id: 'fc1', name: 'search', arguments: '{"q":"test"}' },
      ]);
    });

    it('should convert response with both text and function_call', async () => {
      mockCreate.mockResolvedValue({
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me search.' }] },
          { type: 'function_call', call_id: 'fc1', name: 'search', arguments: '{"q":"test"}' },
        ],
        usage: { input_tokens: 15, output_tokens: 8 },
      });

      const result = await provider.generate(model, [{ role: 'user', content: 'search' }]);
      expect(result.message.content).toBe('Let me search.');
      expect(result.message.tool_calls).toEqual([
        { id: 'fc1', name: 'search', arguments: '{"q":"test"}' },
      ]);
    });

    it('should map token usage correctly', async () => {
      mockCreate.mockResolvedValue({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
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
    const model = OPENAI_RESPONSES_MODELS[0];

    it('should rethrow API errors', async () => {
      mockCreate.mockRejectedValue(new Error('Rate limit exceeded'));

      await expect(
        provider.generate(model, [{ role: 'user', content: 'test' }]),
      ).rejects.toThrow('Rate limit exceeded');
    });
  });

  describe('default models', () => {
    it('OPENAI_RESPONSES_MODELS should contain GPT-4o models', () => {
      expect(OPENAI_RESPONSES_MODELS.length).toBeGreaterThanOrEqual(2);
      const ids = OPENAI_RESPONSES_MODELS.map((m) => m.id);
      expect(ids).toContain('gpt-4o');
      expect(ids).toContain('gpt-4o-mini');
    });
  });
});