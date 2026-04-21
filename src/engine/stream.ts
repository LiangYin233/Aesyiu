import type { AgentContext } from '../context/index.js';
import type { EngineResult, Message, RunStreamEvent, StreamChunk, TokenUsage, ToolCall } from '../types/index.js';
import type { Middleware } from './types.js';
import { AsyncQueue, combineAbortSignals, runUserMiddleware, toError } from './utils.js';

export async function* runStreamWithMiddleware(
  ctx: AgentContext,
  middlewares: Middleware[],
  signal: AbortSignal | undefined,
  runCore: (ctx: AgentContext, signal: AbortSignal) => AsyncGenerator<RunStreamEvent, EngineResult, void>,
): AsyncGenerator<RunStreamEvent, EngineResult, void> {
  const internalAbort = new AbortController();
  const combinedSignal = combineAbortSignals(signal, internalAbort.signal);

  if (middlewares.length === 0) {
    try {
      return yield* runCore(ctx, combinedSignal);
    } finally {
      internalAbort.abort();
    }
  }

  const eventQueue = new AsyncQueue<RunStreamEvent>();

  let finalResult: EngineResult | undefined;
  let runnerError: unknown;
  const runnerPromise = (async (): Promise<void> => {
    try {
      finalResult = await runUserMiddleware(middlewares, ctx, async () => {
        const gen = runCore(ctx, combinedSignal);
        while (true) {
          const next = await gen.next();
          if (next.done) {return next.value;}
          eventQueue.push(next.value);
        }
      });
    } catch (error) {
      runnerError = error;
    } finally {
      eventQueue.close();
    }
  })();

  try {
    for await (const event of eventQueue.drain()) {
      yield event;
    }
    await runnerPromise;
    if (runnerError) {
      throw toError(runnerError);
    }
    return finalResult!;
  } finally {
    internalAbort.abort();
    await runnerPromise.catch(() => {});
  }
}

export async function collectStreamedLLMResult(
  stream: AsyncGenerator<StreamChunk, void>,
  pushEvent: (event: RunStreamEvent) => void,
): Promise<{ message: Message; usage: TokenUsage }> {
  let content: string | null = null;
  let toolCalls: ToolCall[] | undefined;
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = chunk.usage;
    }
    if (chunk.delta) {
      const currentContent = typeof chunk.message.content === 'string'
        ? chunk.message.content
        : (content ?? '') + chunk.delta;
      pushEvent({ type: 'text_delta', delta: chunk.delta, content: currentContent });
    }
    if (chunk.message.content !== undefined) {
      content = chunk.message.content;
    }
    if (chunk.message.tool_calls !== undefined) {
      toolCalls = chunk.message.tool_calls;
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
