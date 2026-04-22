import type { AgentContext } from '../context/index.js';
import { AesyiuProgrammingError } from '../error/index.js';
import type {
  EngineErrorSource,
  EngineResult,
  Message,
  RunStreamEvent,
  Tool,
  TokenUsage,
  ToolCall,
} from '../types/index.js';
import { MCPManager, type MCPServerConfig } from '../mcp/index.js';
import { MemoryManager } from '../memory/index.js';
import { createLoadSkillTool, type AgentSkill } from '../skill/index.js';
import type {
  AesyiuEngineConfig,
  LLMMiddleware,
  LLMMiddlewareContext,
  Middleware,
  RunOptions,
  ToolMiddleware,
} from './types.js';
import { prepareOutboundMessages, prepareRun } from './preparation.js';
import {
  chainMiddleware,
  classifyError,
  combineAbortSignals,
  consumeGenerator,
  getErrorMessage,
  rethrowProgrammingError,
} from './utils.js';
import { runToolCalls } from '../tool/runner.js';
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

  private async *runExecutionLoop(
    ctx: AgentContext,
    tools: Map<string, Tool>,
    options: {
      signal?: AbortSignal;
      streamOutput: boolean;
      llmMiddlewares: LLMMiddleware[];
      toolMiddlewares: ToolMiddleware[];
    },
  ): AsyncGenerator<RunStreamEvent, EngineResult, void> {
    const toolList = Array.from(tools.values());
    let step = 0;

    while (step < this.maxSteps) {
      step++;

      if (options.signal?.aborted) {
        const reason = options.signal.reason;
        const abortError = reason instanceof Error
          ? reason
          : new Error(typeof reason === 'string' ? reason : 'Run aborted');
        return this.createErrorResult(ctx, abortError, 'aborted');
      }

      yield { type: 'step_start', step };

      let assistantMessage: Message;
      let usage: TokenUsage;
      try {
        const outbound = prepareOutboundMessages([...ctx.messages], this.compatibilityMode);
        const result = yield* this.streamLLMStep(
          ctx,
          outbound,
          toolList,
          options.llmMiddlewares,
          options.streamOutput,
          options.signal,
        );
        assistantMessage = result.message;
        usage = result.usage;
      } catch (error) {
        return this.handleStepError(ctx, error, options.signal, 'provider');
      }

      ctx.addMessage(assistantMessage);
      yield { type: 'assistant_message', message: assistantMessage };

      try {
        await this.memoryManager.checkAndOptimize(ctx, usage, options.signal);
      } catch (error) {
        return this.handleStepError(ctx, error, options.signal, 'memory');
      }

      if (!assistantMessage.tool_calls?.length) {
        yield { type: 'step_end', step };
        return this.createResult('completed', ctx);
      }

      for (const toolCall of assistantMessage.tool_calls) {
        yield { type: 'tool_call', toolCall };
      }

      let toolResults: Message[];
      try {
        toolResults = await runToolCalls(
          assistantMessage.tool_calls,
          tools,
          ctx,
          options.signal,
          options.toolMiddlewares,
        );
      } catch (error) {
        return this.handleStepError(ctx, error, options.signal, 'tool');
      }
      ctx.addMessages(toolResults);

      try {
        await this.memoryManager.optimizeIfNeeded(ctx, undefined, options.signal);
      } catch (error) {
        return this.handleStepError(ctx, error, options.signal, 'memory');
      }

      for (const result of toolResults) {
        yield { type: 'tool_result', message: result };
      }

      yield { type: 'step_end', step };
    }

    return this.createResult('max_steps_reached', ctx);
  }

  private async *streamLLMStep(
    ctx: AgentContext,
    messages: Message[],
    tools: Tool[],
    llmMiddlewares: LLMMiddleware[],
    streamOutput: boolean,
    signal?: AbortSignal,
  ): AsyncGenerator<RunStreamEvent, { message: Message; usage: TokenUsage }, void> {
    const internalAbort = new AbortController();
    const opts = { signal: combineAbortSignals(signal, internalAbort.signal) };

    const middlewareContext: LLMMiddlewareContext = {
      model: ctx.activeModel,
      messages: [...messages],
      tools: [...tools],
      options: opts,
      agentContext: ctx,
      streamOutput,
      responseStarted: false,
    };

    try {
      return yield* chainMiddleware(llmMiddlewares, middlewareContext, async function* llmCore() {
        const stream = await ctx.activeProvider.generateStream(
          ctx.activeModel,
          messages,
          tools,
          opts,
        );
        let content = '';
        let toolCalls: ToolCall[] | undefined;
        let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        for await (const event of stream) {
          switch (event.type) {
            case 'response_started':
              middlewareContext.responseStarted = true;
              break;
            case 'text':
              content += event.delta;
              if (streamOutput) {
                yield { type: 'text_delta', delta: event.delta, content: event.content };
              }
              break;
            case 'tool_calls':
              toolCalls = event.toolCalls;
              break;
            case 'usage':
              usage = event.usage;
              break;
          }
        }
        return {
          message: {
            role: 'assistant',
            content: content || null,
            ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          usage,
        };
      });
    } finally {
      internalAbort.abort();
    }
  }

  private createResultBase(ctx: AgentContext): Pick<EngineResult, 'messages' | 'usage'> {
    return {
      messages: [...ctx.messages],
      usage: { ...ctx.sessionUsage },
    };
  }

  private createResult(status: 'completed' | 'max_steps_reached', ctx: AgentContext): EngineResult {
    return { status, ...this.createResultBase(ctx) };
  }

  private createErrorResult(ctx: AgentContext, error: unknown, source: EngineErrorSource): EngineResult {
    return {
      status: 'error',
      ...this.createResultBase(ctx),
      error: { message: getErrorMessage(error), source },
    };
  }

  private handleStepError(ctx: AgentContext, error: unknown, signal: AbortSignal | undefined, fallbackSource: EngineErrorSource): EngineResult {
    rethrowProgrammingError(error);
    return this.createErrorResult(ctx, error, classifyError(error, signal) ?? fallbackSource);
  }

  private createRunGenerator(
    input: Message,
    ctx: AgentContext,
    options: RunOptions | undefined,
    streamOutput: boolean,
  ): AsyncGenerator<RunStreamEvent, EngineResult, void> {
    const { availableTools, signal } = prepareRun(input, ctx, options, this.toolRegistry.getAll(), this.registeredSkills);
    return chainMiddleware(
      this.middlewares,
      ctx,
      () => this.runExecutionLoop(ctx, availableTools, {
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
