/**
 * LLM 指标收集器模块
 * 简化版本：只保留核心计数功能
 */

import { TokenUsage } from '../types.js';

export { MODEL_PRICING };
export type { ModelPricing } from '../types.js';

/**
 * 主流模型定价表
 */
const MODEL_PRICING: Record<string, { prompt: number; completion: number }> = {
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
  'default': { prompt: 0.0005, completion: 0.0015 },
};

/**
 * 简化的指标报告
 */
export interface MetricsReport {
  totalCalls: number;
  totalTokens: number;
  totalCost: number;
}

export interface MetricsCollectorConfig {
  enabled?: boolean;
}

/**
 * LLM 指标收集器（简化版）
 */
export class MetricsCollector {
  private totalCalls = 0;
  private totalTokens = 0;
  private totalCost = 0;
  private enabled: boolean;

  constructor(config: MetricsCollectorConfig = {}) {
    this.enabled = config.enabled ?? true;
  }

  startRequest(
    _provider?: string,
    _model?: string,
    _metadata?: Record<string, unknown>
  ): string {
    return '';
  }

  recordSuccess(
    _requestId: string,
    tokenUsage?: TokenUsage,
    _metadata?: Record<string, unknown>
  ): void {
    if (!this.enabled) {
      return;
    }
    this.totalCalls++;
    if (tokenUsage) {
      this.totalTokens += tokenUsage.promptTokens + tokenUsage.completionTokens;
      this.totalCost += this.calculateCost(tokenUsage);
    }
  }

  recordError(
    _requestId: string,
    _error?: string,
    _errorType?: string,
    _metadata?: Record<string, unknown>
  ): void {
    if (!this.enabled) {
      return;
    }
    this.totalCalls++;
  }

  recordRequest(_metric: unknown): void {
    if (!this.enabled) {
      return;
    }
    this.totalCalls++;
  }

  private calculateCost(tokenUsage: TokenUsage): number {
    const model = 'default';
    const pricing = MODEL_PRICING[model];
    if (!pricing) {
      return 0;
    }
    const promptCost = (tokenUsage.promptTokens / 1000) * pricing.prompt;
    const completionCost = (tokenUsage.completionTokens / 1000) * pricing.completion;
    return Number((promptCost + completionCost).toFixed(6));
  }

  getMetricsReport(): MetricsReport {
    return {
      totalCalls: this.totalCalls,
      totalTokens: this.totalTokens,
      totalCost: this.totalCost,
    };
  }

  clear(): void {
    this.totalCalls = 0;
    this.totalTokens = 0;
    this.totalCost = 0;
  }
}
