import type { AgentContext } from '../context/index.js';
import type { Message, Tool, EngineResult, TokenUsage } from '../types/index.js';
import { MCPManager, type MCPServerConfig } from '../mcp/index.js';
import { MemoryManager } from '../memory/index.js';
import { createLoadSkillTool, createSkillsPromptMessage, type AgentSkill } from '../skill/index.js';
import { ToolExecutor } from '../tool/index.js';

export type Middleware = (ctx: AgentContext, next: () => Promise<void>) => Promise<void>;

export interface AesyiuEngineConfig {
  maxSteps?: number;
  memoryManager?: MemoryManager;
}

function compose(middlewares: Middleware[], core: (ctx: AgentContext) => Promise<EngineResult>): (ctx: AgentContext) => Promise<EngineResult> {
  if (middlewares.length === 0) {
    return core;
  }

  return async (ctx: AgentContext): Promise<EngineResult> => {
    let index = -1;
    let result: EngineResult | undefined;

    async function dispatch(i: number): Promise<void> {
      if (i <= index) {
        throw new Error('next() called multiple times');
      }
      index = i;

      if (i < middlewares.length) {
        const middleware = middlewares[i];
        await middleware(ctx, async () => {
          await dispatch(i + 1);
        });
      } else {
        result = await core(ctx);
      }
    }

    await dispatch(0);
    return result!;
  };
}

export class AesyiuEngine {
  private globalTools: Map<string, Tool> = new Map();
  private mcpToolNames: Set<string> = new Set();
  private middlewares: Middleware[] = [];
  private maxSteps: number;
  private mcpManager: MCPManager;
  private memoryManager: MemoryManager;
  private registeredSkills: AgentSkill[] = [];

  constructor(config?: AesyiuEngineConfig) {
    this.maxSteps = config?.maxSteps ?? 10;
    this.mcpManager = new MCPManager();
    this.memoryManager = config?.memoryManager ?? new MemoryManager({
      compressThresholdRatio: 0.8,
      retainLatestMessages: 5,
    });
  }

  public use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  public registerTool(tool: Tool): this {
    this.globalTools.set(tool.name, tool);
    return this;
  }

  public registerSkills(skills: AgentSkill[]): this {
    if (skills.length === 0) {
      this.registeredSkills = [];
      this.globalTools.delete('loadskill');
      return this;
    }

    if (this.globalTools.has('loadskill') && this.registeredSkills.length === 0) {
      throw new Error('Tool "loadskill" is already registered');
    }

    this.registeredSkills = [...skills];
    this.globalTools.set('loadskill', createLoadSkillTool(this.registeredSkills));
    return this;
  }

  public async registerMCPServer(config: MCPServerConfig): Promise<this> {
    const tools = await this.mcpManager.registerServer(config);

    for (const tool of tools) {
      this.globalTools.set(tool.name, tool);
      this.mcpToolNames.add(tool.name);
    }

    return this;
  }

  public async registerMCPServers(configs: MCPServerConfig[]): Promise<this> {
    for (const config of configs) {
      await this.registerMCPServer(config);
    }

    return this;
  }

  public async dispose(): Promise<void> {
    await this.mcpManager.dispose();

    for (const toolName of this.mcpToolNames) {
      this.globalTools.delete(toolName);
    }

    this.mcpToolNames.clear();
  }

  public async run(input: Message, ctx: AgentContext): Promise<EngineResult> {
    this.injectSkillPrompt(ctx);
    ctx.messages.push(input);

    const chain = compose(this.middlewares, (c) => this._reactLoop(c));
    return chain(ctx);
  }

  private async _reactLoop(ctx: AgentContext): Promise<EngineResult> {
    let step = 0;

    while (step < this.maxSteps) {
      step++;

      try {
        const { message, usage } = await ctx.activeProvider.generate(
          ctx.activeModel,
          ctx.messages,
          Array.from(this.globalTools.values()),
        );
        ctx.messages.push(message);

        await this.memoryManager.checkAndOptimize(ctx, usage);

        if (!message.tool_calls || message.tool_calls.length === 0) {
          return { status: 'completed', messages: ctx.messages, usage: ctx.sessionUsage };
        }

        const toolResults = await ToolExecutor.executeCalls(
          message.tool_calls,
          this.globalTools,
          ctx,
        );
        ctx.messages.push(...toolResults);
      } catch (err) {
        return { status: 'error', messages: ctx.messages, usage: ctx.sessionUsage };
      }
    }

    return { status: 'max_steps_reached', messages: ctx.messages, usage: ctx.sessionUsage };
  }

  private injectSkillPrompt(ctx: AgentContext): void {
    const promptMessage = createSkillsPromptMessage(this.registeredSkills);
    if (!promptMessage) {
      return;
    }

    const existingPromptIndex = ctx.messages.findIndex((message) => message._meta?.skillPrompt);
    if (existingPromptIndex >= 0) {
      ctx.messages[existingPromptIndex] = promptMessage;
      return;
    }

    const insertIndex = ctx.messages.findIndex((message) => message.role !== 'system');
    if (insertIndex === -1) {
      ctx.messages.push(promptMessage);
      return;
    }

    ctx.messages.splice(insertIndex, 0, promptMessage);
  }
}
