import { describe, expect, it } from 'vitest';
import { AgentContext } from '../src/context/index.js';
import { AesyiuEngine } from '../src/engine/index.js';
import { LLMProvider } from '../src/provider/index.js';
import type { AgentSkill } from '../src/skill/index.js';
import type { Message, ModelDefinition, Tool, TokenUsage } from '../src/types/index.js';

const model: ModelDefinition = {
  id: 'mock-model',
  contextWindow: 128000,
  maxOutputTokens: 4096,
};

class RecordingProvider extends LLMProvider {
  public seenMessages: Message[][] = [];
  public seenTools: Tool[][] = [];
  private responses: Message[];

  constructor(responses: Message[]) {
    super('mock', { apiKey: 'key' }, [model]);
    this.responses = [...responses];
  }

  async generate(modelDef: ModelDefinition, messages: Message[], tools?: Tool[]): Promise<{ message: Message; usage: TokenUsage }> {
    void modelDef;
    this.seenMessages.push(messages.map((message) => ({ ...message, _meta: message._meta ? { ...message._meta } : undefined })));
    this.seenTools.push([...(tools ?? [])]);

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
  return new AgentContext({ provider });
}

const skills: AgentSkill[] = [
  {
    name: 'writer',
    description: 'Writing style guide',
    metadata: { name: 'writer', description: 'Writing style guide' },
    content: 'Full writer skill body',
    rootPath: '/skills/writer',
    entryPath: '/skills/writer/SKILL.md',
    resourcePaths: { references: '/skills/writer/references' },
  },
  {
    name: 'reviewer',
    description: 'Code review checklist',
    metadata: { name: 'reviewer', description: 'Code review checklist' },
    content: 'Full reviewer skill body',
    rootPath: '/skills/reviewer',
    entryPath: '/skills/reviewer/SKILL.md',
    resourcePaths: {},
  },
];

describe('skill engine integration', () => {
  it('injects a deterministic skill prompt and registers loadskill', async () => {
    const provider = new RecordingProvider([{ role: 'assistant', content: 'done' }]);
    const engine = new AesyiuEngine().registerSkills(skills);
    const ctx = createContext(provider);

    await engine.run({ role: 'user', content: 'help me write docs' }, ctx);

    const firstCallMessages = provider.seenMessages[0];
    expect(firstCallMessages[0].role).toBe('system');
    expect(firstCallMessages[0].content).toContain('writer: Writing style guide');
    expect(firstCallMessages[0].content).toContain('reviewer: Code review checklist');
    expect(firstCallMessages[0].content).toContain('loadskill');
    expect(firstCallMessages[0].content).not.toContain('Full writer skill body');
    expect(firstCallMessages[0]._meta?.skillPrompt).toBe(true);
    expect(firstCallMessages[1]).toEqual({ role: 'user', content: 'help me write docs' });
    expect(provider.seenTools[0].map((tool) => tool.name)).toContain('loadskill');
  });

  it('serves full skill content through loadskill in the engine loop', async () => {
    const provider = new RecordingProvider([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', name: 'loadskill', arguments: '{"name":"writer"}' }] },
      { role: 'assistant', content: 'done' },
    ]);
    const engine = new AesyiuEngine().registerSkills(skills);
    const result = await engine.run({ role: 'user', content: 'help me write docs' }, createContext(provider));

    const toolMessage = result.messages.find((message) => message.role === 'tool');
    const payload = JSON.parse(toolMessage!.content!);

    expect(result.status).toBe('completed');
    expect(payload.success).toBe(true);
    expect(payload.result.metadata.description).toBe('Writing style guide');
    expect(payload.result.content).toContain('Full writer skill body');
  });

  it('returns a standard tool error for unknown skills', async () => {
    const provider = new RecordingProvider([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', name: 'loadskill', arguments: '{"name":"missing"}' }] },
      { role: 'assistant', content: 'done' },
    ]);
    const engine = new AesyiuEngine().registerSkills(skills);
    const result = await engine.run({ role: 'user', content: 'load a missing skill' }, createContext(provider));

    const toolMessage = result.messages.find((message) => message.role === 'tool');
    const payload = JSON.parse(toolMessage!.content!);

    expect(result.status).toBe('completed');
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('Skill "missing" not found');
  });
});
