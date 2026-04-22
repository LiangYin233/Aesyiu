import type { AgentContext } from '../context/index.js';
import type { MemoryManager, MemoryManagerConfig } from '../memory/index.js';
import type { GenerateOptions } from '../provider/index.js';
import type { Message, ModelDefinition, Tool, ToolCall, TokenUsage } from '../types/index.js';

export type Middleware = (ctx: AgentContext, next: () => Promise<void>) => Promise<void>;

export interface LLMMiddlewareContext {
  readonly model: ModelDefinition;
  messages: Message[];
  tools: Tool[];
  options: GenerateOptions;
  readonly agentContext: AgentContext;
  readonly streamOutput: boolean;
  responseStarted: boolean;
}

export type LLMMiddleware = (
  ctx: LLMMiddlewareContext,
  next: () => Promise<{ message: Message; usage: TokenUsage }>,
) => Promise<{ message: Message; usage: TokenUsage }>;

export interface ToolMiddlewareContext {
  readonly tool: Tool;
  readonly toolCall: ToolCall;
  args: unknown;
  readonly agentContext: AgentContext;
}

export type ToolMiddleware = (
  ctx: ToolMiddlewareContext,
  next: () => Promise<unknown>,
) => Promise<unknown>;

export interface AesyiuEngineConfig {
  maxSteps?: number;
  memoryManager?: MemoryManager;
  memoryConfig?: MemoryManagerConfig;
  compatibilityMode?: boolean;
}

export interface RunOptions {
  tools?: string[];
  skills?: string[];
  signal?: AbortSignal;
}
