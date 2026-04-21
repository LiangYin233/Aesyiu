import type { AgentContext } from '../context/index.js';
import { AesyiuProgrammingError, isProgrammingError } from '../error/index.js';
import type { EngineResult } from '../types/index.js';
import type { Middleware } from './types.js';

type MiddlewareFn<TCtx, TResult> = (ctx: TCtx, next: () => Promise<TResult>) => Promise<TResult>;

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
  middlewares: ReadonlyArray<MiddlewareFn<TCtx, TResult>>,
  ctx: TCtx,
  core: () => Promise<TResult>,
): Promise<TResult> {
  if (middlewares.length === 0) {return core();}

  let index = -1;
  const dispatch = (i: number): Promise<TResult> => {
    if (i <= index) {
      return Promise.reject(new AesyiuProgrammingError('middleware next() called multiple times'));
    }
    index = i;
    if (i >= middlewares.length) {return core();}
    return middlewares[i](ctx, () => dispatch(i + 1));
  };
  return dispatch(0);
}

export function runUserMiddleware(
  middlewares: ReadonlyArray<Middleware>,
  ctx: AgentContext,
  core: () => Promise<EngineResult>,
): Promise<EngineResult> {
  const wrappedMiddlewares: ReadonlyArray<MiddlewareFn<AgentContext, EngineResult>> = middlewares.map((middleware) => async (middlewareCtx, next) => {
      let result: EngineResult | undefined;
      await middleware(middlewareCtx, async () => {
        result = await next();
      });
      if (result === undefined) {
        throw new AesyiuProgrammingError('user middleware did not call next(); engine core did not run');
      }
      return result;
    });

  return chainMiddleware(wrappedMiddlewares, ctx, core);
}

export async function consumeGenerator<TResult>(gen: AsyncGenerator<unknown, TResult, void>): Promise<TResult> {
  while (true) {
    const next = await gen.next();
    if (next.done) {return next.value;}
  }
}

export class AsyncQueue<T> {
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
      if (this.closed) {return;}
      const result = await new Promise<IteratorResult<T, void>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) {return;}
      yield result.value;
    }
  }
}
