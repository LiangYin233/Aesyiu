import { StandardMessage } from '../llm/types.js';
import { TokenBudget, MemoryConfig } from './types.js';
import { RoleUtils } from '../core/role-utils.js';

export class TokenBudgetCalculator {
  private config: MemoryConfig;
  private tokenCache: Map<string, number> = new Map();
  private static readonly MAX_CACHE_SIZE = 500;

  constructor(config: MemoryConfig) {
    this.config = config;
  }

  updateConfig(config: Partial<MemoryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  calculate(messages: StandardMessage[], runtimeContextWindow?: number): TokenBudget {
    const totalTokens = this.calculateTotalTokens(messages);
    const effectiveMaxTokens = runtimeContextWindow ?? this.config.maxContextTokens;
    const usagePercentage = (totalTokens / effectiveMaxTokens) * 100;
    const compressionThresholdTokens = effectiveMaxTokens * this.config.compressionThreshold;
    const needsCompression = totalTokens >= compressionThresholdTokens;

    return {
      currentTokens: totalTokens,
      maxTokens: effectiveMaxTokens,
      usagePercentage,
      needsCompression,
    };
  }

  calculateTotalTokens(messages: StandardMessage[]): number {
    let totalTokens = 0;

    for (const message of messages) {
      const cacheKey = `${message.role}:${message.content}:${message.toolCalls?.length ?? 0}`;
      const cached = this.tokenCache.get(cacheKey);
      if (cached !== undefined) {
        this.tokenCache.delete(cacheKey);
        this.tokenCache.set(cacheKey, cached);
        totalTokens += cached;
      } else {
        const tokens = this.estimateTokens(message);
        if (this.tokenCache.size >= TokenBudgetCalculator.MAX_CACHE_SIZE) {
          const firstKey = this.tokenCache.keys().next().value;
          if (firstKey !== undefined) {
            this.tokenCache.delete(firstKey);
          }
        }
        this.tokenCache.set(cacheKey, tokens);
        totalTokens += tokens;
      }
    }

    const overheadPerMessage = 4;
    totalTokens += messages.length * overheadPerMessage;

    return totalTokens;
  }

  calculateSingleMessage(message: StandardMessage | string): number {
    const content = typeof message === 'string' ? message : message.content;

    const cached = this.tokenCache.get(content);
    if (cached !== undefined) {
      this.tokenCache.delete(content);
      this.tokenCache.set(content, cached);
      return cached;
    }

    if (this.tokenCache.size >= TokenBudgetCalculator.MAX_CACHE_SIZE) {
      const firstKey = this.tokenCache.keys().next().value;
      if (firstKey !== undefined) {
        this.tokenCache.delete(firstKey);
      }
    }

    const tokens = this.estimateTokensFromString(content);
    this.tokenCache.set(content, tokens);
    return tokens;
  }

  private estimateTokens(message: StandardMessage): number {
    const content = message.content;
    let tokens = this.estimateTokensFromString(content);

    if (message.toolCalls) {
      const toolCallsStr = JSON.stringify(message.toolCalls);
      tokens += this.estimateTokensFromString(toolCallsStr) * 0.5;
    }

    tokens += RoleUtils.getTokenWeight(message.role);

    return Math.ceil(tokens);
  }

  private estimateTokensFromString(text: string): number {
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishWords = text.split(/\s+/).length;
    const specialChars = (text.match(/[^\w\s\u4e00-\u9fff]/g) || []).length;

    const chineseTokens = chineseChars * 1.5;
    const englishTokens = englishWords * 0.75;
    const specialTokens = specialChars * 0.5;

    const total = chineseTokens + englishTokens + specialTokens;
    return Math.ceil(total);
  }

  clearCache(): void {
    this.tokenCache.clear();
  }

  getCacheSize(): number {
    return this.tokenCache.size;
  }
}