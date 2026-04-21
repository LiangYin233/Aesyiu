import type { AgentContext } from '../context/index.js';
import { AesyiuProgrammingError, isProgrammingError } from '../error/index.js';
import type { EngineResult } from '../types/index.js';
import type { Middleware } from './types.js';

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {return error.message;}
  return String(error);
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function rethrowProgrammingError(error: unknown): void {
  if (isProgrammingError(error)) {
    throw error;
  }
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted && error === signal.reason) {
    return true;
  }
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function combineAbortSignals(signal: AbortSignal | undefined, fallback: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, fallback]) : fallback;
}

export async function chainMiddleware<TCtx, TResult>(
  middlewares: ReadonlyArray<(ctx: TCtx, next: () => Promise<TResult>) => Promise<TResult>>,
  ctx: TCtx,
  core: () => Promise<TResult>,
): Promise<TResult> {
  let next = core;
  for (let i = middlewares.length - 1; i >= 0; i--) {
    const middleware = middlewares[i];
    const currentNext = next;
    next = () => middleware(ctx, currentNext);
  }
  return next();
}

export function runUserMiddleware(
  middlewares: ReadonlyArray<Middleware>,
  ctx: AgentContext,
  core: () => Promise<EngineResult>,
): Promise<EngineResult> {
  const wrapped = middlewares.map((mw): ((c: AgentContext, n: () => Promise<EngineResult>) => Promise<EngineResult>) => {
    return async (mctx, next) => {
      let result: EngineResult | undefined;
      await mw(mctx, async () => { result = await next(); });
      if (result === undefined) {
        throw new AesyiuProgrammingError('user middleware did not call next()');
      }
      return result;
    };
  });
  return chainMiddleware(wrapped, ctx, core);
}

export async function consumeGenerator<TResult>(gen: AsyncGenerator<unknown, TResult, void>): Promise<TResult> {
  while (true) {
    const next = await gen.next();
    if (next.done) {return next.value;}
  }
}
