import type { AgentContext } from '../context/index.js';
import { filterVisibleMessages } from '../context/index.js';
import { AesyiuProgrammingError, AesyiuRuntimeError, isRuntimeError } from '../error/index.js';
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
import type {
  AfterToolCallHook,
  AesyiuEngineConfig,
  BeforeLLMRequestHook,
  BeforeToolCallHook,
  EngineHooks,
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
  classifyAbortOrTimeout,
  composeUserMiddleware,
  consumeGenerator,
  getCauseString,
  getErrorMessage,
  getErrorSource,
  rethrowProgrammingError,
  runHooks,
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

function createErrorResult(
  ctx: AgentContext,
  error: unknown,
  fallbackSource: EngineErrorSource,
): EngineResult {
  const source = getErrorSource(error) ?? fallbackSource;
  const cause = getCauseString(isRuntimeError(error) ? error.cause : error);

  return {
    status: 'error',
    ...createResultBase(ctx),
    error: {
      message: getErrorMessage(error),
      source,
      ...(cause ? { cause } : {}),
    },
  };
}

export type {
  AfterToolCallHook,
  AfterToolCallHookContext,
  AesyiuEngineConfig,
  BeforeLLMRequestHook,
  BeforeLLMRequestHookContext,
  BeforeToolCallHook,
  BeforeToolCallHookContext,
  EngineHooks,
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
  private beforeLLMRequestHooks: BeforeLLMRequestHook[] = [];
  private beforeToolCallHooks: BeforeToolCallHook[] = [];
  private afterToolCallHooks: AfterToolCallHook[] = [];
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

  public useHooks(hooks: EngineHooks): this {
    if (hooks.beforeLLMRequest) {
      this.onBeforeLLMRequest(hooks.beforeLLMRequest);
    }
    if (hooks.beforeToolCall) {
      this.onBeforeToolCall(hooks.beforeToolCall);
    }
    if (hooks.afterToolCall) {
      this.onAfterToolCall(hooks.afterToolCall);
    }
    return this;
  }

  public onBeforeLLMRequest(hook: BeforeLLMRequestHook): this {
    this.beforeLLMRequestHooks.push(hook);
    return this;
  }

  public onBeforeToolCall(hook: BeforeToolCallHook): this {
    this.beforeToolCallHooks.push(hook);
    return this;
  }

  public onAfterToolCall(hook: AfterToolCallHook): this {
    this.afterToolCallHooks.push(hook);
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

  public async run(input: Message, ctx: AgentContext, options?: RunOptions): Promise<EngineResult> {
    const { availableTools, signal } = prepareRun(input, ctx, options, this.globalTools, this.registeredSkills);
    const runner = composeUserMiddleware(
      this.middlewares,
      (c) => consumeGenerator(this.coreReactLoop(c, availableTools, signal, false)),
    );
    return runner(ctx);
  }

  public async *runStream(
    input: Message,
    ctx: AgentContext,
    options?: RunOptions,
  ): AsyncGenerator<RunStreamEvent, EngineResult, void> {
    const { availableTools, signal } = prepareRun(input, ctx, options, this.globalTools, this.registeredSkills);
    return yield* runStreamWithMiddleware(
      ctx,
      this.middlewares,
      signal,
      (middlewareCtx, middlewareSignal) => this.coreReactLoop(middlewareCtx, availableTools, middlewareSignal, true),
    );
  }

  private async *coreReactLoop(
    ctx: AgentContext,
    availableTools: Map<string, Tool>,
    signal: AbortSignal | undefined,
    emitStream: boolean,
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
        if (emitStream) {
          const result = yield* this.streamLLMStep(ctx, outbound, tools, signal);
          assistantMessage = result.message;
          usage = result.usage;
        } else {
          const result = await this.llmStep(ctx, outbound, tools, signal);
          assistantMessage = result.message;
          usage = result.usage;
        }
      } catch (error) {
        rethrowProgrammingError(error);
        return createErrorResult(ctx, error, classifyAbortOrTimeout(error, signal) ?? 'provider');
      }

      ctx.addMessage(assistantMessage);
      yield { type: 'assistant_message', message: assistantMessage };

      try {
        await this.memoryManager.checkAndOptimize(
          ctx,
          usage,
          (msgs) => this.llmStep(ctx, msgs, [], signal),
        );
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
        return createErrorResult(ctx, error, classifyAbortOrTimeout(error, signal) ?? 'tool');
      }
      ctx.addMessages(toolResults);

      for (const result of toolResults) {
        yield { type: 'tool_result', message: result };
      }

      yield { type: 'step_end', step };
    }

    return createResult('max_steps_reached', ctx);
  }
  private async llmStep(
    ctx: AgentContext,
    messages: Message[],
    tools: Tool[],
    signal: AbortSignal | undefined,
  ): Promise<{ message: Message; usage: TokenUsage }> {
    const mwCtx = await runHooks(
      this.beforeLLMRequestHooks,
      createLLMMiddlewareContext(ctx, messages, tools, signal),
    );

    try {
      return await chainMiddleware(
        this.llmMiddlewares,
        mwCtx,
        () => ctx.activeProvider.generate(ctx.activeModel, mwCtx.messages, mwCtx.tools, mwCtx.options),
      );
    } catch (error) {
      rethrowProgrammingError(error);
      throw new AesyiuRuntimeError(classifyAbortOrTimeout(error, signal) ?? 'provider', error);
    }
  }

  private async *streamLLMStep(
    ctx: AgentContext,
    messages: Message[],
    tools: Tool[],
    signal: AbortSignal | undefined,
  ): AsyncGenerator<RunStreamEvent, { message: Message; usage: TokenUsage }, void> {
    const queue = new AsyncQueue<RunStreamEvent>();

    const collectStreamResult = async (): Promise<{ message: Message; usage: TokenUsage }> => {
      const mwCtx = await runHooks(
        this.beforeLLMRequestHooks,
        createLLMMiddlewareContext(ctx, messages, tools, signal),
      );

      try {
        return await chainMiddleware(
          this.llmMiddlewares,
          mwCtx,
          () => collectStreamedLLMResult(
            ctx.activeProvider.generateStream(
              ctx.activeModel,
              mwCtx.messages,
              mwCtx.tools,
              mwCtx.options,
            ),
            (event) => queue.push(event),
          ),
        );
      } catch (error) {
        rethrowProgrammingError(error);
        throw new AesyiuRuntimeError(classifyAbortOrTimeout(error, signal) ?? 'provider', error);
      } finally {
        queue.close();
      }
    };
    const resultPromise = collectStreamResult();

    for await (const event of queue.drain()) {
      yield event;
    }

    return await resultPromise;
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
      this.beforeToolCallHooks,
      this.afterToolCallHooks,
    );
  }
}
