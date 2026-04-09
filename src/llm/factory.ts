import {
  ILLMProvider,
  LLMProviderType,
  UnifiedLLMClientConfig,
} from './types.js';
import { ToolDefinition } from '../tools/types.js';
import { OpenAIChatAdapter } from './adapters/openai-chat-adapter.js';
import { OpenAICompletionAdapter } from './adapters/openai-completion-adapter.js';
import { AnthropicAdapter } from './adapters/anthropic-adapter.js';
import { createNoOpLogger } from '../observability/logger.js';
import type { ILogger } from '../contracts/logger.js';

export interface LLMConfig {
  provider: LLMProviderType;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
}

export class LLMProviderFactory {
  private adapters: Map<string, ILLMProvider> = new Map();
  private logger: ILogger;

  constructor(logger?: ILogger) {
    this.logger = logger ?? createNoOpLogger();
    this.logger.info('LLMProviderFactory initialized');
  }

  createAdapter(config: LLMConfig): ILLMProvider {
    const cacheKey = this.getCacheKey(config);

    if (this.adapters.has(cacheKey)) {
      this.logger.debug({ cacheKey, provider: config.provider }, 'Reusing existing LLM Adapter');
      return this.adapters.get(cacheKey)!;
    }

    let adapter: ILLMProvider;

    switch (config.provider) {
      case LLMProviderType.OpenAIChat:
        adapter = new OpenAIChatAdapter({
          provider: config.provider,
          model: config.model,
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          timeout: config.timeout,
        });
        break;

      case LLMProviderType.OpenAICompletion:
        adapter = new OpenAICompletionAdapter({
          provider: config.provider,
          model: config.model,
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          timeout: config.timeout,
        });
        break;

      case LLMProviderType.Anthropic:
        adapter = new AnthropicAdapter({
          provider: config.provider,
          model: config.model,
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          timeout: config.timeout,
        });
        break;

      default:
        throw new Error(`Unsupported LLM Provider: ${config.provider}`);
    }

    this.adapters.set(cacheKey, adapter);
    this.logger.info(
      { cacheKey, provider: config.provider, model: config.model },
      'Created new LLM Adapter instance'
    );

    return adapter;
  }

  private getCacheKey(config: LLMConfig): string {
    return `${config.provider}:${config.model || 'default'}`;
  }
}

export const llmProviderFactory = new LLMProviderFactory();
