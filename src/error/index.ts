export class AesyiuProgrammingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AesyiuProgrammingError';
  }
}

export function isProgrammingError(error: unknown): error is AesyiuProgrammingError {
  return error instanceof AesyiuProgrammingError;
}
