import type { ToolDefinition } from '../tools/types.js';
import type { LLMConfig } from '../llm/factory.js';
import type { MemoryConfig } from '../memory/types.js';

export interface SessionOptions {
  channel: string;
  type: string;
  chatId: string;
  session: string;
  llm?: LLMConfig;
  maxSteps?: number;
  systemPrompt?: string;
  tools?: ToolDefinition[];
  memoryConfig?: Partial<MemoryConfig>;
}

export interface SessionConfig {
  maxSessionsPerChat: number;
  sessionTTL: number;
  autoCleanup: boolean;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  maxSessionsPerChat: 10,
  sessionTTL: 86400000,
  autoCleanup: true,
};