import { describe, it, expect, vi } from 'vitest';
import { MemoryManager } from '../src/memory/index.js';
import type { AgentContext } from '../src/context/index.js';
import type { Message, TokenUsage, ModelDefinition, Tool, ProviderConfig } from '../src/types/index.js';
import { LLMProvider } from '../src/provider/index.js';

class MockProvider extends LLMProvider {
  private mockResponse: string;

  constructor(name: string, config: ProviderConfig, models: ModelDefinition[], mockResponse = 'summary text') {
    super(name, config, models);
    this.mockResponse = mockResponse;
  }

  async generate(modelDef: ModelDefinition, messages: Message[], tools?: Tool[]): Promise<{ message: Message; usage: TokenUsage }> {
    return {
      message: { role: 'assistant' as const, content: this.mockResponse },
      usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
    };
  }

  async *generateStream(): AsyncGenerator<any> {
    yield { content: 'mock' };
  }
}

function createMockContext(messages: Message[], contextWindow = 128000): AgentContext {
  const model: ModelDefinition = { id: 'test-model', contextWindow, maxOutputTokens: 4096 };
  const provider = new MockProvider('test', { apiKey: 'key' }, [model]);
  const ctx = {
    messages,
    state: {},
    sessionUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    activeProvider: provider,
    activeModel: model,
    accumulateUsage(usage: TokenUsage) {
      this.sessionUsage.promptTokens += usage.promptTokens;
      this.sessionUsage.completionTokens += usage.completionTokens;
      this.sessionUsage.totalTokens += usage.totalTokens;
    },
    switchLLM() {},
  } as unknown as AgentContext;
  return ctx;
}

describe('MemoryManager', () => {
  describe('checkAndOptimize', () => {
    it('should not compress when tokens are below threshold', async () => {
      const manager = new MemoryManager({ compressThresholdRatio: 0.8, retainLatestMessages: 2 });
      const messages: Message[] = [{ role: 'user', content: 'hello' }];
      const ctx = createMockContext(messages);
      const usage: TokenUsage = { promptTokens: 50000, completionTokens: 100, totalTokens: 50100 };
      await manager.checkAndOptimize(ctx, usage);
      expect(ctx.messages.length).toBe(1);
      expect(ctx.sessionUsage.promptTokens).toBe(50000);
    });

    it('should trigger compression when tokens exceed threshold', async () => {
      const manager = new MemoryManager({ compressThresholdRatio: 0.8, retainLatestMessages: 2 });
      const messages: Message[] = [
        { role: 'system', content: 'system prompt', _meta: { isPinned: true } },
        ...Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `msg ${i}` })),
      ];
      const ctx = createMockContext(messages);
      const usage: TokenUsage = { promptTokens: 110000, completionTokens: 100, totalTokens: 110100 };
      await manager.checkAndOptimize(ctx, usage);
      expect(ctx.messages.length).toBeLessThan(messages.length);
    });

    it('should fall back to slice mode when compression fails', async () => {
      const failingProvider = new (class extends LLMProvider {
        constructor() { super('fail', { apiKey: 'key' }, [{ id: 'm', contextWindow: 128000, maxOutputTokens: 4096 }]); }
        async generate(): Promise<{ message: Message; usage: TokenUsage }> { throw new Error('API failed'); }
        async *generateStream(): AsyncGenerator<any> { yield ''; }
      })();
      const manager = new MemoryManager({ compressThresholdRatio: 0.8, retainLatestMessages: 2 });
      const model: ModelDefinition = { id: 'test', contextWindow: 128000, maxOutputTokens: 4096 };
      const messages: Message[] = [
        { role: 'system', content: 'pinned', _meta: { isPinned: true } },
        ...Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `msg ${i}` })),
      ];
      const ctx = {
        messages,
        state: {},
        sessionUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        activeProvider: failingProvider,
        activeModel: model,
        accumulateUsage(usage: TokenUsage) {
          this.sessionUsage.promptTokens += usage.promptTokens;
          this.sessionUsage.completionTokens += usage.completionTokens;
          this.sessionUsage.totalTokens += usage.totalTokens;
        },
        switchLLM() {},
      } as unknown as AgentContext;
      const usage: TokenUsage = { promptTokens: 110000, completionTokens: 100, totalTokens: 110100 };
      await manager.checkAndOptimize(ctx, usage);
      const pinnedCount = ctx.messages.filter((m: Message) => m._meta?.isPinned).length;
      expect(pinnedCount).toBe(1);
      expect(ctx.messages.length).toBeLessThan(11);
    });

    it('should accumulate usage on every check', async () => {
      const manager = new MemoryManager({ compressThresholdRatio: 0.8, retainLatestMessages: 2 });
      const ctx = createMockContext([{ role: 'user', content: 'hello' }]);
      const usage: TokenUsage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };
      await manager.checkAndOptimize(ctx, usage);
      expect(ctx.sessionUsage.promptTokens).toBe(1000);
      expect(ctx.sessionUsage.completionTokens).toBe(500);
      expect(ctx.sessionUsage.totalTokens).toBe(1500);
    });
  });

  describe('partition logic', () => {
    it('should correctly partition pinned, compressible, and protected messages', async () => {
      const manager = new MemoryManager({ compressThresholdRatio: 0.0001, retainLatestMessages: 2 });
      const messages: Message[] = [
        { role: 'system', content: 'system', _meta: { isPinned: true } },
        ...Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `msg ${i}` })),
      ];
      const ctx = createMockContext(messages, 128000);
      const usage: TokenUsage = { promptTokens: 200000, completionTokens: 100, totalTokens: 200100 };
      await manager.checkAndOptimize(ctx, usage);
      const pinned = ctx.messages.filter((m: Message) => m._meta?.isPinned);
      expect(pinned.length).toBe(1);
      expect(ctx.messages.length).toBeLessThan(11);
    });
  });
});