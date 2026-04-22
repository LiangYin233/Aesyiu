import { AesyiuProgrammingError, isProgrammingError } from '../error/index.js';
import type { EngineErrorSource, EngineResult, RunStreamEvent } from '../types/index.js';
import type { ToolMiddleware, ToolMiddlewareContext } from './types.js';

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) { return error.message; }
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

export function classifyError(error: unknown, signal?: AbortSignal): EngineErrorSource | undefined {
  if (signal?.aborted) {
    if (signal.reason instanceof Error && signal.reason.name === 'TimeoutError') { return 'timeout'; }
    if (error === signal.reason) { return 'aborted'; }
    if (error instanceof Error && error.name === 'AbortError') { return 'aborted'; }
  }
  if (error instanceof Error && error.name === 'TimeoutError') { return 'timeout'; }
  return undefined;
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return classifyError(error, signal) === 'aborted';
}

export function combineAbortSignals(signal: AbortSignal | undefined, fallback: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, fallback]) : fallback;
}

export async function* chainMiddleware<TCtx, TEvent, TResult>(
  middlewares: ReadonlyArray<(ctx: TCtx, next: () => AsyncGenerator<TEvent, TResult, void>) => AsyncGenerator<TEvent, TResult, void>>,
  ctx: TCtx,
  core: () => AsyncGenerator<TEvent, TResult, void>,
): AsyncGenerator<TEvent, TResult, void> {
  async function* run(index: number): AsyncGenerator<TEvent, TResult, void> {
    if (index >= middlewares.length) {
      return yield* core();
    }
    return yield* middlewares[index](ctx, () => run(index + 1));
  }
  return yield* run(0);
}

export async function consumeGenerator(gen: AsyncGenerator<unknown, EngineResult, void>): Promise<EngineResult> {
  while (true) {
    const next = await gen.next();
    if (next.done) { return next.value; }
  }
}

export async function chainToolMiddleware(
  middlewares: ReadonlyArray<ToolMiddleware>,
  ctx: ToolMiddlewareContext,
  core: () => Promise<unknown>,
): Promise<unknown> {
  async function run(index: number): Promise<unknown> {
    if (index >= middlewares.length) {
      return await core();
    }
    return await middlewares[index](ctx, () => run(index + 1));
  }
  return await run(0);
}
