import { setTimeout as sleep } from 'node:timers/promises';
import type { LLMMiddleware } from '../engine/index.js';

export interface LoggingMiddlewareOptions {
  log?: (event: LoggingEvent) => void;
  label?: string;
}

export type LoggingEvent =
  | { phase: 'request'; label: string; model: string; messageCount: number; toolCount: number }
  | { phase: 'response'; label: string; model: string; promptTokens: number; completionTokens: number; durationMs: number }
  | { phase: 'error'; label: string; model: string; error: unknown; durationMs: number };

export function loggingMiddleware(options?: LoggingMiddlewareOptions): LLMMiddleware {
  const log = options?.log ?? ((event) => console.log('[aesyiu:llm]', event));
  const label = options?.label ?? 'llm';

  return async (ctx, next) => {
    const start = Date.now();
    log({ phase: 'request', label, model: ctx.model.id, messageCount: ctx.messages.length, toolCount: ctx.tools.length });
    try {
      const result = await next();
      log({
        phase: 'response',
        label,
        model: ctx.model.id,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (error) {
      log({ phase: 'error', label, model: ctx.model.id, error, durationMs: Date.now() - start });
      throw error;
    }
  };
}

export interface RetryMiddlewareOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED']);

function defaultShouldRetry(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return false;

  const statusLike = (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  if (typeof statusLike === 'number' && RETRYABLE_STATUS_CODES.has(statusLike)) {
    return true;
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  return false;
}

export function retryMiddleware(options?: RetryMiddlewareOptions): LLMMiddleware {
  const maxRetries = options?.maxRetries ?? 2;
  const initialDelayMs = options?.initialDelayMs ?? 500;
  const backoffFactor = options?.backoffFactor ?? 2;
  const shouldRetry = options?.shouldRetry ?? defaultShouldRetry;

  return async (ctx, next) => {
    let attempt = 0;
    let delay = initialDelayMs;

    while (true) {
      try {
        return await next();
      } catch (error) {
        if (attempt >= maxRetries || !shouldRetry(error, attempt) || ctx.options.signal?.aborted) {
          throw error;
        }
        try {
          await sleep(delay, undefined, { signal: ctx.options.signal });
        } catch {
          throw error;
        }
        attempt++;
        delay *= backoffFactor;
      }
    }
  };
}

export interface TimeoutMiddlewareOptions {
  ms: number;
}

export function timeoutMiddleware(options: TimeoutMiddlewareOptions): LLMMiddleware {
  return async (ctx, next) => {
    const timeoutSignal = AbortSignal.timeout(options.ms);
    const previousSignal = ctx.options.signal;
    ctx.options = {
      ...ctx.options,
      signal: previousSignal ? AbortSignal.any([previousSignal, timeoutSignal]) : timeoutSignal,
    };
    return next();
  };
}
