import type { AgentContext } from '../context/index.js';
import { filterVisibleMessages } from '../context/index.js';
import type {
  Message,
  ModelDefinition,
  Tool,
  TokenUsage,
  ToolCall,
  EngineErrorSource,
  EngineResult,
  RunStreamEvent,
} from '../types/index.js';
import { MCPManager, type MCPServerConfig } from '../mcp/index.js';
import { MemoryManager, type MemoryManagerConfig } from '../memory/index.js';
import { createLoadSkillTool, renderSkillsPrompt, type AgentSkill } from '../skill/index.js';
import type { GenerateOptions } from '../provider/index.js';
import { encodeToolResultEnvelope, validateToolArguments, warnIfJSONSchemaTool } from '../tool/schema.js';

export { filterVisibleMessages } from '../context/index.js';

export type Middleware = (ctx: AgentContext, next: () => Promise<void>) => Promise<void>;

export interface LLMMiddlewareContext {
  readonly model: ModelDefinition;
  readonly messages: Message[];
  readonly tools: Tool[];
  options: GenerateOptions;
  readonly agentContext: AgentContext;
}

export type LLMMiddleware = (
  ctx: LLMMiddlewareContext,
  next: () => Promise<{ message: Message; usage: TokenUsage }>,
) => Promise<{ message: Message; usage: TokenUsage }>;

export interface ToolMiddlewareContext {
  readonly tool: Tool;
  readonly toolCall: ToolCall;
  args: unknown;
  readonly agentContext: AgentContext;
}

export type ToolMiddleware = (
  ctx: ToolMiddlewareContext,
  next: () => Promise<unknown>,
) => Promise<unknown>;

export interface BeforeLLMRequestHookContext {
  readonly model: ModelDefinition;
  messages: Message[];
  tools: Tool[];
  options: GenerateOptions;
  readonly agentContext: AgentContext;
}

export type BeforeLLMRequestHook = (
  ctx: BeforeLLMRequestHookContext,
) => void | Promise<void>;

export interface BeforeToolCallHookContext {
  readonly tool: Tool;
  readonly toolCall: ToolCall;
  args: unknown;
  readonly agentContext: AgentContext;
}

export type BeforeToolCallHook = (
  ctx: BeforeToolCallHookContext,
) => void | Promise<void>;

export interface AfterToolCallHookContext {
  readonly tool: Tool;
  readonly toolCall: ToolCall;
  readonly args: unknown;
  result: unknown;
  readonly agentContext: AgentContext;
}

export type AfterToolCallHook = (
  ctx: AfterToolCallHookContext,
) => void | Promise<void>;

export interface EngineHooks {
  beforeLLMRequest?: BeforeLLMRequestHook;
  beforeToolCall?: BeforeToolCallHook;
  afterToolCall?: AfterToolCallHook;
}

export interface AesyiuEngineConfig {
  maxSteps?: number;
  memoryManager?: MemoryManager;
  memoryConfig?: MemoryManagerConfig;
  compatibilityMode?: boolean;
}

export interface RunOptions {
  tools?: string[];
  skills?: string[];
  signal?: AbortSignal;
}

const SKILL_PROMPT_SECTION = 'aesyiu:skills';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getCauseString(error: unknown): string | undefined {
  if (error instanceof Error) return error.stack ?? error.message;
  return error !== undefined ? String(error) : undefined;
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    if (error === signal.reason) return true;
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  }
  return false;
}

class EngineDiagnosticError extends Error {
  public readonly source: EngineErrorSource;

  constructor(source: EngineErrorSource, cause: unknown) {
    super(getErrorMessage(cause), { cause });
    this.name = 'EngineDiagnosticError';
    this.source = source;
  }
}

function getErrorSource(error: unknown): EngineErrorSource | undefined {
  return error instanceof EngineDiagnosticError ? error.source : undefined;
}

async function chainMiddleware<TCtx, TResult>(
  middlewares: ReadonlyArray<(ctx: TCtx, next: () => Promise<TResult>) => Promise<TResult>>,
  ctx: TCtx,
  core: () => Promise<TResult>,
): Promise<TResult> {
  if (middlewares.length === 0) return core();

  let index = -1;
  const dispatch = (i: number): Promise<TResult> => {
    if (i <= index) {
      return Promise.reject(new Error('middleware next() called multiple times'));
    }
    index = i;
    if (i >= middlewares.length) return core();
    return middlewares[i](ctx, () => dispatch(i + 1));
  };
  return dispatch(0);
}

function composeUserMiddleware(
  middlewares: Middleware[],
  core: (ctx: AgentContext) => Promise<EngineResult>,
): (ctx: AgentContext) => Promise<EngineResult> {
  if (middlewares.length === 0) return core;

  return async (ctx) => {
    let result: EngineResult | undefined;
    let index = -1;

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) throw new Error('next() called multiple times');
      index = i;
      if (i < middlewares.length) {
        await middlewares[i](ctx, () => dispatch(i + 1));
      } else {
        result = await core(ctx);
      }
    };

    await dispatch(0);
    return result!;
  };
}

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(v: IteratorResult<T, void>) => void> = [];
  private closed = false;

  public push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  public close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined, done: true });
    }
  }

  public async *drain(): AsyncGenerator<T, void, void> {
    while (true) {
      const buffered = this.items.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T, void>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }
}

export class AesyiuEngine {
  private globalTools: Map<string, Tool> = new Map();
  private mcpToolNames: Set<string> = new Set();
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
    return this.globalTools.values().toArray();
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
      throw new Error('Tool "loadskill" is already registered by external code; cannot install skill loader');
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

  public async unregisterMCPServer(name: string): Promise<this> {
    const toolNames = await this.mcpManager.unregisterServer(name);

    for (const toolName of toolNames) {
      this.globalTools.delete(toolName);
      this.mcpToolNames.delete(toolName);
    }

    return this;
  }

  public getMCPManager(): MCPManager {
    return this.mcpManager;
  }

  public async dispose(): Promise<void> {
    await this.mcpManager.dispose();

    for (const toolName of this.mcpToolNames) {
      this.globalTools.delete(toolName);
    }

    this.mcpToolNames.clear();
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  public async run(input: Message, ctx: AgentContext, options?: RunOptions): Promise<EngineResult> {
    this.prepareRun(input, ctx, options);

    const availableTools = this.resolveRunTools(options);
    const signal = options?.signal;

    const runner = composeUserMiddleware(this.middlewares, async (c) => {
      const gen = this.coreReactLoop(c, availableTools, signal, false);
      while (true) {
        const n = await gen.next();
        if (n.done) return n.value;
      }
    });
    return runner(ctx);
  }

  public async *runStream(
    input: Message,
    ctx: AgentContext,
    options?: RunOptions,
  ): AsyncGenerator<RunStreamEvent, EngineResult, void> {
    this.prepareRun(input, ctx, options);

    const availableTools = this.resolveRunTools(options);
    const signal = options?.signal;

    return yield* this.coreReactLoop(ctx, availableTools, signal, true);
  }

  private prepareRun(input: Message, ctx: AgentContext, options?: RunOptions): void {
    const visibleSkills = this.resolveRunSkills(options);
    this.injectSkillPrompt(ctx, visibleSkills);
    ctx.addMessage(input);
  }

  private async *coreReactLoop(
    ctx: AgentContext,
    availableTools: Map<string, Tool>,
    signal: AbortSignal | undefined,
    emitStream: boolean,
  ): AsyncGenerator<RunStreamEvent, EngineResult, void> {
    const tools = availableTools.values().toArray();
    let step = 0;

    while (step < this.maxSteps) {
      step++;

      if (signal?.aborted) {
        return this.createAbortedResult(ctx, signal);
      }

      yield { type: 'step_start', step };

      let assistantMessage: Message;
      let usage: TokenUsage;
      try {
        const outbound = this.prepareOutboundMessages([...ctx.messages]);
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
        return this.createErrorResult(ctx, error, isAbortError(error, signal) ? 'aborted' : 'provider');
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
        return this.createErrorResult(ctx, error, 'memory');
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
        toolResults = await this.runTools(assistantMessage.tool_calls, availableTools, ctx, signal);
      } catch (error) {
        return this.createErrorResult(ctx, error, isAbortError(error, signal) ? 'aborted' : 'tool');
      }
      ctx.addMessages(toolResults);

      for (const result of toolResults) {
        yield { type: 'tool_result', message: result };
      }

      yield { type: 'step_end', step };
    }

    return this.createResult('max_steps_reached', ctx);
  }
  private async llmStep(
    ctx: AgentContext,
    messages: Message[],
    tools: Tool[],
    signal: AbortSignal | undefined,
  ): Promise<{ message: Message; usage: TokenUsage }> {
    const hookCtx = await this.applyBeforeLLMRequestHooks(ctx, messages, tools, signal);
    const mwCtx: LLMMiddlewareContext = {
      model: ctx.activeModel,
      messages: hookCtx.messages,
      tools: hookCtx.tools,
      options: hookCtx.options,
      agentContext: ctx,
    };

    const core = async () => ctx.activeProvider.generate(
      ctx.activeModel,
      mwCtx.messages,
      mwCtx.tools,
      mwCtx.options,
    );

    try {
      return await chainMiddleware(this.llmMiddlewares, mwCtx, core);
    } catch (error) {
      throw this.createDiagnosticError(isAbortError(error, signal) ? 'aborted' : 'provider', error);
    }
  }

  private async *streamLLMStep(
    ctx: AgentContext,
    messages: Message[],
    tools: Tool[],
    signal: AbortSignal | undefined,
  ): AsyncGenerator<RunStreamEvent, { message: Message; usage: TokenUsage }, void> {
    const hookCtx = await this.applyBeforeLLMRequestHooks(ctx, messages, tools, signal);
    const mwCtx: LLMMiddlewareContext = {
      model: ctx.activeModel,
      messages: hookCtx.messages,
      tools: hookCtx.tools,
      options: hookCtx.options,
      agentContext: ctx,
    };

    const queue = new AsyncQueue<RunStreamEvent>();

    const core = async (): Promise<{ message: Message; usage: TokenUsage }> => {
      const stream = ctx.activeProvider.generateStream(
        ctx.activeModel,
        mwCtx.messages,
        mwCtx.tools,
        mwCtx.options,
      );

      let content: string | null = null;
      let toolCalls: ToolCall[] | undefined;
      let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage;
        if (chunk.delta) {
          const currentContent = typeof chunk.message.content === 'string'
            ? chunk.message.content
            : (content ?? '') + chunk.delta;
          queue.push({ type: 'text_delta', delta: chunk.delta, content: currentContent });
        }
        if (chunk.message.content !== undefined) {
          content = chunk.message.content;
        }
        if (chunk.message.tool_calls !== undefined) {
          toolCalls = chunk.message.tool_calls;
        }
      }

      const finalMessage: Message = {
        role: 'assistant',
        content,
        ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
      return { message: finalMessage, usage };
    };

    const resultPromise = (async () => {
      try {
        return await chainMiddleware(this.llmMiddlewares, mwCtx, core);
      } finally {
        queue.close();
      }
    })();

    let resultError: unknown;
    resultPromise.catch((err) => { resultError = err; });

    for await (const event of queue.drain()) {
      yield event;
    }

    try {
      return await resultPromise;
    } catch (error) {
      throw this.createDiagnosticError(
        isAbortError(resultError ?? error, signal) ? 'aborted' : 'provider',
        error,
      );
    }
  }

  private async runTools(
    toolCalls: Message['tool_calls'],
    availableTools: Map<string, Tool>,
    ctx: AgentContext,
    signal: AbortSignal | undefined,
  ): Promise<Message[]> {
    try {
      return await Promise.all(
        (toolCalls ?? []).map((call) => this.runToolWithMiddleware(call, availableTools, ctx, signal)),
      );
    } catch (error) {
      throw this.createDiagnosticError(isAbortError(error, signal) ? 'aborted' : 'tool', error);
    }
  }

  private async runToolWithMiddleware(
    call: ToolCall,
    availableTools: Map<string, Tool>,
    ctx: AgentContext,
    signal: AbortSignal | undefined,
  ): Promise<Message> {
    const tool = availableTools.get(call.name);
    if (!tool) {
      return this.toolFailureMessage(call, `Tool "${call.name}" not found`);
    }

    warnIfJSONSchemaTool(tool);

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(call.arguments);
    } catch (err) {
      return this.toolFailureMessage(call, (err as Error).message);
    }

    const validation = validateToolArguments(tool.parameters, parsedArgs);
    if (!validation.success) {
      return this.toolFailureMessage(call, validation.error);
    }
    parsedArgs = validation.data;

    const mwCtx: ToolMiddlewareContext = {
      tool,
      toolCall: call,
      args: parsedArgs,
      agentContext: ctx,
    };

    try {
      await this.applyBeforeToolCallHooks(mwCtx);
      const result = await chainMiddleware(
        this.toolMiddlewares,
        mwCtx,
        () => tool.execute(mwCtx.args as never, ctx, { signal }) as Promise<unknown>,
      );
      const finalResult = await this.applyAfterToolCallHooks({
        tool,
        toolCall: call,
        args: mwCtx.args,
        result,
        agentContext: ctx,
      });
      return {
        role: 'tool',
        content: encodeToolResultEnvelope({ success: true, result: finalResult }),
        tool_call_id: call.id,
      };
    } catch (err) {
      if (isAbortError(err, signal)) throw err;
      return this.toolFailureMessage(call, (err as Error).message);
    }
  }

  private async applyBeforeLLMRequestHooks(
    ctx: AgentContext,
    messages: Message[],
    tools: Tool[],
    signal: AbortSignal | undefined,
  ): Promise<BeforeLLMRequestHookContext> {
    const hookCtx: BeforeLLMRequestHookContext = {
      model: ctx.activeModel,
      messages: [...messages],
      tools: [...tools],
      options: signal ? { signal } : {},
      agentContext: ctx,
    };

    for (const hook of this.beforeLLMRequestHooks) {
      await hook(hookCtx);
    }

    return hookCtx;
  }

  private async applyBeforeToolCallHooks(ctx: ToolMiddlewareContext): Promise<void> {
    if (this.beforeToolCallHooks.length === 0) return;

    const hookCtx: BeforeToolCallHookContext = {
      tool: ctx.tool,
      toolCall: ctx.toolCall,
      args: ctx.args,
      agentContext: ctx.agentContext,
    };

    for (const hook of this.beforeToolCallHooks) {
      await hook(hookCtx);
    }

    ctx.args = hookCtx.args;
  }

  private async applyAfterToolCallHooks(ctx: AfterToolCallHookContext): Promise<unknown> {
    if (this.afterToolCallHooks.length === 0) return ctx.result;

    const hookCtx: AfterToolCallHookContext = {
      tool: ctx.tool,
      toolCall: ctx.toolCall,
      args: ctx.args,
      result: ctx.result,
      agentContext: ctx.agentContext,
    };

    for (const hook of this.afterToolCallHooks) {
      await hook(hookCtx);
    }

    return hookCtx.result;
  }

  private toolFailureMessage(call: ToolCall, error: string): Message {
    return {
      role: 'tool',
      content: encodeToolResultEnvelope({ success: false, error }),
      tool_call_id: call.id,
    };
  }

  private createDiagnosticError(source: EngineErrorSource, error: unknown): Error {
    return new EngineDiagnosticError(source, error);
  }

  private createResult(status: 'completed' | 'max_steps_reached', ctx: AgentContext): EngineResult {
    const snapshot = [...ctx.messages];
    return {
      status,
      messages: snapshot,
      visibleMessages: filterVisibleMessages(snapshot),
      usage: ctx.sessionUsage,
    };
  }

  private createErrorResult(ctx: AgentContext, error: unknown, fallbackSource: EngineErrorSource): EngineResult {
    const source = getErrorSource(error) ?? fallbackSource;
    const cause = getCauseString(error instanceof EngineDiagnosticError ? error.cause : error);
    const snapshot = [...ctx.messages];

    return {
      status: 'error',
      messages: snapshot,
      visibleMessages: filterVisibleMessages(snapshot),
      usage: ctx.sessionUsage,
      error: {
        message: getErrorMessage(error),
        source,
        ...(cause ? { cause } : {}),
      },
    };
  }

  private createAbortedResult(ctx: AgentContext, signal?: AbortSignal): EngineResult {
    const reason = signal?.reason;
    const message = reason instanceof Error ? reason.message
      : typeof reason === 'string' ? reason
      : 'Run aborted';
    const snapshot = [...ctx.messages];
    return {
      status: 'error',
      messages: snapshot,
      visibleMessages: filterVisibleMessages(snapshot),
      usage: ctx.sessionUsage,
      error: { message, source: 'aborted' },
    };
  }

  private resolveRunTools(options?: RunOptions): Map<string, Tool> {
    if (!options?.tools) return new Map(this.globalTools);

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
    if (!options?.skills) return [...this.registeredSkills];

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
    if (!this.compatibilityMode) return messages;

    const grouped = Object.groupBy(messages, (message) =>
      message.role === 'system' ? 'system' : 'other',
    ) as { system?: Message[]; other?: Message[] };
    const systemMessages = grouped.system ?? [];

    if (systemMessages.length <= 1) return messages;

    const mergedSystemMessage: Message = {
      role: 'system',
      content: systemMessages.map((message) => message.content ?? '').join('\n\n'),
    };

    return [mergedSystemMessage, ...(grouped.other ?? [])];
  }

  private injectSkillPrompt(ctx: AgentContext, skills: readonly AgentSkill[]): void {
    const content = renderSkillsPrompt(skills);
    if (!content) {
      ctx.removePromptSection(SKILL_PROMPT_SECTION);
      return;
    }

    const section = ctx.registerPromptSection(SKILL_PROMPT_SECTION, { content, pinned: true });
    if (section._meta) {
      section._meta.skillPrompt = true;
    }
  }
}
