import type { AgentContext } from '../context/index.js';
import type { MemoryManager, MemoryManagerConfig } from '../memory/index.js';
import type { GenerateOptions } from '../provider/index.js';
import type { Message, ModelDefinition, Tool, TokenUsage, ToolCall } from '../types/index.js';

export type Middleware = (ctx: AgentContext, next: () => Promise<void>) => Promise<void>;

export interface LLMMiddlewareContext {
  readonly model: ModelDefinition;
  messages: Message[];
  tools: Tool[];
  options: GenerateOptions;
  readonly agentContext: AgentContext;
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

export type BeforeLLMRequestHookContext = LLMMiddlewareContext;

export type BeforeLLMRequestHook = (
  ctx: BeforeLLMRequestHookContext,
) => void | Promise<void>;

export type BeforeToolCallHookContext = ToolMiddlewareContext;

export type BeforeToolCallHook = (
  ctx: BeforeToolCallHookContext,
) => void | Promise<void>;

export interface AfterToolCallHookContext {
  readonly tool: Tool;
  readonly toolCall: ToolCall;
  readonly args: unknown;
  result: unknown;
  readonly agentContext: AgentContext;
}

export type AfterToolCallHook = (
  ctx: AfterToolCallHookContext,
) => void | Promise<void>;

export interface EngineHooks {
  beforeLLMRequest?: BeforeLLMRequestHook;
  beforeToolCall?: BeforeToolCallHook;
  afterToolCall?: AfterToolCallHook;
}

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
