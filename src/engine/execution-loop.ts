import type { AgentContext } from '../context/index.js';
import { filterVisibleMessages } from '../context/index.js';
import type { MemoryManager } from '../memory/index.js';
import type {
  EngineErrorSource,
  EngineResult,
  Message,
  RunStreamEvent,
  TokenUsage,
  Tool,
  ToolCall,
} from '../types/index.js';
import type { LLMMiddleware, ToolMiddleware } from './types.js';
import { prepareOutboundMessages } from './preparation.js';
import { runToolCalls } from './tool-runner.js';
import { chainMiddleware, getErrorMessage, rethrowProgrammingError } from './utils.js';

type LLMOperationResult = { message: Message; usage: TokenUsage };

interface ExecutionLoopConfig {
  maxSteps: number;
  compatibilityMode: boolean;
  memoryManager: MemoryManager;
}

export class ExecutionLoop {
  private maxSteps: number;
  private compatibilityMode: boolean;
  private memoryManager: MemoryManager;

  constructor(config: ExecutionLoopConfig) {
    this.maxSteps = config.maxSteps;
    this.compatibilityMode = config.compatibilityMode;
    this.memoryManager = config.memoryManager;
  }

  async *run(
    ctx: AgentContext,
    tools: Map<string, Tool>,
    options: {
      signal?: AbortSignal;
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
        const result = yield* this.streamLLMStep(ctx, outbound, toolList, options.llmMiddlewares, options.signal);
        assistantMessage = result.message;
        usage = result.usage;
      } catch (error) {
        return this.handleStepError(ctx, error, options.signal, 'provider');
      }

      ctx.addMessage(assistantMessage);
      yield { type: 'assistant_message', message: assistantMessage };

      try {
        await this.memoryManager.checkAndOptimize(ctx, usage);
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
    _llmMiddlewares: LLMMiddleware[],
    signal?: AbortSignal,
  ): AsyncGenerator<RunStreamEvent, LLMOperationResult, void> {
    const stream = await ctx.activeProvider.generateStream(
      ctx.activeModel,
      messages,
      tools,
      signal ? { signal } : {},
    );

    let content: string | null = null;
    let toolCalls: ToolCall[] | undefined;
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for await (const event of stream) {
      switch (event.type) {
        case 'text':
          content = event.content;
          yield { type: 'text_delta', delta: event.delta, content: event.content };
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
        content,
        ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      usage,
    };
  }

  private createResultBase(ctx: AgentContext): Pick<EngineResult, 'messages' | 'visibleMessages' | 'usage'> {
    const messages = [...ctx.messages];
    return {
      messages,
      visibleMessages: filterVisibleMessages(messages),
      usage: ctx.sessionUsage,
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
    return this.createErrorResult(ctx, error, this.getErrorSource(error, signal) ?? fallbackSource);
  }

  private getErrorSource(error: unknown, signal?: AbortSignal): EngineErrorSource | undefined {
    if (error instanceof Error && error.name === 'TimeoutError') {return 'timeout';}
    if (signal?.aborted && error === signal.reason) {return 'aborted';}
    if (error instanceof Error && error.name === 'AbortError') {return 'aborted';}
    return undefined;
  }
}
