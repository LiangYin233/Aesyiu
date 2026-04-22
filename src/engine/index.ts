import type { AgentContext } from '../context/index.js';
import { AesyiuProgrammingError } from '../error/index.js';
import type { EngineResult, Message, RunStreamEvent, Tool } from '../types/index.js';
import { MCPManager, type MCPServerConfig } from '../mcp/index.js';
import { MemoryManager } from '../memory/index.js';
import { createLoadSkillTool, type AgentSkill } from '../skill/index.js';
import type { AesyiuEngineConfig, LLMMiddleware, Middleware, RunOptions, ToolMiddleware } from './types.js';
import { ExecutionLoop } from './execution-loop.js';
import { prepareRun } from './preparation.js';
import { chainMiddleware, consumeGenerator } from './utils.js';
import { ToolRegistry } from '../tool/registry.js';

export type {
  AesyiuEngineConfig,
  LLMMiddleware,
  LLMMiddlewareContext,
  Middleware,
  RunOptions,
  ToolMiddleware,
  ToolMiddlewareContext,
} from './types.js';
export { isAbortError } from './utils.js';

export class AesyiuEngine {
  private toolRegistry = new ToolRegistry();
  private maxSteps: number;
  private mcpManager: MCPManager;
  private memoryManager: MemoryManager;
  private registeredSkills: AgentSkill[] = [];
  private compatibilityMode: boolean;
  private middlewares: Middleware[] = [];
  private llmMiddlewares: LLMMiddleware[] = [];
  private toolMiddlewares: ToolMiddleware[] = [];

  constructor(config?: AesyiuEngineConfig) {
    if (config?.memoryManager && config.memoryConfig) {
      throw new AesyiuProgrammingError('Provide either memoryManager or memoryConfig, not both');
    }
    this.maxSteps = config?.maxSteps ?? 10;
    this.mcpManager = new MCPManager();
    this.memoryManager = config?.memoryManager ?? new MemoryManager(config?.memoryConfig);
    this.compatibilityMode = config?.compatibilityMode ?? false;
  }

  public use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  public useLLM(middleware: LLMMiddleware): this {
    this.llmMiddlewares.push(middleware);
    return this;
  }

  public useTool(middleware: ToolMiddleware): this {
    this.toolMiddlewares.push(middleware);
    return this;
  }

  public registerTool(tool: Tool): this {
    this.toolRegistry.register(tool);
    return this;
  }

  public getTools(): Tool[] {
    return this.toolRegistry.getTools();
  }

  public registerSkills(skills: AgentSkill[]): this {
    if (skills.length === 0) {
      if (this.registeredSkills.length > 0) {
        this.toolRegistry.delete('loadskill');
        this.registeredSkills = [];
      }
      return this;
    }

    if (this.toolRegistry.has('loadskill') && this.registeredSkills.length === 0) {
      throw new AesyiuProgrammingError('Tool "loadskill" is already registered by external code; cannot install skill loader');
    }

    this.registeredSkills = [...skills];
    this.toolRegistry.register(createLoadSkillTool(this.registeredSkills));
    return this;
  }

  public async registerMCPServer(config: MCPServerConfig): Promise<this> {
    const tools = await this.mcpManager.registerServer(config);
    this.toolRegistry.registerMCP(tools);
    return this;
  }

  public async registerMCPServers(configs: MCPServerConfig[]): Promise<this> {
    const registered: string[] = [];
    try {
      for (const config of configs) {
        await this.registerMCPServer(config);
        registered.push(config.name);
      }
    } catch (error) {
      for (const name of registered) {
        await this.unregisterMCPServer(name).catch(() => {});
      }
      throw error;
    }

    return this;
  }

  public async unregisterMCPServer(name: string): Promise<this> {
    const toolNames = await this.mcpManager.unregisterServer(name);
    this.toolRegistry.unregisterMCPTools(toolNames);
    return this;
  }

  public getMCPManager(): MCPManager {
    return this.mcpManager;
  }

  public async dispose(): Promise<void> {
    try {
      await this.mcpManager.dispose();
    } finally {
      this.toolRegistry.clear();
    }
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  private prepareExecution(input: Message, ctx: AgentContext, options?: RunOptions) {
    return prepareRun(input, ctx, options, this.toolRegistry.getAll(), this.registeredSkills);
  }

  private createLoop(): ExecutionLoop {
    return new ExecutionLoop({
      maxSteps: this.maxSteps,
      compatibilityMode: this.compatibilityMode,
      memoryManager: this.memoryManager,
    });
  }

  private createRunGenerator(
    input: Message,
    ctx: AgentContext,
    options: RunOptions | undefined,
    streamOutput: boolean,
  ): AsyncGenerator<RunStreamEvent, EngineResult, void> {
    const { availableTools, signal } = this.prepareExecution(input, ctx, options);
    const loop = this.createLoop();
    return chainMiddleware(
      this.middlewares,
      ctx,
      () => loop.run(ctx, availableTools, {
        signal,
        streamOutput,
        llmMiddlewares: this.llmMiddlewares,
        toolMiddlewares: this.toolMiddlewares,
      }),
    );
  }

  public async run(input: Message, ctx: AgentContext, options?: RunOptions): Promise<EngineResult> {
    return consumeGenerator(this.createRunGenerator(input, ctx, options, false));
  }

  public async *runStream(
    input: Message,
    ctx: AgentContext,
    options?: RunOptions,
  ): AsyncGenerator<RunStreamEvent, EngineResult, void> {
    return yield* this.createRunGenerator(input, ctx, options, true);
  }
}
