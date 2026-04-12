import { describe, it, expect, vi } from 'vitest';
import { AesyiuEngine } from '../src/engine/index.js';
import { AgentContext } from '../src/context/index.js';
import { LLMProvider } from '../src/provider/index.js';
import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage } from '../src/types/index.js';

let generateCallCount = 0;
let generateResponses: Array<{ message: Message; usage: TokenUsage }> = [];

function resetMocks() {
  generateCallCount = 0;
  generateResponses = [];
}

class MockProvider extends LLMProvider {
  constructor(config: ProviderConfig, models: ModelDefinition[]) {
    super('mock', config, models);
  }

  async generate(modelDef: ModelDefinition, messages: Message[], tools?: Tool[]): Promise<{ message: Message; usage: TokenUsage }> {
    const response = generateResponses[generateCallCount];
    if (!response) throw new Error('No more responses');
    generateCallCount++;
    return response;
  }

  async *generateStream(): AsyncGenerator<any> {
    yield { role: 'assistant', content: 'mock stream' };
  }
}

describe('E2E: Think-Act-Observe loop', () => {
  it('should complete full loop: user → LLM → tool → LLM → response', async () => {
    resetMocks();
    const provider = new MockProvider({ apiKey: 'test' }, [
      { id: 'mock-model', contextWindow: 128000, maxOutputTokens: 4096 },
    ]);
    const providers = new Map<string, LLMProvider>();
    providers.set('mock', provider);
    const ctx = new AgentContext({ providers, defaultProvider: 'mock' });

    const weatherTool: Tool = {
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: {},
      execute: async (args) => ({ city: args.city || 'unknown', temp: 25, condition: 'sunny' }),
    };

    const engine = new AesyiuEngine({ maxSteps: 10 });
    engine.registerTool(weatherTool);

    generateResponses = [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', name: 'get_weather', arguments: '{"city":"Beijing"}' }],
        },
        usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
      },
      {
        message: { role: 'assistant', content: 'The weather in Beijing is sunny, 25°C.' },
        usage: { promptTokens: 200, completionTokens: 20, totalTokens: 220 },
      },
    ];

    const result = await engine.run({ role: 'user', content: 'What is the weather in Beijing?' }, ctx);

    expect(result.status).toBe('completed');
    expect(result.messages.length).toBe(4);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[1].tool_calls).toBeDefined();
    expect(result.messages[2].role).toBe('tool');
    expect(result.messages[3].role).toBe('assistant');
    expect(result.messages[3].content).toContain('sunny');
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  it('should self-heal when tool call has invalid arguments', async () => {
    resetMocks();
    const provider = new MockProvider({ apiKey: 'test' }, [
      { id: 'mock-model', contextWindow: 128000, maxOutputTokens: 4096 },
    ]);
    const providers = new Map<string, LLMProvider>();
    providers.set('mock', provider);
    const ctx = new AgentContext({ providers, defaultProvider: 'mock' });

    const calcTool: Tool = {
      name: 'calculate',
      description: 'Perform calculation',
      parameters: {},
      execute: async (args) => args.a + args.b,
    };

    const engine = new AesyiuEngine({ maxSteps: 10 });
    engine.registerTool(calcTool);

    generateResponses = [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', name: 'calculate', arguments: 'invalid json' }],
        },
        usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
      },
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-2', name: 'calculate', arguments: '{"a":1,"b":2}' }],
        },
        usage: { promptTokens: 150, completionTokens: 20, totalTokens: 170 },
      },
      {
        message: { role: 'assistant', content: 'The result is 3.' },
        usage: { promptTokens: 200, completionTokens: 10, totalTokens: 210 },
      },
    ];

    const result = await engine.run({ role: 'user', content: 'What is 1+2?' }, ctx);

    expect(result.status).toBe('completed');
    const toolMessages = result.messages.filter(m => m.role === 'tool');
    const firstToolResult = JSON.parse(toolMessages[0].content!);
    expect(firstToolResult.success).toBe(false);
  });

  it('should work with middleware intercepting the flow', async () => {
    resetMocks();
    const provider = new MockProvider({ apiKey: 'test' }, [
      { id: 'mock-model', contextWindow: 128000, maxOutputTokens: 4096 },
    ]);
    const providers = new Map<string, LLMProvider>();
    providers.set('mock', provider);
    const ctx = new AgentContext({ providers, defaultProvider: 'mock' });

    const engine = new AesyiuEngine({ maxSteps: 10 });

    let middlewareCalled = false;
    engine.use(async (c, next) => {
      c.state.requestId = 'req-123';
      middlewareCalled = true;
      await next();
    });

    generateResponses = [
      { message: { role: 'assistant', content: 'Hello' }, usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 } },
    ];

    const result = await engine.run({ role: 'user', content: 'Hi' }, ctx);

    expect(result.status).toBe('completed');
    expect(middlewareCalled).toBe(true);
    expect(ctx.state.requestId).toBe('req-123');
  });
});