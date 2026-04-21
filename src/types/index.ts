import type { ZodType } from 'zod';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface MessageMeta {
  isPinned?: boolean;
  skillPrompt?: boolean;
  promptSection?: string;
  internal?: boolean;
  [key: string]: unknown;
}

export interface Message {
  id?: string;
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  _meta?: MessageMeta;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelDefinition {
  id: string;
  contextWindow: number;
  maxOutputTokens: number;
  extraBody?: Record<string, unknown>;
}

export interface ProviderConfig {
  apiKey: string;
  baseURL?: string;
}

export type EngineResultStatus = 'completed' | 'max_steps_reached' | 'error';

export type EngineErrorSource = 'provider' | 'memory' | 'tool' | 'engine' | 'aborted' | 'unknown';

export interface EngineErrorInfo {
  message: string;
  source: EngineErrorSource;
  cause?: string;
}

export interface EngineResult {
  status: EngineResultStatus;
  messages: Message[];
  visibleMessages: Message[];
  usage: TokenUsage;
  error?: EngineErrorInfo;
}

export interface ToolResultEnvelope<T = unknown> {
  success: boolean;
  result?: T;
  error?: string;
}

export type JSONSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export type ToolParameters = ZodType<unknown, unknown> | JSONSchema;

export interface ToolExecutionOptions {
  signal?: AbortSignal;
}

export interface Tool<TArgs = unknown, TResult = unknown, TCtx = unknown> {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute: (args: TArgs, ctx: TCtx, options?: ToolExecutionOptions) => Promise<TResult>;
}

export interface StreamChunk {
  message: Partial<Message>;
  usage?: TokenUsage;
  /** Incremental text produced by this chunk. `message.content` remains the cumulative text. */
  delta?: string;
}

export type RunStreamEvent =
  | { type: 'step_start'; step: number }
  | { type: 'text_delta'; delta: string; content: string }
  | { type: 'assistant_message'; message: Message }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; message: Message }
  | { type: 'step_end'; step: number };
