import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { AgentContext } from '../src/context/index.js';
import { AesyiuEngine } from '../src/engine/index.js';
import { LLMProvider } from '../src/provider/index.js';
import type { MCPServerConfig } from '../src/index.js';
import type { Message, ModelDefinition, Tool, TokenUsage } from '../src/types/index.js';

const model: ModelDefinition = {
  id: 'mock-model',
  contextWindow: 128000,
  maxOutputTokens: 4096,
};

const fixtureServerPath = fileURLToPath(new URL('./fixtures/mcp-test-server.mjs', import.meta.url));
const engines: AesyiuEngine[] = [];

class MockProvider extends LLMProvider {
  public seenTools: Tool[] = [];
  private responses: Message[];

  constructor(responses: Message[]) {
    super('mock', { apiKey: 'key' }, [model]);
    this.responses = [...responses];
  }

  async generate(modelDef: ModelDefinition, messages: Message[], tools?: Tool[]): Promise<{ message: Message; usage: TokenUsage }> {
    void modelDef;
    void messages;
    this.seenTools = tools ?? [];

    const response = this.responses.shift();
    if (!response) {
      throw new Error('No more mock responses');
    }

    return {
      message: response,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }

  async *generateStream(): AsyncGenerator<any> {
    yield { role: 'assistant', content: 'mock stream' };
  }
}

function createContext(provider: LLMProvider): AgentContext {
  return new AgentContext({
    providers: new Map([['mock', provider]]),
    defaultProvider: 'mock',
  });
}

function createServerConfig(name = 'fixtures'): MCPServerConfig {
  return {
    name,
    command: process.execPath,
    args: [fixtureServerPath],
  };
}

afterEach(async () => {
  while (engines.length > 0) {
    await engines.pop()!.dispose();
  }
});

describe('MCP integration', () => {
  it('registers stdio MCP servers and exposes namespaced tools', async () => {
    const provider = new MockProvider([{ role: 'assistant', content: 'done' }]);
    const engine = new AesyiuEngine();
    engines.push(engine);

    await engine.registerMCPServers([
      createServerConfig('alpha'),
      createServerConfig('beta'),
    ]);

    const ctx = createContext(provider);
    await engine.run({ role: 'user', content: 'hello' }, ctx);

    const toolNames = provider.seenTools.map((tool) => tool.name);
    expect(toolNames).toContain('alpha.echo');
    expect(toolNames).toContain('alpha.sum');
    expect(toolNames).toContain('beta.explode');
    expect((engine as any).globalTools.has('alpha.echo')).toBe(true);
  });

  it('executes MCP-backed tools through the existing engine loop', async () => {
    const provider = new MockProvider([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', name: 'fixtures.sum', arguments: '{"a":1,"b":2}' }] },
      { role: 'assistant', content: 'done' },
    ]);
    const engine = new AesyiuEngine();
    engines.push(engine);

    await engine.registerMCPServer(createServerConfig());

    const result = await engine.run({ role: 'user', content: 'sum numbers' }, createContext(provider));
    const toolMessage = result.messages.find((message) => message.role === 'tool');
    const payload = JSON.parse(toolMessage!.content!);

    expect(result.status).toBe('completed');
    expect(payload.success).toBe(true);
    expect(payload.result).toEqual({ total: 3 });
  });

  it('surfaces MCP invocation failures through the standard tool error path', async () => {
    const provider = new MockProvider([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', name: 'fixtures.explode', arguments: '{"message":"kaboom"}' }] },
      { role: 'assistant', content: 'done' },
    ]);
    const engine = new AesyiuEngine();
    engines.push(engine);

    await engine.registerMCPServer(createServerConfig());

    const result = await engine.run({ role: 'user', content: 'trigger failure' }, createContext(provider));
    const toolMessage = result.messages.find((message) => message.role === 'tool');
    const payload = JSON.parse(toolMessage!.content!);

    expect(result.status).toBe('completed');
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('kaboom');
  });

  it('fails fast when MCP server registration cannot start the process', async () => {
    const engine = new AesyiuEngine();
    engines.push(engine);

    await expect(engine.registerMCPServer({
      name: 'broken',
      command: 'this-command-should-not-exist',
    })).rejects.toThrow('Failed to register MCP server "broken"');
  });

  it('cleans up registered MCP connections on dispose', async () => {
    const engine = new AesyiuEngine();
    engines.push(engine);

    await engine.registerMCPServer(createServerConfig());

    expect((engine as any).mcpToolNames.size).toBeGreaterThan(0);
    expect((engine as any).mcpManager.servers.size).toBe(1);

    await engine.dispose();

    expect((engine as any).mcpToolNames.size).toBe(0);
    expect((engine as any).mcpManager.servers.size).toBe(0);
  });
});
