/**
 * 统一 LLM 客户端模块
 * 提供一致的 LLM 调用接口
 */

import {
  LLMProviderType,
  StandardMessage,
  StandardResponse,
  UnifiedLLMClientConfig,
  UnifiedRequestOptions,
  BatchRequestItem,
  BatchRequestResult,
  StreamCallbacks,
  RequestOptions,
  StandardStreamChunk,
  ILLMProvider,
} from './types.js';
import { PromptContext } from './prompt-context.js';
import { ToolDefinition } from '../tools/types.js';
import { MetricsCollector } from './metrics/metrics-collector.js';
import { llmProviderFactory } from './factory.js';
import { createNoOpLogger } from '../observability/logger.js';
import type { ILogger } from '../contracts/logger.js';
import type { MetricsReport } from './metrics/index.js';

/**
 * 统一 LLM 客户端类
 * 提供统一的 LLM 调用接口
 */
export class UnifiedLLMClient {
  private readonly provider: LLMProviderType;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly baseUrl?: string;
  private readonly timeout?: number;
  private readonly adapter: ILLMProvider;
  private readonly metricsCollector: MetricsCollector;
  private readonly defaultOptions: RequestOptions;
  private destroyed: boolean = false;
  private logger: ILogger;

  constructor(config: UnifiedLLMClientConfig) {
    this.provider = config.provider;
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.timeout = config.timeout;
    this.logger = config.logger ?? createNoOpLogger();

    this.metricsCollector = new MetricsCollector();

    this.defaultOptions = config.defaultOptions ?? {};

    this.adapter = llmProviderFactory.createAdapter({
      provider: this.provider,
      model: this.model,
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      timeout: this.timeout,
    });

    this.logger.info(
      {
        provider: this.provider,
        model: this.model,
      },
      'UnifiedLLMClient initialized'
    );
  }

  async generate(
    params: {
      messages: StandardMessage[];
      systemPrompt?: string;
      tools?: ToolDefinition[];
    },
    options?: UnifiedRequestOptions
  ): Promise<StandardResponse> {
    this.checkDestroyed();

    const startTime = Date.now();

    const metricsRequestId = this.metricsCollector.startRequest(
      this.provider,
      this.model,
      options?.metadata
    );

    try {
      const context = this.buildPromptContext(params, options);

      const response = await this.adapter.generate(context);

      const latency = Date.now() - startTime;

      this.metricsCollector.recordSuccess(
        metricsRequestId,
        response.tokenUsage,
        options?.metadata
      );

      return response;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.metricsCollector.recordError(
        metricsRequestId,
        err.message,
        'UnknownError',
        options?.metadata
      );

      throw error;
    }
  }

  async generateStream(
    params: {
      messages: StandardMessage[];
      systemPrompt?: string;
      tools?: ToolDefinition[];
    },
    callbacks: StreamCallbacks,
    options?: UnifiedRequestOptions
  ): Promise<AsyncIterable<StandardStreamChunk>> {
    this.checkDestroyed();

    const metricsRequestId = this.metricsCollector.startRequest(
      this.provider,
      this.model,
      options?.metadata
    );

    const context = this.buildPromptContext(params, options);

    const self = this;

    try {
      const stream = await this.adapter.generateStream(context, callbacks);

      return {
        async *[Symbol.asyncIterator]() {
          let lastTokenUsage;
          for await (const chunk of stream) {
            lastTokenUsage = chunk.tokenUsage;
            yield chunk;
          }
          if (metricsRequestId) {
            self.metricsCollector.recordSuccess(metricsRequestId, lastTokenUsage, options?.metadata);
          }
        },
      };
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.metricsCollector.recordError(
        metricsRequestId,
        err.message,
        'UnknownError',
        options?.metadata
      );

      if (callbacks.onError) {
        callbacks.onError(err);
      }

      throw error;
    }
  }

  async generateBatch(
    items: BatchRequestItem[],
    concurrency: number = 5
  ): Promise<BatchRequestResult[]> {
    this.checkDestroyed();

    this.logger.info(
      { itemCount: items.length, concurrency },
      'Starting batch LLM calls'
    );

    const results: BatchRequestResult[] = [];

    const chunks = this.chunkArray(items, concurrency);

    for (const chunk of chunks) {
      const chunkResults = await Promise.allSettled(
        chunk.map(async (item) => {
          try {
            const response = await this.generate(
              {
                messages: item.messages,
                systemPrompt: item.systemPrompt,
                tools: item.tools,
              },
              item.options
            );

            return {
              id: item.id,
              response,
              success: true,
            };
          } catch (error: unknown) {
            const err = error instanceof Error ? error : new Error(String(error));
            return {
              id: item.id,
              error: err,
              success: false,
            };
          }
        })
      );

      for (const result of chunkResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          this.logger.error(
            { error: result.reason },
            'Unexpected batch item rejection'
          );
          results.push({
            id: 'unknown',
            success: false,
            error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
          });
        }
      }
    }

    const successCount = results.filter((r) => r.success).length;
    this.logger.info(
      { total: items.length, success: successCount, failed: items.length - successCount },
      'Batch LLM calls completed'
    );

    return results;
  }

  getMetrics(): MetricsReport {
    return this.metricsCollector.getMetricsReport();
  }

  clearMetrics(): void {
    this.metricsCollector.clear();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    this.logger.info('UnifiedLLMClient destroyed');
  }

  private checkDestroyed(): void {
    if (this.destroyed) {
      throw new Error('UnifiedLLMClient has been destroyed');
    }
  }

  private buildPromptContext(
    params: {
      messages: StandardMessage[];
      systemPrompt?: string;
      tools?: ToolDefinition[];
    },
    options?: UnifiedRequestOptions
  ): PromptContext {
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
        chatId: options?.sessionId || 'default',
        senderId: options?.userId || 'user',
        traceId: options?.metadata?.traceId as string,
        maxTokens: options?.maxTokens,
      },
    };
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}

export function createUnifiedLLMClient(config: UnifiedLLMClientConfig): UnifiedLLMClient {
  return new UnifiedLLMClient(config);
}
