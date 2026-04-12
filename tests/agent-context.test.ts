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
  const otherModel: ModelDefinition = { id: 'other-model', contextWindow: 32000, maxOutputTokens: 1024 };

  function createProvider(name = 'test', models: ModelDefinition[] = [model1, model2]) {
    return new MockProvider(name, { apiKey: 'key' }, models);
  }

  function createContext(provider = createProvider(), modelId = 'model-1') {
    return new AgentContext({ provider, modelId });
  }

  describe('initialization', () => {
    it('should initialize with empty messages, state, and zero usage', () => {
      const ctx = createContext();
      expect(ctx.messages).toEqual([]);
      expect(ctx.state).toEqual({});
      expect(ctx.sessionUsage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    });

    it('should initialize with the provided provider and model', () => {
      const ctx = createContext();
      expect(ctx.activeProvider.name).toBe('test');
      expect(ctx.activeModel.id).toBe('model-1');
    });

    it('should fall back to the provider first model when no modelId is provided', () => {
      const provider = createProvider();
      const ctx = new AgentContext({ provider });
      expect(ctx.activeProvider).toBe(provider);
      expect(ctx.activeModel.id).toBe('model-1');
    });
  });

  describe('switchLLM', () => {
    it('should switch to specified provider instance and model', () => {
      const ctx = createContext();
      const otherProvider = createProvider('other', [otherModel]);
      ctx.switchLLM(otherProvider, 'other-model');
      expect(ctx.activeProvider).toBe(otherProvider);
      expect(ctx.activeModel.id).toBe('other-model');
    });

    it('should fall back to first model when no modelId specified', () => {
      const ctx = createContext();
      const otherProvider = createProvider('other', [otherModel]);
      ctx.switchLLM(otherProvider);
      expect(ctx.activeProvider).toBe(otherProvider);
      expect(ctx.activeModel.id).toBe('other-model');
    });

    it('should throw error for nonexistent model on the provider', () => {
      const ctx = createContext();
      const before = ctx.activeProvider;
      expect(() => ctx.switchLLM(before, 'missing-model')).toThrow('Model "missing-model" not found in provider "test"');
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
