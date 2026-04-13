import type { AgentContext } from '../context/index.js';
import type { Message, Tool, EngineErrorSource, EngineResult } from '../types/index.js';
import { MCPManager, type MCPServerConfig } from '../mcp/index.js';
import { MemoryManager } from '../memory/index.js';
import { createLoadSkillTool, createSkillsPromptMessage, type AgentSkill } from '../skill/index.js';
import { ToolExecutor } from '../tool/index.js';

export type Middleware = (ctx: AgentContext, next: () => Promise<void>) => Promise<void>;

export interface AesyiuEngineConfig {
  maxSteps?: number;
  memoryManager?: MemoryManager;
  compatibilityMode?: boolean;
}

export interface RunOptions {
  tools?: string[];
  skills?: string[];
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isEngineErrorSource(value: unknown): value is EngineErrorSource {
  return value === 'provider' || value === 'memory' || value === 'tool' || value === 'engine' || value === 'unknown';
}

function getErrorSource(error: unknown): EngineErrorSource | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  return isEngineErrorSource(error.cause) ? error.cause : undefined;
}

export class AesyiuEngine {
  private globalTools: Map<string, Tool> = new Map();
  private mcpToolNames: Set<string> = new Set();
  private middlewares: Middleware[] = [];
  private maxSteps: number;
  private mcpManager: MCPManager;
  private memoryManager: MemoryManager;
  private registeredSkills: AgentSkill[] = [];
  private compatibilityMode: boolean;

  constructor(config?: AesyiuEngineConfig) {
    this.maxSteps = config?.maxSteps ?? 10;
    this.mcpManager = new MCPManager();
    this.memoryManager = config?.memoryManager ?? new MemoryManager({
      compressThresholdRatio: 0.8,
      retainLatestMessages: 5,
    });
    this.compatibilityMode = config?.compatibilityMode ?? false;
  }

  public use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  public registerTool(tool: Tool): this {
    this.globalTools.set(tool.name, tool);
    return this;
  }

  public getTools(): Tool[] {
    return Array.from(this.globalTools.values());
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

  public async run(input: Message, ctx: AgentContext, options?: RunOptions): Promise<EngineResult> {
    const availableTools = this.resolveRunTools(options);
    const visibleSkills = this.resolveRunSkills(options);
    this.injectSkillPrompt(ctx, visibleSkills);
    ctx.addMessage(input);

    const chain = compose(this.middlewares, (c) => this._reactLoop(c, availableTools));
    return chain(ctx);
  }

  private async _reactLoop(ctx: AgentContext, availableTools: Map<string, Tool>): Promise<EngineResult> {
    let step = 0;

    while (step < this.maxSteps) {
      step++;

      try {
        const outboundMessages = this.prepareOutboundMessages(ctx.getMessages());
        const { message, usage } = await this.runProvider(ctx, outboundMessages, availableTools);
        ctx.addMessage(message);

        try {
          await this.memoryManager.checkAndOptimize(ctx, usage);
        } catch (error) {
          return this.createErrorResult(ctx, error, 'memory');
        }

        if (!message.tool_calls || message.tool_calls.length === 0) {
          return { status: 'completed', messages: ctx.messages, usage: ctx.sessionUsage };
        }

        const toolResults = await this.runTools(message.tool_calls, availableTools, ctx);
        ctx.addMessages(toolResults);
      } catch (error) {
        return this.createErrorResult(ctx, error, 'engine');
      }
    }

    return { status: 'max_steps_reached', messages: ctx.messages, usage: ctx.sessionUsage };
  }

  private async runProvider(ctx: AgentContext, messages: Message[], availableTools: Map<string, Tool>): Promise<{ message: Message; usage: EngineResult['usage'] }> {
    try {
      return await ctx.activeProvider.generate(
        ctx.activeModel,
        messages,
        Array.from(availableTools.values()),
      );
    } catch (error) {
      throw this.createDiagnosticError('provider', error);
    }
  }

  private async runTools(toolCalls: Message['tool_calls'], availableTools: Map<string, Tool>, ctx: AgentContext) {
    try {
      return await ToolExecutor.executeCalls(toolCalls ?? [], availableTools, ctx);
    } catch (error) {
      throw this.createDiagnosticError('tool', error);
    }
  }

  private createDiagnosticError(source: EngineErrorSource, error: unknown): Error {
    return new Error(getErrorMessage(error), { cause: source });
  }

  private createErrorResult(ctx: AgentContext, error: unknown, fallbackSource: EngineErrorSource): EngineResult {
    const source = getErrorSource(error) ?? fallbackSource;

    return {
      status: 'error',
      messages: ctx.messages,
      usage: ctx.sessionUsage,
      error: {
        message: getErrorMessage(error),
        source,
      },
    };
  }

  private resolveRunTools(options?: RunOptions): Map<string, Tool> {
    if (!options?.tools) {
      return new Map(this.globalTools);
    }

    const availableTools = new Map<string, Tool>();
    for (const toolName of options.tools) {
      const tool = this.globalTools.get(toolName);
      if (!tool) {
        throw new Error(`Tool "${toolName}" is not registered`);
      }

      availableTools.set(toolName, tool);
    }

    return availableTools;
  }

  private resolveRunSkills(options?: RunOptions): AgentSkill[] {
    if (!options?.skills) {
      return [...this.registeredSkills];
    }

    const skillIndex = new Map(this.registeredSkills.map((skill) => [skill.name, skill]));
    return options.skills.map((skillName) => {
      const skill = skillIndex.get(skillName);
      if (!skill) {
        throw new Error(`Skill "${skillName}" is not registered`);
      }

      return skill;
    });
  }

  private prepareOutboundMessages(messages: Message[]): Message[] {
    if (!this.compatibilityMode) {
      return messages;
    }

    const systemMessages = messages.filter((message) => message.role === 'system');
    if (systemMessages.length <= 1) {
      return messages;
    }

    const mergedSystemMessage: Message = {
      role: 'system',
      content: systemMessages.map((message) => message.content ?? '').join('\n\n'),
    };

    return [mergedSystemMessage, ...messages.filter((message) => message.role !== 'system')];
  }

  private injectSkillPrompt(ctx: AgentContext, skills: readonly AgentSkill[]): void {
    const promptMessage = createSkillsPromptMessage(skills);
    if (!promptMessage) {
      ctx.removeMessages((message) => message._meta?.skillPrompt === true);
      return;
    }

    const existingPrompt = ctx.getMessages().find((message) => message._meta?.skillPrompt);
    if (existingPrompt?.id) {
      ctx.setMessage(existingPrompt.id, {
        content: promptMessage.content,
        tool_calls: promptMessage.tool_calls,
        tool_call_id: promptMessage.tool_call_id,
        _meta: promptMessage._meta,
      });
      return;
    }

    if (existingPrompt) {
      ctx.removeMessages((message) => message._meta?.skillPrompt === true);
    }

    ctx.addMessage(promptMessage);
  }
}
