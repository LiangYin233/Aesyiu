import {
  type StandardMessage,
  type StandardResponse,
  type StreamCallbacks,
  type UnifiedRequestOptions,
  type ILLMProvider,
  LLMProviderType,
} from './types.js';
import type { LLMProviderConfig } from './types.js';
import { PromptContext } from './prompt-context.js';
import type { ToolDefinition } from '../tools/types.js';
import { OpenAIChatAdapter } from './adapters/openai-chat-adapter.js';
import { OpenAICompletionAdapter } from './adapters/openai-completion-adapter.js';
import { AnthropicAdapter } from './adapters/anthropic-adapter.js';
import { ProviderType, type Provider, type Model, type RuntimeProviderState } from '../providers/types.js';
import { createNoOpLogger } from '../observability/logger.js';
import type { ILogger } from '../contracts/logger.js';

export interface DynamicLLMClientConfig {
  runtime: RuntimeProviderState;
  logger?: ILogger;
}

export class DynamicLLMClient {
  private runtime: RuntimeProviderState;
  private adapter?: ILLMProvider;
  private adapterKey?: string;
  private logger: ILogger;

  constructor(config: DynamicLLMClientConfig) {
    this.runtime = config.runtime;
    this.logger = config.logger ?? createNoOpLogger();
  }

  private ensureAdapter(): ILLMProvider {
    const provider = this.runtime.getCurrentProvider();
    const model = this.runtime.getCurrentModel();
    const key = this.buildKey(provider, model);

    if (!this.adapter || this.adapterKey !== key) {
      this.logger.info(
        { providerId: provider.id, type: provider.type, modelId: model.id, key },
        'Rebuilding LLM adapter'
      );
      this.adapter = this.createAdapter(provider, model);
      this.adapterKey = key;
    }

    return this.adapter;
  }

  private buildKey(provider: Provider, model: Model): string {
    return `${provider.id}:${provider.type}:${model.id}:${provider.baseUrl ?? ''}`;
  }

  private createAdapter(provider: Provider, model: Model): ILLMProvider {
    const config: LLMProviderConfig = {
      provider: provider.type as unknown as LLMProviderType,
      model: model.id,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      timeout: provider.timeout,
      logger: this.logger,
    };

    switch (provider.type) {
      case ProviderType.OpenAIChat:
        return new OpenAIChatAdapter(config);
      case ProviderType.OpenAICompletion:
        return new OpenAICompletionAdapter(config);
      case ProviderType.Anthropic:
        return new AnthropicAdapter(config);
      default:
        throw new Error(`Unsupported provider type: ${provider.type}`);
    }
  }

  private buildPromptContext(
    params: { messages: StandardMessage[]; systemPrompt?: string; tools?: ToolDefinition[] },
    options?: UnifiedRequestOptions
  ): PromptContext {
    const provider = this.runtime.getCurrentProvider();
    const model = this.runtime.getCurrentModel();

    return {
      system: {
        roleId: 'default',
        roleName: 'Assistant',
        systemPrompt: params.systemPrompt || '',
        variables: {
          date: new Date().toISOString().split('T')[0],
          os: process.platform,
          systemLang: process.env.LANG || 'en-US',
        },
      },
      messages: params.messages,
      tools: params.tools || [],
      metadata: {
        chatId: options?.conversationId || 'default',
        senderId: options?.userId || 'user',
        traceId: options?.metadata?.traceId as string,
        maxTokens: options?.maxTokens,
      },
      providerExtra: provider.extra,
      modelExtraBody: model.extraBody,
    };
  }

  async generate(
    params: { messages: StandardMessage[]; systemPrompt?: string; tools?: ToolDefinition[] },
    options?: UnifiedRequestOptions
  ): Promise<StandardResponse> {
    const adapter = this.ensureAdapter();
    const context = this.buildPromptContext(params, options);
    return adapter.generate(context);
  }

  async generateStream(
    params: { messages: StandardMessage[]; systemPrompt?: string; tools?: ToolDefinition[] },
    callbacks: StreamCallbacks,
    options?: UnifiedRequestOptions
  ): Promise<AsyncIterable<unknown>> {
    const adapter = this.ensureAdapter();
    const context = this.buildPromptContext(params, options);
    return adapter.generateStream(context, callbacks);
  }

  getCurrentProvider(): Provider {
    return this.runtime.getCurrentProvider();
  }

  getCurrentModel(): Model {
    return this.runtime.getCurrentModel();
  }

  destroy(): void {
    this.adapter = undefined;
    this.adapterKey = undefined;
    this.logger.debug('DynamicLLMClient destroyed');
  }
}