export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Message {
  id?: string;
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  _meta?: {
    isPinned?: boolean;
    skillPrompt?: boolean;
  };
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
  extraBody?: Record<string, any>;
}

export interface ProviderConfig {
  apiKey: string;
  baseURL?: string;
  [key: string]: any;
}

export type EngineResultStatus = 'completed' | 'max_steps_reached' | 'error';

export interface EngineResult {
  status: EngineResultStatus;
  messages: Message[];
  usage: TokenUsage;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: any, ctx: any) => Promise<any>;
}
