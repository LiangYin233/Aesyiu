import type { EngineErrorSource } from '../types/index.js';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class AesyiuProgrammingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AesyiuProgrammingError';
  }
}

export class AesyiuRuntimeError extends Error {
  public readonly source: EngineErrorSource;

  constructor(source: EngineErrorSource, cause: unknown) {
    super(getErrorMessage(cause), { cause });
    this.name = 'AesyiuRuntimeError';
    this.source = source;
  }
}

export function isProgrammingError(error: unknown): error is AesyiuProgrammingError {
  return error instanceof AesyiuProgrammingError;
}

export function isRuntimeError(error: unknown): error is AesyiuRuntimeError {
  return error instanceof AesyiuRuntimeError;
}
