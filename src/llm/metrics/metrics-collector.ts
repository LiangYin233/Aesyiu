/**
 * LLM 指标收集器模块
 * 用于收集和统计 LLM 调用的各项指标
 */

import { randomUUID } from 'crypto';
import {
  TokenUsage,
  LLMProviderType,
  ModelPricing,
} from '../types.js';
import { createNoOpLogger } from '../../observability/logger.js';
import type { ILogger } from '../../contracts/logger.js';

export { ModelPricing };

/**
 * 主流模型定价表
 * 价格单位：美元/1K tokens
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-4o': { prompt: 0.005, completion: 0.015 },
  'gpt-4o-mini': { prompt: 0.00015, completion: 0.0006 },
  'gpt-4-turbo': { prompt: 0.01, completion: 0.03 },
  'gpt-4': { prompt: 0.03, completion: 0.06 },
  'gpt-4-32k': { prompt: 0.06, completion: 0.12 },
  'gpt-3.5-turbo': { prompt: 0.0005, completion: 0.0015 },
  'claude-3-opus': { prompt: 0.015, completion: 0.075 },
  'claude-3-sonnet': { prompt: 0.003, completion: 0.015 },
  'claude-3-haiku': { prompt: 0.00025, completion: 0.00125 },
  'claude-3-5-sonnet': { prompt: 0.003, completion: 0.015 },
  'claude-3-5-haiku': { prompt: 0.0008, completion: 0.004 },
  'deepseek-chat': { prompt: 0.0001, completion: 0.0002 },
  'deepseek-coder': { prompt: 0.0001, completion: 0.0002 },
};

/**
 * 单次请求指标
 */
export interface RequestMetric {
  requestId: string;
  provider: LLMProviderType;
  model: string;
  startTime: string;
  endTime?: string;
  latency?: number;
  tokenUsage?: TokenUsage;
  success: boolean;
  error?: string;
  errorType?: string;
  estimatedCost?: number;
  metadata?: Record<string, unknown>;
}

/**
 * 按模型分组的指标
 */
export interface ModelMetrics {
  model: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  averageLatency: number;
  minLatency: number;
  maxLatency: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  averageCostPerRequest: number;
}

/**
 * 按提供商分组的指标
 */
export interface ProviderMetrics {
  provider: LLMProviderType;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  averageLatency: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  models: Map<string, ModelMetrics>;
}

/**
 * 完整统计报告
 */
export interface MetricsReport {
  generatedAt: string;
  timeRange: {
    start: string;
    end: string;
  };
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  averageLatency: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  providers: Array<{
    provider: LLMProviderType;
    metrics: ProviderMetrics;
  }>;
  errors: Array<{
    errorType: string;
    errorMessage: string;
    count: number;
    lastOccurrence: string;
  }>;
}

/**
 * 指标收集器配置
 */
export interface MetricsCollectorConfig {
  enabled?: boolean;
  maxRequests?: number;
  verbose?: boolean;
}

/**
 * LLM 指标收集器
 */
export class MetricsCollector {
  private requests: RequestMetric[] = [];
  private enabled: boolean;
  private maxRequests: number;
  private verbose: boolean;
  private activeRequests: Map<string, RequestMetric> = new Map();
  private logger: ILogger;

  constructor(config: MetricsCollectorConfig & { logger?: ILogger } = {}) {
    this.enabled = config.enabled ?? true;
    this.maxRequests = config.maxRequests ?? 10000;
    this.verbose = config.verbose ?? false;
    this.logger = config.logger ?? createNoOpLogger();

    if (this.enabled) {
      this.logger.info('MetricsCollector initialized');
    }
  }

  startRequest(
    provider: LLMProviderType,
    model: string,
    metadata?: Record<string, unknown>
  ): string {
    if (!this.enabled) {
      return '';
    }

    const requestId = randomUUID();
    const metric: RequestMetric = {
      requestId,
      provider,
      model,
      startTime: new Date().toISOString(),
      success: false,
      metadata,
    };

    this.activeRequests.set(requestId, metric);

    if (this.verbose) {
      this.logger.debug(
        { requestId, provider, model },
        'Starting request recording'
      );
    }

    return requestId;
  }

  recordSuccess(
    requestId: string,
    tokenUsage?: TokenUsage,
    metadata?: Record<string, unknown>
  ): void {
    if (!this.enabled || !requestId) {
      return;
    }

    const metric = this.activeRequests.get(requestId);
    if (!metric) {
      this.logger.warn({ requestId }, 'Active request not found');
      return;
    }

    const endTime = new Date();
    const startTime = new Date(metric.startTime);
    const latency = endTime.getTime() - startTime.getTime();

    metric.endTime = endTime.toISOString();
    metric.latency = latency;
    metric.tokenUsage = tokenUsage;
    metric.success = true;
    metric.estimatedCost = this.calculateCost(metric.model, tokenUsage);

    if (metadata) {
      metric.metadata = { ...metric.metadata, ...metadata };
    }

    this.addRequest(metric);
    this.activeRequests.delete(requestId);

    if (this.verbose) {
      this.logger.debug(
        {
          requestId,
          latency,
          tokenUsage,
          estimatedCost: metric.estimatedCost,
        },
        'Recorded successful request'
      );
    }
  }

  recordError(
    requestId: string,
    error: string,
    errorType?: string,
    metadata?: Record<string, unknown>
  ): void {
    if (!this.enabled || !requestId) {
      return;
    }

    const metric = this.activeRequests.get(requestId);
    if (!metric) {
      this.logger.warn({ requestId }, 'Active request not found');
      return;
    }

    const endTime = new Date();
    const startTime = new Date(metric.startTime);
    const latency = endTime.getTime() - startTime.getTime();

    metric.endTime = endTime.toISOString();
    metric.latency = latency;
    metric.success = false;
    metric.error = error;
    metric.errorType = errorType || 'UnknownError';

    if (metadata) {
      metric.metadata = { ...metric.metadata, ...metadata };
    }

    this.addRequest(metric);
    this.activeRequests.delete(requestId);

    if (this.verbose) {
      this.logger.debug(
        {
          requestId,
          latency,
          error,
          errorType: metric.errorType,
        },
        'Recorded failed request'
      );
    }
  }

  recordRequest(metric: RequestMetric): void {
    if (!this.enabled) {
      return;
    }

    if (!metric.estimatedCost && metric.tokenUsage) {
      metric.estimatedCost = this.calculateCost(metric.model, metric.tokenUsage);
    }

    this.addRequest(metric);

    if (this.verbose) {
      this.logger.debug(
        { requestId: metric.requestId, success: metric.success },
        'Recorded request metric'
      );
    }
  }

  private addRequest(metric: RequestMetric): void {
    this.requests.push(metric);

    if (this.requests.length > this.maxRequests) {
      this.requests.shift();
    }
  }

  calculateCost(model: string, tokenUsage?: TokenUsage): number {
    if (!tokenUsage) {
      return 0;
    }

    let pricing = MODEL_PRICING[model];

    if (!pricing) {
      const modelLower = model.toLowerCase();
      for (const [key, value] of Object.entries(MODEL_PRICING)) {
        if (modelLower.includes(key.toLowerCase()) || key.toLowerCase().includes(modelLower)) {
          pricing = value;
          break;
        }
      }
    }

    if (!pricing) {
      this.logger.warn(
        { model },
        'Model pricing not found, cost estimation unavailable'
      );
      return 0;
    }

    const promptCost = (tokenUsage.promptTokens / 1000) * pricing.prompt;
    const completionCost = (tokenUsage.completionTokens / 1000) * pricing.completion;

    return Number((promptCost + completionCost).toFixed(6));
  }

  getMetricsReport(startTime?: Date, endTime?: Date): MetricsReport {
    let filteredRequests: RequestMetric[];
    if (startTime || endTime) {
      const start = startTime || new Date(0);
      const end = endTime || new Date();
      filteredRequests = this.requests.filter(req => {
        const reqTime = new Date(req.startTime);
        return reqTime >= start && reqTime <= end;
      });
    } else {
      filteredRequests = this.requests;
    }

    const generatedAt = new Date().toISOString();
    const timeRange = {
      start: filteredRequests.length > 0
        ? filteredRequests[0].startTime
        : generatedAt,
      end: filteredRequests.length > 0
        ? filteredRequests[filteredRequests.length - 1].startTime
        : generatedAt,
    };

    const totalRequests = filteredRequests.length;
    const successfulRequests = filteredRequests.filter(r => r.success).length;
    const failedRequests = totalRequests - successfulRequests;
    const successRate = totalRequests > 0 ? (successfulRequests / totalRequests) * 100 : 0;

    const latencies = filteredRequests
      .filter(r => r.latency !== undefined)
      .map(r => r.latency!);
    const averageLatency = latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0;

    const totalPromptTokens = filteredRequests
      .filter(r => r.tokenUsage)
      .reduce((sum, r) => sum + r.tokenUsage!.promptTokens, 0);
    const totalCompletionTokens = filteredRequests
      .filter(r => r.tokenUsage)
      .reduce((sum, r) => sum + r.tokenUsage!.completionTokens, 0);
    const totalTokens = totalPromptTokens + totalCompletionTokens;

    const estimatedCost = filteredRequests
      .filter(r => r.estimatedCost !== undefined)
      .reduce((sum, r) => sum + r.estimatedCost!, 0);

    const providersMap = this.groupByProvider(filteredRequests);
    const providers = Array.from(providersMap.entries()).map(([provider, metrics]) => ({
      provider,
      metrics,
    }));
    const errors = this.aggregateErrors(filteredRequests);

    return {
      generatedAt,
      timeRange,
      totalRequests,
      successfulRequests,
      failedRequests,
      successRate: Number(successRate.toFixed(2)),
      averageLatency: Number(averageLatency.toFixed(2)),
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      estimatedCost: Number(estimatedCost.toFixed(6)),
      providers,
      errors,
    };
  }

  private groupByProvider(requests: RequestMetric[]): Map<LLMProviderType, ProviderMetrics> {
    const providerMap = new Map<LLMProviderType, ProviderMetrics>();

    const providerGroups = new Map<LLMProviderType, RequestMetric[]>();
    for (const req of requests) {
      const group = providerGroups.get(req.provider) || [];
      group.push(req);
      providerGroups.set(req.provider, group);
    }

    for (const [provider, reqs] of providerGroups) {
      const totalRequests = reqs.length;
      const successfulRequests = reqs.filter(r => r.success).length;
      const failedRequests = totalRequests - successfulRequests;
      const successRate = totalRequests > 0 ? (successfulRequests / totalRequests) * 100 : 0;

      const latencies = reqs.filter(r => r.latency !== undefined).map(r => r.latency!);
      const averageLatency = latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0;

      const totalPromptTokens = reqs
        .filter(r => r.tokenUsage)
        .reduce((sum, r) => sum + r.tokenUsage!.promptTokens, 0);
      const totalCompletionTokens = reqs
        .filter(r => r.tokenUsage)
        .reduce((sum, r) => sum + r.tokenUsage!.completionTokens, 0);
      const totalTokens = totalPromptTokens + totalCompletionTokens;

      const estimatedCost = reqs
        .filter(r => r.estimatedCost !== undefined)
        .reduce((sum, r) => sum + r.estimatedCost!, 0);

      const models = this.groupByModel(reqs);

      providerMap.set(provider, {
        provider,
        totalRequests,
        successfulRequests,
        failedRequests,
        successRate: Number(successRate.toFixed(2)),
        averageLatency: Number(averageLatency.toFixed(2)),
        totalPromptTokens,
        totalCompletionTokens,
        totalTokens,
        estimatedCost: Number(estimatedCost.toFixed(6)),
        models,
      });
    }

    return providerMap;
  }

  private groupByModel(requests: RequestMetric[]): Map<string, ModelMetrics> {
    const modelMap = new Map<string, ModelMetrics>();

    const modelGroups = new Map<string, RequestMetric[]>();
    for (const req of requests) {
      const group = modelGroups.get(req.model) || [];
      group.push(req);
      modelGroups.set(req.model, group);
    }

    for (const [model, reqs] of modelGroups) {
      const totalRequests = reqs.length;
      const successfulRequests = reqs.filter(r => r.success).length;
      const failedRequests = totalRequests - successfulRequests;
      const successRate = totalRequests > 0 ? (successfulRequests / totalRequests) * 100 : 0;

      const latencies = reqs.filter(r => r.latency !== undefined).map(r => r.latency!);
      const averageLatency = latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0;
      const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
      const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

      const totalPromptTokens = reqs
        .filter(r => r.tokenUsage)
        .reduce((sum, r) => sum + r.tokenUsage!.promptTokens, 0);
      const totalCompletionTokens = reqs
        .filter(r => r.tokenUsage)
        .reduce((sum, r) => sum + r.tokenUsage!.completionTokens, 0);
      const totalTokens = totalPromptTokens + totalCompletionTokens;

      const estimatedCost = reqs
        .filter(r => r.estimatedCost !== undefined)
        .reduce((sum, r) => sum + r.estimatedCost!, 0);
      const averageCostPerRequest = totalRequests > 0 ? estimatedCost / totalRequests : 0;

      modelMap.set(model, {
        model,
        totalRequests,
        successfulRequests,
        failedRequests,
        successRate: Number(successRate.toFixed(2)),
        averageLatency: Number(averageLatency.toFixed(2)),
        minLatency: Number(minLatency.toFixed(2)),
        maxLatency: Number(maxLatency.toFixed(2)),
        totalPromptTokens,
        totalCompletionTokens,
        totalTokens,
        estimatedCost: Number(estimatedCost.toFixed(6)),
        averageCostPerRequest: Number(averageCostPerRequest.toFixed(6)),
      });
    }

    return modelMap;
  }

  private aggregateErrors(requests: RequestMetric[]): Array<{
    errorType: string;
    errorMessage: string;
    count: number;
    lastOccurrence: string;
  }> {
    const errorMap = new Map<string, {
      errorType: string;
      errorMessage: string;
      count: number;
      lastOccurrence: string;
    }>();

    for (const req of requests) {
      if (!req.success && req.error) {
        const errorKey = `${req.errorType || 'UnknownError'}:${req.error}`;

        if (errorMap.has(errorKey)) {
          const metric = errorMap.get(errorKey)!;
          metric.count++;
          metric.lastOccurrence = req.startTime;
        } else {
          errorMap.set(errorKey, {
            errorType: req.errorType || 'UnknownError',
            errorMessage: req.error,
            count: 1,
            lastOccurrence: req.startTime,
          });
        }
      }
    }

    return Array.from(errorMap.values()).sort((a, b) => b.count - a.count);
  }

  clear(): void {
    this.requests = [];
    this.activeRequests.clear();
    this.logger.info('Cleared all metrics data');
  }
}
