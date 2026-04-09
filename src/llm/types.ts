/**
 * LLM 模块核心类型定义
 * 包含消息、响应、提供商配置等基础类型
 */

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { PromptContext } from './prompt-context.js';
import type { ToolDefinition, ToolParameters } from '../tools/types.js';
import type { ILogger } from '../contracts/logger.js';

// ============================================================================
// 基础消息和响应类型
// ============================================================================

/**
 * 消息角色枚举
 */
export enum MessageRole {
  System = 'system',
  User = 'user',
  Assistant = 'assistant',
  Tool = 'tool'
}

/**
 * 标准消息格式
 */
export interface StandardMessage {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

/**
 * 工具调用
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Token 使用统计
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * 标准响应格式
 */
export interface StandardResponse {
  text: string;
  toolCalls: ToolCall[];
  tokenUsage?: TokenUsage;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  rawResponse?: unknown;
}

// ============================================================================
// 提供商配置和接口
// ============================================================================

/**
 * LLM 提供商类型枚举
 */
export enum LLMProviderType {
  OpenAIChat = 'openai-chat',
  OpenAICompletion = 'openai-completion',
  Anthropic = 'anthropic'
}

/**
 * LLM 模式枚举
 */
export enum LLMMode {
  Chat = 'chat',
  Completion = 'completion'
}

/**
 * LLM 提供商配置
 */
export interface LLMProviderConfig {
  provider: LLMProviderType;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  logger?: ILogger;
}

/**
 * LLM 提供商接口
 */
export interface ILLMProvider {
  readonly providerType: LLMProviderType;
  readonly supportedModes: LLMMode[];

  /**
   * 生成响应
   */
  generate(_context: PromptContext): Promise<StandardResponse>;

  /**
   * 流式生成响应
   * @param context 提示上下文
   * @param callbacks 流式回调函数
   */
  generateStream(
    _context: PromptContext,
    callbacks: StreamCallbacks
  ): Promise<AsyncIterable<StandardStreamChunk>>;

  /**
   * 验证配置
   */
  validateConfig(): boolean;
}

/**
 * 流式响应块
 */
export interface StandardStreamChunk {
  type: 'text' | 'tool_call' | 'done';
  text?: string;
  toolCall?: ToolCall;
  tokenUsage?: TokenUsage;
  finishReason?: string;
}

// ============================================================================
// 消息转换器类型
// ============================================================================

/**
 * OpenAI 格式的系统消息
 */
export interface OpenAISystemMessage {
  role: 'system';
  content: string;
}

/**
 * 转换后的 OpenAI 消息结果
 */
export interface OpenAIConvertedMessages {
  systemMessage?: OpenAISystemMessage;
  messages: ChatCompletionMessageParam[];
}

/**
 * Anthropic 消息内容块类型
 */
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

/**
 * Anthropic 消息内容类型
 */
export type AnthropicMessageContent = string | AnthropicContentBlock[];

/**
 * 转换后的 Anthropic 消息结果
 */
export interface AnthropicConvertedMessages {
  systemPrompt?: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: AnthropicMessageContent;
  }>;
}

// ============================================================================
// 工具转换器类型
// ============================================================================

/**
 * OpenAI 工具定义格式
 */
export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolParameters;
  };
}

/**
 * Anthropic 工具定义格式
 */
export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: ToolParameters;
}

/**
 * 工具格式化器接口
 */
export interface ToolFormatter<T> {
  format(tool: ToolDefinition): T;
  formatAll(tools: ToolDefinition[]): T[];
}

// ============================================================================
// 请求选项
// ============================================================================

/**
 * 请求选项配置
 */
export interface RequestOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stopSequences?: string[];
  frequencyPenalty?: number;
  presencePenalty?: number;
  stream?: boolean;
  user?: string;
  seed?: number;
  responseFormat?: { type: 'text' | 'json_object' };
  customParams?: Record<string, unknown>;
}

// ============================================================================
// 统一 LLM 客户端类型
// ============================================================================

/**
 * 统一 LLM 客户端配置接口
 */
export interface UnifiedLLMClientConfig {
  provider: LLMProviderType;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  defaultOptions?: RequestOptions;
  logger?: ILogger;
}

/**
 * 统一请求选项接口
 */
export interface UnifiedRequestOptions extends RequestOptions {
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 批量请求项
 */
export interface BatchRequestItem {
  id: string;
  messages: StandardMessage[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
  options?: UnifiedRequestOptions;
}

/**
 * 批量请求结果
 */
export interface BatchRequestResult {
  id: string;
  response?: StandardResponse;
  error?: Error;
  success: boolean;
}

/**
 * 流式响应回调
 */
export interface StreamCallbacks {
  onToken?: (text: string) => void;
  onToolCall?: (toolCall: ToolCall) => void;
  onComplete?: (result: {
    text: string;
    toolCalls: ToolCall[];
    tokenUsage?: TokenUsage;
    finishReason: string;
  }) => void;
  onError?: (error: Error) => void;
}

// ============================================================================
// 生成参数
// ============================================================================

/**
 * 生成参数
 */
export interface GenerateParams {
  messages: StandardMessage[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
}

/**
 * 模型定价信息（每 1K tokens, USD）
 */
export interface ModelPricing {
  prompt: number;
  completion: number;
}
