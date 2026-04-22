import type { AgentContext } from '../context/index.js';
import type { MemoryManager, MemoryManagerConfig } from '../memory/index.js';
import type { GenerateOptions } from '../provider/index.js';
import type { Message, ModelDefinition, Tool, ToolCall, TokenUsage, RunStreamEvent, EngineResult } from '../types/index.js';

export type LLMOperationResult = { message: Message; usage: TokenUsage };

export type Middleware = (
  ctx: AgentContext,
  next: () => AsyncGenerator<RunStreamEvent, EngineResult, void>,
) => AsyncGenerator<RunStreamEvent, EngineResult, void>;

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
  next: () => AsyncGenerator<RunStreamEvent, LLMOperationResult, void>,
) => AsyncGenerator<RunStreamEvent, LLMOperationResult, void>;

export interface ToolMiddlewareContext {
  readonly tool: Tool;
  readonly toolCall: ToolCall;
  args: unknown;
  readonly agentContext: AgentContext;
}

export type ToolMiddleware = (
  ctx: ToolMiddlewareContext,
  next: () => AsyncGenerator<never, unknown, void>,
) => AsyncGenerator<never, unknown, void>;

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
