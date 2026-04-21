import type { AgentContext } from '../context/index.js';
import { filterVisibleMessages } from '../context/index.js';
import { AesyiuProgrammingError } from '../error/index.js';
import type {
  EngineErrorSource,
  EngineResult,
  Message,
  Tool,
  TokenUsage,
  ToolCall,
  RunStreamEvent,
} from '../types/index.js';
import { MCPManager, type MCPServerConfig } from '../mcp/index.js';
import { MemoryManager } from '../memory/index.js';
import { createLoadSkillTool, type AgentSkill } from '../skill/index.js';
import { isZodSchema } from '../tool/schema.js';
import type {
  AesyiuEngineConfig,
  LLMMiddleware,
  LLMMiddlewareContext,
  Middleware,
  RunOptions,
  ToolMiddleware,
} from './types.js';
import { prepareOutboundMessages, prepareRun } from './preparation.js';
import { collectStreamedLLMResult, runStreamWithMiddleware } from './stream.js';
import { runToolCalls } from './tool-runner.js';
import {
  AsyncQueue,
  chainMiddleware,
  consumeGenerator,
  getErrorMessage,
  rethrowProgrammingError,
  runUserMiddleware,
} from './utils.js';

function createLLMMiddlewareContext(
  ctx: AgentContext,
  messages: Message[],
  tools: Tool[],
  signal: AbortSignal | undefined,
): LLMMiddlewareContext {
  return {
    model: ctx.activeModel,
    messages,
    tools,
    options: signal ? { signal } : {},
    agentContext: ctx,
  };
}

type LLMOperationResult = { message: Message; usage: TokenUsage };

function createResultBase(ctx: AgentContext): Pick<EngineResult, 'messages' | 'visibleMessages' | 'usage'> {
  const messages = [...ctx.messages];
  return {
    messages,
    visibleMessages: filterVisibleMessages(messages),
    usage: ctx.sessionUsage,
  };
}

function createResult(status: 'completed' | 'max_steps_reached', ctx: AgentContext): EngineResult {
  return {
    status,
    ...createResultBase(ctx),
  };
}

function getErrorSource(error: unknown, signal?: AbortSignal): EngineErrorSource {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  if (signal?.aborted && error === signal.reason) return 'aborted';
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  return 'unknown';
}

function createErrorResult(
  ctx: AgentContext,
  error: unknown,
  source: EngineErrorSource,
): EngineResult {
  return {
    status: 'error',
    ...createResultBase(ctx),
    error: {
      message: getErrorMessage(error),
      source,
    },
  };
}

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
  private globalTools: Map<string, Tool> = new Map();
  private mcpTools: Map<string, Tool> = new Map();
  private middlewares: Middleware[] = [];
  private llmMiddlewares: LLMMiddleware[] = [];
  private toolMiddlewares: ToolMiddleware[] = [];
  private maxSteps: number;
  private mcpManager: MCPManager;
  private memoryManager: MemoryManager;
  private registeredSkills: AgentSkill[] = [];
  private compatibilityMode: boolean;

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
    if (tool.parameters && !isZodSchema(tool.parameters)) {
      console.warn(
        `[aesyiu] tool "${tool.name}" uses a JSON schema; arguments pass through unvalidated. ` +
        'Provide a Zod schema to enable runtime validation.',
      );
    }
    this.globalTools.set(tool.name, tool);
    return this;
  }

  public getTools(): Tool[] {
    return Array.from(this.globalTools.values());
  }

  public registerSkills(skills: AgentSkill[]): this {
    if (skills.length === 0) {
      if (this.registeredSkills.length > 0) {
        this.globalTools.delete('loadskill');
        this.registeredSkills = [];
      }
      return this;
    }

    if (this.globalTools.has('loadskill') && this.registeredSkills.length === 0) {
      throw new AesyiuProgrammingError('Tool "loadskill" is already registered by external code; cannot install skill loader');
    }

    this.registeredSkills = [...skills];
    this.globalTools.set('loadskill', createLoadSkillTool(this.registeredSkills));
    return this;
  }

  public async registerMCPServer(config: MCPServerConfig): Promise<this> {
    const tools = await this.mcpManager.registerServer(config);

    for (const tool of tools) {
      this.globalTools.set(tool.name, tool);
      this.mcpTools.set(tool.name, tool);
    }

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

    for (const toolName of toolNames) {
      const recorded = this.mcpTools.get(toolName);
      this.mcpTools.delete(toolName);
      if (recorded && this.globalTools.get(toolName) === recorded) {
        this.globalTools.delete(toolName);
      }
    }

    return this;
  }

  public getMCPManager(): MCPManager {
    return this.mcpManager;
  }

  public async dispose(): Promise<void> {
    await this.mcpManager.dispose();

    for (const [toolName, recorded] of this.mcpTools) {
      if (this.globalTools.get(toolName) === recorded) {
        this.globalTools.delete(toolName);
      }
    }

    this.mcpTools.clear();
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  private prepareExecution(input: Message, ctx: AgentContext, options?: RunOptions) {
    return prepareRun(input, ctx, options, this.globalTools, this.registeredSkills);
  }

  public async run(input: Message, ctx: AgentContext, options?: RunOptions): Promise<EngineResult> {
    const { availableTools, signal } = this.prepareExecution(input, ctx, options);
    return runUserMiddleware(
      this.middlewares,
      ctx,
      () => consumeGenerator(this.coreReactLoop(ctx, availableTools, signal)),
    );
  }

  public async *runStream(
    input: Message,
    ctx: AgentContext,
    options?: RunOptions,
  ): AsyncGenerator<RunStreamEvent, EngineResult, void> {
    const { availableTools, signal } = this.prepareExecution(input, ctx, options);
    return yield* runStreamWithMiddleware(
      ctx,
      this.middlewares,
      signal,
      (middlewareCtx, middlewareSignal) => this.coreReactLoop(middlewareCtx, availableTools, middlewareSignal),
    );
  }

  private async *coreReactLoop(
    ctx: AgentContext,
    availableTools: Map<string, Tool>,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<RunStreamEvent, EngineResult, void> {
    const tools = Array.from(availableTools.values());
    let step = 0;

    while (step < this.maxSteps) {
      step++;

      if (signal?.aborted) {
        const reason = signal.reason;
        const abortError = reason instanceof Error
          ? reason
          : new Error(typeof reason === 'string' ? reason : 'Run aborted');
        return createErrorResult(ctx, abortError, 'aborted');
      }

      yield { type: 'step_start', step };

      let assistantMessage: Message;
      let usage: TokenUsage;
      try {
        const outbound = prepareOutboundMessages([...ctx.messages], this.compatibilityMode);
        const result = yield* this.streamLLMStep(ctx, outbound, tools, signal);
        assistantMessage = result.message;
        usage = result.usage;
      } catch (error) {
        rethrowProgrammingError(error);
        return createErrorResult(ctx, error, getErrorSource(error, signal) ?? 'provider');
      }

      ctx.addMessage(assistantMessage);
      yield { type: 'assistant_message', message: assistantMessage };

      try {
        await this.memoryManager.checkAndOptimize(ctx, usage);
      } catch (error) {
        rethrowProgrammingError(error);
        return createErrorResult(ctx, error, 'memory');
      }

      if (!assistantMessage.tool_calls?.length) {
        yield { type: 'step_end', step };
        return createResult('completed', ctx);
      }

      for (const toolCall of assistantMessage.tool_calls) {
        yield { type: 'tool_call', toolCall };
      }

      let toolResults: Message[];
      try {
        toolResults = await this.runTools(assistantMessage.tool_calls, availableTools, ctx, signal);
      } catch (error) {
        rethrowProgrammingError(error);
        return createErrorResult(ctx, error, getErrorSource(error, signal) ?? 'tool');
      }
      ctx.addMessages(toolResults);

      for (const result of toolResults) {
        yield { type: 'tool_result', message: result };
      }

      yield { type: 'step_end', step };
    }

    return createResult('max_steps_reached', ctx);
  }

  private async *streamLLMStep(
    ctx: AgentContext,
    messages: Message[],
    tools: Tool[],
    signal: AbortSignal | undefined,
  ): AsyncGenerator<RunStreamEvent, LLMOperationResult, void> {
    const queue = new AsyncQueue<RunStreamEvent>();
    const resultPromise = this.executeLLMOperation(ctx, messages, tools, signal, (mwCtx) =>
      collectStreamedLLMResult(
        ctx.activeProvider.generateStream(
          ctx.activeModel,
          mwCtx.messages,
          mwCtx.tools,
          mwCtx.options,
        ),
        (event) => queue.push(event),
      ),
    ).finally(() => {
      queue.close();
    });

    for await (const event of queue.drain()) {
      yield event;
    }

    return await resultPromise;
  }

  private async executeLLMOperation(
    ctx: AgentContext,
    messages: Message[],
    tools: Tool[],
    signal: AbortSignal | undefined,
    operation: (mwCtx: LLMMiddlewareContext) => Promise<LLMOperationResult>,
  ): Promise<LLMOperationResult> {
    const mwCtx = createLLMMiddlewareContext(ctx, messages, tools, signal);

    try {
      return await chainMiddleware(
        this.llmMiddlewares,
        mwCtx,
        () => operation(mwCtx),
      );
    } catch (error) {
      rethrowProgrammingError(error);
      throw error;
    }
  }

  private async runTools(
    toolCalls: ToolCall[],
    availableTools: Map<string, Tool>,
    ctx: AgentContext,
    signal: AbortSignal | undefined,
  ): Promise<Message[]> {
    return runToolCalls(
      toolCalls,
      availableTools,
      ctx,
      signal,
      this.toolMiddlewares,
    );
  }
}
