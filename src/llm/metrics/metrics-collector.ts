/**
 * LLM 指标收集器模块
 * 极简版本：只保留工具调用计数和 token 统计
 */

import { TokenUsage } from '../types.js';

/**
 * 简化的指标报告
 */
export interface MetricsReport {
  totalCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
}

export interface MetricsCollectorConfig {
  enabled?: boolean;
}

/**
 * LLM 指标收集器（极简版）
 */
export class MetricsCollector {
  private totalCalls = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
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
      this.totalPromptTokens += tokenUsage.promptTokens;
      this.totalCompletionTokens += tokenUsage.completionTokens;
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

  getMetricsReport(): MetricsReport {
    return {
      totalCalls: this.totalCalls,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      totalTokens: this.totalPromptTokens + this.totalCompletionTokens,
    };
  }

  clear(): void {
    this.totalCalls = 0;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
  }
}
