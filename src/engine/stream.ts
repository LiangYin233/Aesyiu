import type { AgentContext } from '../context/index.js';
import type { EngineResult, RunStreamEvent } from '../types/index.js';
import type { Middleware } from './types.js';
import { EventQueue } from './event-queue.js';
import { combineAbortSignals, runUserMiddleware, toError } from './utils.js';

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
          if (next.done) {return next.value;}
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
    for await (const event of queue) {
      yield event;
    }
    await runner;
    if (runnerError) {throw toError(runnerError);}
    return finalResult!;
  } finally {
    internalAbort.abort();
    await runner.catch(() => {});
  }
}
