export type { ILogger } from '../contracts/logger.js';

import type { ILogger } from '../contracts/logger.js';

export function createNoOpLogger(): ILogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}
