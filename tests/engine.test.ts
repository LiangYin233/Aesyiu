import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AesyiuEngine, Middleware } from '../src/engine/index.js';
import { AgentContext } from '../src/context/index.js';
import { LLMProvider } from '../src/provider/index.js';
import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage } from '../src/types/index.js';

let generateCallCount = 0;

class MockProvider extends LLMProvider {
  private responses: Message[];

  constructor(responses: Message[]) {
    const model: ModelDefinition = { id: 'mock-model', contextWindow: 128000, maxOutputTokens: 4096 };
    super('mock', { apiKey: 'key' }, [model]);
    this.responses = responses;
  }

  async generate(modelDef: ModelDefinition, messages: Message[], tools?: Tool[]): Promise<{ message: Message; usage: TokenUsage }> {
    const response = this.responses[generateCallCount] || this.responses[this.responses.length - 1];
    generateCallCount++;
    return {
      message: response,
      usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
    };
  }

  async *generateStream(): AsyncGenerator<any> {
    yield { content: 'mock' };
  }
}

function createContext(provider: LLMProvider): AgentContext {
  return new AgentContext({ provider });
}

describe('AesyiuEngine', () => {
  beforeEach(() => {
    generateCallCount = 0;
  });

  describe('middleware onion model', () => {
    it('should execute middlewares in onion order', async () => {
      const order: string[] = [];
      const middlewareA: Middleware = async (ctx, next) => {
        order.push('A-before');
        await next();
        order.push('A-after');
      };
      const middlewareB: Middleware = async (ctx, next) => {
        order.push('B-before');
        await next();
        order.push('B-after');
      };

      const provider = new MockProvider([{ role: 'assistant', content: 'done' }]);
      const engine = new AesyiuEngine().use(middlewareA).use(middlewareB);
      const ctx = createContext(provider);
      await engine.run({ role: 'user', content: 'hello' }, ctx);
      expect(order).toEqual(['A-before', 'B-before', 'B-after', 'A-after']);
    });

    it('should support single middleware', async () => {
      let called = false;
      const middleware: Middleware = async (ctx, next) => {
        called = true;
        await next();
      };

      const provider = new MockProvider([{ role: 'assistant', content: 'done' }]);
      const engine = new AesyiuEngine().use(middleware);
      const ctx = createContext(provider);
      await engine.run({ role: 'user', content: 'hello' }, ctx);
      expect(called).toBe(true);
    });
  });

  describe('tool registration', () => {
    it('should register tools and make them available', async () => {
      const tool: Tool = {
        name: 'test-tool',
        description: 'test',
        parameters: {},
        execute: async () => 'result',
      };
      const provider = new MockProvider([{ role: 'assistant', content: 'done' }]);
      const engine = new AesyiuEngine().registerTool(tool);
      const ctx = createContext(provider);
      await engine.run({ role: 'user', content: 'hello' }, ctx);
      expect((engine as any).globalTools.has('test-tool')).toBe(true);
    });

    it('should overwrite tool with same name', () => {
      const tool1: Tool = { name: 'dup', description: 'first', parameters: {}, execute: async () => '1' };
      const tool2: Tool = { name: 'dup', description: 'second', parameters: {}, execute: async () => '2' };
      const engine = new AesyiuEngine().registerTool(tool1).registerTool(tool2);
      expect((engine as any).globalTools.get('dup').description).toBe('second');
    });
  });

  describe('ReAct loop', () => {
    it('should complete when LLM responds without tool calls', async () => {
      const provider = new MockProvider([{ role: 'assistant', content: 'final answer' }]);
      const engine = new AesyiuEngine();
      const ctx = createContext(provider);
      const result = await engine.run({ role: 'user', content: 'hello' }, ctx);
      expect(result.status).toBe('completed');
      expect(result.messages.length).toBeGreaterThanOrEqual(2);
    });

    it('should execute tools when LLM returns tool_calls and then complete', async () => {
      const tool: Tool = {
        name: 'search',
        description: 'search tool',
        parameters: {},
        execute: async () => 'search result',
      };
      const provider = new MockProvider([
        { role: 'assistant', content: null, tool_calls: [{ id: 't1', name: 'search', arguments: '{}' }] },
        { role: 'assistant', content: 'final answer' },
      ]);
      const engine = new AesyiuEngine().registerTool(tool);
      const ctx = createContext(provider);
      const result = await engine.run({ role: 'user', content: 'search for X' }, ctx);
      expect(result.status).toBe('completed');
    });

    it('should return max_steps_reached when exceeding step limit', async () => {
      const tool: Tool = {
        name: 'loop-tool',
        description: 'loops forever',
        parameters: {},
        execute: async () => 'loop',
      };
      const provider = new MockProvider([{ role: 'assistant', content: null, tool_calls: [{ id: 't1', name: 'loop-tool', arguments: '{}' }] }]);
      const engine = new AesyiuEngine({ maxSteps: 2 }).registerTool(tool);
      const ctx = createContext(provider);
      const result = await engine.run({ role: 'user', content: 'loop' }, ctx);
      expect(result.status).toBe('max_steps_reached');
    });

    it('should use default maxSteps of 10', () => {
      const engine = new AesyiuEngine();
      expect((engine as any).maxSteps).toBe(10);
    });

    it('should support custom maxSteps', () => {
      const engine = new AesyiuEngine({ maxSteps: 20 });
      expect((engine as any).maxSteps).toBe(20);
    });
  });
});
