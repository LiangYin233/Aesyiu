// Core
export { AgentEngine, type AgentConfig, type AgentRunResult, type AgentDeps } from './core/agent.js';
export { ChannelPipeline, type PipelineDeps } from './core/pipeline.js';
export type { IUnifiedMessage, IOutboundMessage, IOutboundPayload, IChannelContext, PipelineState, MiddlewareFunc } from './core/types.js';
export { MessageFactory } from './core/message-factory.js';
export { RoleUtils } from './core/role-utils.js';

// LLM
export { UnifiedLLMClient, createUnifiedLLMClient } from './llm/unified-client.js';
export { LLMProviderFactory, type LLMConfig } from './llm/factory.js';
export type {
  MessageRole,
  StandardMessage,
  ToolCall,
  TokenUsage,
  StandardResponse,
  LLMProviderType,
  LLMMode,
  LLMProviderConfig,
  ILLMProvider,
  RequestOptions,
  UnifiedLLMClientConfig,
  UnifiedRequestOptions,
  BatchRequestItem,
  BatchRequestResult,
  StreamCallbacks,
  GenerateParams,
  ModelPricing,
} from './llm/types.js';
export type { PromptContext, PromptContextOptions, SystemContext, PromptMetadata } from './llm/prompt-context.js';

// LLM Adapters
export { OpenAIChatAdapter } from './llm/adapters/openai-chat-adapter.js';
export { OpenAICompletionAdapter } from './llm/adapters/openai-completion-adapter.js';
export { AnthropicAdapter } from './llm/adapters/anthropic-adapter.js';

// LLM Transformers
export { MessageTransformer, OpenAIMessageFormatter, AnthropicMessageFormatter } from './llm/transformers/message-transformer.js';
export { ToolTransformer, OpenAIToolFormatter, AnthropicToolFormatter } from './llm/transformers/tool-transformer.js';

// LLM Stream
export {
  StreamHandler,
  createOpenAIStreamHandler,
  createAnthropicStreamHandler,
  handleStream,
  handleOpenAIStream,
  handleAnthropicStream,
  type StreamChunk,
  type OpenAIStreamChunk,
  type AnthropicStreamChunk,
  type StreamHandlerOptions,
  type StreamOutput,
} from './llm/stream/index.js';

// LLM Metrics
export {
  MetricsCollector,
  MODEL_PRICING,
  type MetricsCollectorConfig,
  type MetricsReport,
} from './llm/metrics/index.js';

// LLM Utils
export { TokenUsageMapper } from './llm/utils/token-usage-mapper.js';
export { FinishReasonMapper } from './llm/utils/finish-reason-mapper.js';

// Memory
export * from './memory/types.js';
export { TokenBudgetCalculator } from './memory/token-budget-calculator.js';
export { MessageTrimmer } from './memory/message-trimmer.js';
export { LosslessSummarizer } from './memory/lossless-summarizer.js';
export { SessionMemoryManager, type SessionMemoryManagerDependencies } from './memory/session-memory-manager.js';

// Session
export { SessionRegistry } from './session/session-registry.js';
export { SessionId, type SessionIdComponents } from './session/session-id.js';
export { createSessionMetadata, type SessionMetadata, type SessionContext } from './session/session-context.js';
export type { SessionOptions, SessionConfig } from './session/types.js';
export { DEFAULT_SESSION_CONFIG } from './session/types.js';

// Tools
export { ToolRegistry, type ToolValidationError, type ToolExecutionReport } from './tools/registry.js';
export type { ITool, ToolDefinition, ToolParameters, ToolExecuteContext, ToolExecutionResult, ToolCallRequest, ToolCallResult, ToolParameterProperty } from './tools/types.js';
export { validateParameters } from './tools/types.js';

// Observability
export { createNoOpLogger } from './observability/logger.js';
export type { ILogger } from './contracts/logger.js';

// Contracts (Interfaces)
export type { IRoleManager, RoleConfig } from './contracts/role-manager.js';
export type { ISkillManager, SkillMetadata, SkillRoute } from './contracts/skill-manager.js';
export type { ISystemPromptBuilder, PromptBuildContext } from './contracts/system-prompt-builder.js';
export type { IPluginHookDispatcher, HookPayloadMessageReceive, HookPayloadBeforeLLMRequest, HookPayloadToolCall, HookPayloadAfterToolCall, HookPayloadMessageSend } from './contracts/plugin-hook-dispatcher.js';

// Utils
export { mapProviderType } from './utils/llm-utils.js';

// Public API
export { createAgent, AgentBuilder, Agent, type ProviderConfig, type SkillDefinition } from './api.js';
