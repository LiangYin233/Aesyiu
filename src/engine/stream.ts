import type { AgentContext } from '../context/index.js';
import type { EngineResult, RunStreamEvent } from '../types/index.js';
import type { Middleware } from './types.js';
import { combineAbortSignals, runUserMiddleware, toError } from './utils.js';

class EventQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<(value: IteratorResult<T, void>) => void> = [];
  private closed = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined, done: true });
    }
  }

  async *consume(): AsyncGenerator<T, void, void> {
    while (true) {
      const item = this.buffer.shift();
      if (item !== undefined) {
        yield item;
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

  const queue = new EventQueue<RunStreamEvent>();
  let finalResult: EngineResult | undefined;
  let runnerError: unknown;

  const runner = (async (): Promise<void> => {
    try {
      finalResult = await runUserMiddleware(middlewares, ctx, async () => {
        const gen = runCore(ctx, combinedSignal);
        while (true) {
          const next = await gen.next();
          if (next.done) return next.value;
          queue.push(next.value);
        }
      });
    } catch (error) {
      runnerError = error;
    } finally {
      queue.close();
    }
  })();

  try {
    for await (const event of queue.consume()) {
      yield event;
    }
    await runner;
    if (runnerError) throw toError(runnerError);
    return finalResult!;
  } finally {
    internalAbort.abort();
    await runner.catch(() => {});
  }
}
