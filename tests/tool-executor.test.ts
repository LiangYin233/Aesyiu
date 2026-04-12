import { describe, it, expect, vi } from 'vitest';
import { ToolExecutor } from '../src/tool/index.js';
import type { AgentContext } from '../src/context/index.js';
import type { Tool, ToolCall, Message, ModelDefinition, ProviderConfig, TokenUsage } from '../src/types/index.js';
import { z } from 'zod';
import { LLMProvider } from '../src/provider/index.js';

class MockProvider extends LLMProvider {
  constructor() { super('mock', { apiKey: 'key' }, [{ id: 'm', contextWindow: 128000, maxOutputTokens: 4096 }]); }
  async generate(): Promise<{ message: Message; usage: TokenUsage }> {
    return { message: { role: 'assistant', content: 'ok' }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async *generateStream(): AsyncGenerator<any> { yield ''; }
}

function createMockContext(): AgentContext {
  const provider = new MockProvider();
  const ctx = {
    messages: [],
    state: {},
    sessionUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    activeProvider: provider,
    activeModel: { id: 'm', contextWindow: 128000, maxOutputTokens: 4096 },
    accumulateUsage() {},
    switchLLM() {},
  } as unknown as AgentContext;
  return ctx;
}

describe('ToolExecutor', () => {
  describe('parallel execution', () => {
    it('should execute multiple tools in parallel', async () => {
      const delays: number[] = [];
      const tool1: Tool = {
        name: 'fast',
        description: 'fast tool',
        parameters: {},
        execute: async () => { delays.push(Date.now()); return 'fast result'; },
      };
      const tool2: Tool = {
        name: 'slow',
        description: 'slow tool',
        parameters: {},
        execute: async () => { await new Promise(r => setTimeout(r, 50)); delays.push(Date.now()); return 'slow result'; },
      };
      const tools = new Map([['fast', tool1], ['slow', tool2]]);
      const ctx = createMockContext();
      const calls: ToolCall[] = [
        { id: '1', name: 'fast', arguments: '{}' },
        { id: '2', name: 'slow', arguments: '{}' },
      ];
      const results = await ToolExecutor.executeCalls(calls, tools, ctx);
      expect(results).toHaveLength(2);
    });

    it('should handle partial failures without breaking other calls', async () => {
      const tool1: Tool = {
        name: 'ok',
        description: 'ok tool',
        parameters: {},
        execute: async () => 'ok result',
      };
      const tool2: Tool = {
        name: 'fail',
        description: 'fail tool',
        parameters: {},
        execute: async () => { throw new Error('intentional failure'); },
      };
      const tools = new Map([['ok', tool1], ['fail', tool2]]);
      const ctx = createMockContext();
      const calls: ToolCall[] = [
        { id: '1', name: 'ok', arguments: '{}' },
        { id: '2', name: 'fail', arguments: '{}' },
      ];
      const results = await ToolExecutor.executeCalls(calls, tools, ctx);
      expect(results).toHaveLength(2);
      const okResult = JSON.parse(results[0].content!);
      expect(okResult.success).toBe(true);
      const failResult = JSON.parse(results[1].content!);
      expect(failResult.success).toBe(false);
      expect(failResult.error).toBe('intentional failure');
    });
  });

  describe('JSON argument parsing', () => {
    it('should parse valid JSON arguments', async () => {
      const tool: Tool = {
        name: 'echo',
        description: 'echo tool',
        parameters: {},
        execute: async (args) => args,
      };
      const tools = new Map([['echo', tool]]);
      const ctx = createMockContext();
      const calls: ToolCall[] = [{ id: '1', name: 'echo', arguments: '{"key":"value"}' }];
      const results = await ToolExecutor.executeCalls(calls, tools, ctx);
      const parsed = JSON.parse(results[0].content!);
      expect(parsed.success).toBe(true);
      expect(parsed.result).toEqual({ key: 'value' });
    });

    it('should handle invalid JSON arguments gracefully', async () => {
      const tool: Tool = {
        name: 'echo',
        description: 'echo tool',
        parameters: {},
        execute: async (args) => args,
      };
      const tools = new Map([['echo', tool]]);
      const ctx = createMockContext();
      const calls: ToolCall[] = [{ id: '1', name: 'echo', arguments: 'not-json' }];
      const results = await ToolExecutor.executeCalls(calls, tools, ctx);
      const parsed = JSON.parse(results[0].content!);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBeTruthy();
    });
  });

  describe('Zod schema validation', () => {
    it('should pass validated arguments to execute', async () => {
      const schema = z.object({ query: z.string() });
      const tool: Tool = {
        name: 'search',
        description: 'search tool',
        parameters: schema,
        execute: async (args) => args,
      };
      const tools = new Map([['search', tool]]);
      const ctx = createMockContext();
      const calls: ToolCall[] = [{ id: '1', name: 'search', arguments: '{"query":"hello"}' }];
      const results = await ToolExecutor.executeCalls(calls, tools, ctx);
      const parsed = JSON.parse(results[0].content!);
      expect(parsed.success).toBe(true);
      expect(parsed.result).toEqual({ query: 'hello' });
    });

    it('should return validation error when schema check fails', async () => {
      const schema = z.object({ count: z.number() });
      const tool: Tool = {
        name: 'counter',
        description: 'counter tool',
        parameters: schema,
        execute: async (args) => args,
      };
      const tools = new Map([['counter', tool]]);
      const ctx = createMockContext();
      const calls: ToolCall[] = [{ id: '1', name: 'counter', arguments: '{"count":"not-a-number"}' }];
      const results = await ToolExecutor.executeCalls(calls, tools, ctx);
      const parsed = JSON.parse(results[0].content!);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBeTruthy();
    });
  });

  describe('error-to-observation feedback', () => {
    it('should return success result for successful tool execution', async () => {
      const tool: Tool = {
        name: 'weather',
        description: 'weather tool',
        parameters: {},
        execute: async () => ({ temperature: 25 }),
      };
      const tools = new Map([['weather', tool]]);
      const ctx = createMockContext();
      const calls: ToolCall[] = [{ id: '1', name: 'weather', arguments: '{}' }];
      const results = await ToolExecutor.executeCalls(calls, tools, ctx);
      expect(results[0].role).toBe('tool');
      expect(results[0].tool_call_id).toBe('1');
      const parsed = JSON.parse(results[0].content!);
      expect(parsed.success).toBe(true);
      expect(parsed.result).toEqual({ temperature: 25 });
    });

    it('should return error result for failed tool execution', async () => {
      const tool: Tool = {
        name: 'fail-tool',
        description: 'failing tool',
        parameters: {},
        execute: async () => { throw new Error('Network timeout'); },
      };
      const tools = new Map([['fail-tool', tool]]);
      const ctx = createMockContext();
      const calls: ToolCall[] = [{ id: '2', name: 'fail-tool', arguments: '{}' }];
      const results = await ToolExecutor.executeCalls(calls, tools, ctx);
      expect(results[0].role).toBe('tool');
      expect(results[0].tool_call_id).toBe('2');
      const parsed = JSON.parse(results[0].content!);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Network timeout');
    });

    it('should return error for unknown tool', async () => {
      const tools = new Map();
      const ctx = createMockContext();
      const calls: ToolCall[] = [{ id: '3', name: 'nonexistent', arguments: '{}' }];
      const results = await ToolExecutor.executeCalls(calls, tools, ctx);
      const parsed = JSON.parse(results[0].content!);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('not found');
    });
  });
});