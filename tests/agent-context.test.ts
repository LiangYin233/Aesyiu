import { describe, it, expect } from 'vitest';
import { AgentContext } from '../src/context/index.js';
import { LLMProvider } from '../src/provider/index.js';
import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage } from '../src/types/index.js';

class MockProvider extends LLMProvider {
  public generateCalls: { modelDef: ModelDefinition; messages: Message[]; tools?: Tool[] }[] = [];

  constructor(name: string, config: ProviderConfig, models: ModelDefinition[]) {
    super(name, config, models);
  }

  async generate(modelDef: ModelDefinition, messages: Message[], tools?: Tool[]): Promise<{ message: Message; usage: TokenUsage }> {
    this.generateCalls.push({ modelDef, messages, tools });
    return {
      message: { role: 'assistant', content: 'mock response' },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    };
  }

  async *generateStream(): AsyncGenerator<any> {
    yield { content: 'mock' };
  }
}

describe('AgentContext', () => {
  const model1: ModelDefinition = { id: 'model-1', contextWindow: 128000, maxOutputTokens: 4096 };
  const model2: ModelDefinition = { id: 'model-2', contextWindow: 64000, maxOutputTokens: 2048 };

  function createContext(defaultProvider = 'test', defaultModel = 'model-1') {
    const provider = new MockProvider('test', { apiKey: 'key' }, [model1, model2]);
    const providers = new Map([['test', provider]]);
    return new AgentContext({ providers, defaultProvider, defaultModel });
  }

  describe('initialization', () => {
    it('should initialize with empty messages, state, and zero usage', () => {
      const ctx = createContext();
      expect(ctx.messages).toEqual([]);
      expect(ctx.state).toEqual({});
      expect(ctx.sessionUsage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    });

    it('should call switchLLM with default provider on init', () => {
      const ctx = createContext();
      expect(ctx.activeProvider.name).toBe('test');
      expect(ctx.activeModel.id).toBe('model-1');
    });
  });

  describe('switchLLM', () => {
    it('should switch to specified provider and model', () => {
      const ctx = createContext();
      ctx.switchLLM('test', 'model-2');
      expect(ctx.activeModel.id).toBe('model-2');
    });

    it('should fall back to first model when no modelId specified', () => {
      const ctx = createContext();
      ctx.switchLLM('test');
      expect(ctx.activeModel.id).toBe('model-1');
    });

    it('should throw error for nonexistent provider', () => {
      const ctx = createContext();
      const before = ctx.activeProvider;
      expect(() => ctx.switchLLM('nonexistent')).toThrow('Provider "nonexistent" not found');
      expect(ctx.activeProvider).toBe(before);
    });
  });

  describe('accumulateUsage', () => {
    it('should accumulate token usage across multiple calls', () => {
      const ctx = createContext();
      ctx.accumulateUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
      ctx.accumulateUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
      expect(ctx.sessionUsage).toEqual({ promptTokens: 200, completionTokens: 100, totalTokens: 300 });
    });
  });
});