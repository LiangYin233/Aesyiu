import type { AgentContext } from '../context/index.js';
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
import type { LLMMiddleware, LLMMiddlewareContext, ToolMiddleware } from './types.js';
import { prepareOutboundMessages } from './preparation.js';
import { runToolCalls } from '../tool/runner.js';
import { chainMiddleware, combineAbortSignals, getErrorMessage, rethrowProgrammingError, toError } from './utils.js';

type LLMOperationResult = { message: Message; usage: TokenUsage };

class EventQueue<T> {
  private buffer: T[] = [];
  private pending: ((value: IteratorResult<T, void>) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) {return;}
    if (this.pending) {
      this.pending({ value: item, done: false });
      this.pending = null;
      return;
    }
    this.buffer.push(item);
  }

  close(): void {
    this.closed = true;
    if (this.pending) {
      this.pending({ value: undefined, done: true });
      this.pending = null;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void> {
    while (true) {
      const item = this.buffer.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.closed) {return;}
      const result = await new Promise<IteratorResult<T, void>>((resolve) => {
        this.pending = resolve;
      });
      if (result.done) {return;}
      yield result.value;
    }
  }
}

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
  ): AsyncGenerator<RunStreamEvent, LLMOperationResult, void> {
    const internalAbort = new AbortController();
    const options = { signal: combineAbortSignals(signal, internalAbort.signal) };

    if (llmMiddlewares.length === 0) {
      try {
        const stream = await ctx.activeProvider.generateStream(
          ctx.activeModel,
          messages,
          tools,
          options,
        );

        let content = '';
        let toolCalls: ToolCall[] | undefined;
        let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

        for await (const event of stream) {
          switch (event.type) {
            case 'response_started':
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
      } finally {
        internalAbort.abort();
      }
    }

    const middlewareContext: LLMMiddlewareContext = {
      model: ctx.activeModel,
      messages: [...messages],
      tools: [...tools],
      options,
      agentContext: ctx,
      streamOutput,
      responseStarted: false,
    };

    const queue = new EventQueue<RunStreamEvent>();
    let result: LLMOperationResult | undefined;
    let runnerError: unknown;

    const runner = (async (): Promise<void> => {
      try {
        result = await chainMiddleware(llmMiddlewares, middlewareContext, async () => {
          const stream = await middlewareContext.agentContext.activeProvider.generateStream(
            middlewareContext.agentContext.activeModel,
            middlewareContext.messages,
            middlewareContext.tools,
            middlewareContext.options,
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
                middlewareContext.responseStarted = true;
                content += event.delta;
                if (middlewareContext.streamOutput) {
                  queue.push({ type: 'text_delta', delta: event.delta, content: event.content });
                }
                break;
              case 'tool_calls':
                middlewareContext.responseStarted = true;
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
      } catch (error) {
        runnerError = error;
      } finally {
        queue.close();
      }
    })();

    try {
      for await (const event of queue) {
        yield event;
      }
      await runner;
      if (runnerError) {
        throw toError(runnerError);
      }
      return result!;
    } finally {
      internalAbort.abort();
      await runner.catch(() => {});
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
    return this.createErrorResult(ctx, error, this.getErrorSource(error, signal) ?? fallbackSource);
  }

  private getErrorSource(error: unknown, signal?: AbortSignal): EngineErrorSource | undefined {
    if (signal?.aborted && signal.reason instanceof Error && signal.reason.name === 'TimeoutError') {return 'timeout';}
    if (signal?.aborted && error === signal.reason) {return 'aborted';}
    if (error instanceof Error && error.name === 'TimeoutError') {return 'timeout';}
    if (signal?.aborted && error instanceof Error && error.name === 'AbortError') {return 'aborted';}
    return undefined;
  }
}
