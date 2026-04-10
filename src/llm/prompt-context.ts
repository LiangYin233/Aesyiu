import { StandardMessage } from './types.js';
import { ToolDefinition } from '../tools/types.js';

export interface SystemVariables {
  date: string;
  os: string;
  systemLang: string;
}

export interface PromptMetadata {
  chatId: string;
  senderId: string;
  traceId?: string;
  maxTokens?: number;
  roleId?: string;
}

export interface SystemContext {
  roleId: string;
  roleName: string;
  systemPrompt: string;
  variables: SystemVariables;
}

export interface PromptContext {
  system: SystemContext;
  messages: StandardMessage[];
  tools: ToolDefinition[];
  metadata?: PromptMetadata;
  providerExtra?: Record<string, unknown>;
  modelExtraBody?: Record<string, unknown>;
}

export interface PromptContextOptions {
  chatId: string;
  senderId: string;
  traceId?: string;
  roleId: string;
  messages: StandardMessage[];
  tools: ToolDefinition[];
  maxTokens?: number;
}
