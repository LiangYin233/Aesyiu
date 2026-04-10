import { StandardMessage, MessageRole } from '../llm/types.js';
import {
  MemoryConfig,
  MemoryStats,
  CompressionPhase,
  MemoryEvent,
  TokenBudget,
  createMemoryConfig,
} from './types.js';
import { TokenBudgetCalculator } from './token-budget-calculator.js';
import { MessageTrimmer } from './message-trimmer.js';
import { LosslessSummarizer } from './lossless-summarizer.js';
import { createNoOpLogger } from '../observability/logger.js';
import type { ILogger } from '../contracts/logger.js';
import type { ISystemPromptBuilder } from '../contracts/system-prompt-builder.js';

export interface SessionMemoryManagerDependencies {
  systemPromptBuilder: ISystemPromptBuilder;
  logger?: ILogger;
}

export class SessionMemoryManager {
  readonly chatId: string;
  private messages: StandardMessage[] = [];
  private config: MemoryConfig;
  private calculator: TokenBudgetCalculator;
  private trimmer: MessageTrimmer;
  private summarizer: LosslessSummarizer;
  private currentPhase: CompressionPhase = CompressionPhase.Idle;
  private compressionCount: number = 0;
  private lastCompressionTime?: Date;
  private eventListeners: Array<(_event: MemoryEvent) => void> = [];
  private deps: SessionMemoryManagerDependencies;
  private processingLock: Promise<void> | null = null;
  private logger: ILogger;

  constructor(
    chatId: string,
    config: Partial<MemoryConfig> | undefined,
    deps: SessionMemoryManagerDependencies
  ) {
    if (!deps.systemPromptBuilder) {
      throw new Error('SessionMemoryManager requires systemPromptBuilder dependency');
    }

    this.chatId = chatId;
    this.config = createMemoryConfig(config);
    this.deps = deps;
    this.logger = deps.logger ?? createNoOpLogger();

    this.calculator = new TokenBudgetCalculator(this.config);
    this.trimmer = new MessageTrimmer(this.config, this.calculator);
    this.summarizer = new LosslessSummarizer(this.config, this.calculator, { logger: this.logger });

    this.logger.info(
      {
        chatId: this.chatId,
        maxTokens: this.config.maxContextTokens,
        compressionThreshold: this.config.compressionThreshold,
      },
      'SessionMemoryManager 已初始化'
    );
  }

  updateConfig(config: Partial<MemoryConfig>): void {
    this.config = { ...this.config, ...config };
    this.calculator.updateConfig(config);
    this.trimmer.updateConfig(config);
    this.summarizer.updateConfig(config);
    this.logger.debug({ chatId: this.chatId, config: this.config as unknown as Record<string, unknown> }, 'Memory config updated');
  }

  async addMessage(message: StandardMessage): Promise<void> {
    while (this.processingLock) {
      await this.processingLock;
    }

    let resolveLock: () => void;
    this.processingLock = new Promise(resolve => { resolveLock = resolve; });

    try {
      await this.doAddMessage(message);
    } finally {
      this.processingLock = null;
      resolveLock!();
    }
  }

  private async doAddMessage(message: StandardMessage): Promise<void> {
    this.currentPhase = CompressionPhase.Monitoring;

    const { message: processedMessage, result } = this.trimmer.checkAndTrim(message);

    if (result?.wasTruncated) {
      this.logger.warn(
        {
          chatId: this.chatId,
          originalLength: result.originalLength,
          truncatedLength: result.truncatedLength,
          savings: `${this.trimmer.calculateSavingsPercentage(result).toFixed(2)}%`,
        },
        '消息被物理截断'
      );
      this.emitEvent({
        type: 'truncated',
        timestamp: new Date(),
        details: { truncationDetails: result },
      });
    }

    this.messages.push(processedMessage as StandardMessage);

    this.emitEvent({
      type: 'message_added',
      timestamp: new Date(),
      details: {
        messageCount: this.messages.length,
        tokenCount: this.checkBudget().currentTokens,
      },
    });

    const budget = this.checkBudget();

    if (budget.needsCompression) {
      this.logger.info(
        {
          chatId: this.chatId,
          currentTokens: budget.currentTokens,
          threshold: this.config.compressionThreshold,
        },
        'Token 预算超限，触发压缩协议'
      );
      await this.triggerCompression();
    }

    this.currentPhase = CompressionPhase.Idle;
  }

  getMessages(): ReadonlyArray<StandardMessage> {
    return this.messages;
  }

  getMessagesCopy(): StandardMessage[] {
    return [...this.messages];
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  getLastMessage(): StandardMessage | undefined {
    return this.messages[this.messages.length - 1];
  }

  getRecentMessages(count: number): StandardMessage[] {
    return this.messages.slice(-count);
  }

  checkBudget(): TokenBudget {
    return this.calculator.calculate(this.messages);
  }

  getStats(): MemoryStats {
    const budget = this.checkBudget();
    const sacredCount = this.messages.filter(
      msg => msg.role === MessageRole.System || msg.role === MessageRole.User
    ).length;
    const compressibleCount = this.messages.length - sacredCount;

    return {
      totalMessages: this.messages.length,
      totalTokens: budget.currentTokens,
      sacredMessages: sacredCount,
      compressibleMessages: compressibleCount,
      compressionCount: this.compressionCount,
      lastCompressionTime: this.lastCompressionTime,
      currentPhase: this.currentPhase,
    };
  }

  private async triggerCompression(): Promise<void> {
    this.currentPhase = CompressionPhase.SieveProcess;
    this.logger.info({ chatId: this.chatId }, 'Phase 1: Safety classification...');

    const zones = this.summarizer.sieveMessages(this.messages);
    
    const sacredZones = zones.filter(z => z.zone === 'sacred');
    const compressibleZones = zones.filter(z => z.zone === 'compressible');

    this.logger.info(
      {
        chatId: this.chatId,
        totalZones: zones.length,
        sacredZones: sacredZones.length,
        compressibleZones: compressibleZones.length,
      },
      '分拣完成，准备压缩'
    );

    this.currentPhase = CompressionPhase.LLMDrivenSummarization;
    this.logger.info({ chatId: this.chatId }, 'Phase 2: AI compression...');

    try {
      const compressionResult = await this.summarizer.summarize(zones);
      
      this.currentPhase = CompressionPhase.Reassembly;
      this.logger.info({ chatId: this.chatId }, 'Phase 3: Context reorganization...');

      this.messages = this.summarizer.reassemble(zones, compressionResult);
      
      this.compressionCount++;
      this.lastCompressionTime = new Date();

      const newBudget = this.checkBudget();

      this.logger.info(
        {
          chatId: this.chatId,
          originalTokens: compressionResult.originalTokens,
          compressedTokens: compressionResult.compressedTokens,
          compressionRatio: `${(compressionResult.compressionRatio * 100).toFixed(2)}%`,
          newTokenCount: newBudget.currentTokens,
          totalMessages: this.messages.length,
        },
        '压缩流水线执行完成'
      );

      this.emitEvent({
        type: 'compressed',
        timestamp: new Date(),
        details: {
          tokenCount: newBudget.currentTokens,
          compressionRatio: compressionResult.compressionRatio,
        },
      });

      this.currentPhase = CompressionPhase.Idle;
    } catch (error) {
      this.logger.error({ chatId: this.chatId, error: error as unknown }, '压缩流水线执行失败');
      this.currentPhase = CompressionPhase.Idle;
      throw error;
    }
  }

  async rebuildSystemContext(): Promise<void> {
    const systemPrompt = this.deps.systemPromptBuilder.buildSystemPrompt({
      chatId: this.chatId,
    });

    if (this.messages.length > 0 && this.messages[0].role === MessageRole.System) {
      this.messages[0] = {
        role: MessageRole.System,
        content: systemPrompt,
      };
    } else {
      this.messages.unshift({
        role: MessageRole.System,
        content: systemPrompt,
      });
    }

    this.logger.info(
      { chatId: this.chatId },
      '系统上下文已重建'
    );
  }

  async clear(): Promise<void> {
    this.messages = [];
    this.calculator.clearCache();
    this.compressionCount = 0;
    this.lastCompressionTime = undefined;
    this.currentPhase = CompressionPhase.Idle;
    
    try {
      await this.rebuildSystemContext();
    } catch (err) {
      this.logger.error({ chatId: this.chatId, error: err as unknown }, '重建系统上下文失败');
    }
    
    this.logger.debug({ chatId: this.chatId }, 'Session memory cleared');
    
    this.emitEvent({
      type: 'reset',
      timestamp: new Date(),
      details: {},
    });
  }

  getTokenCount(): number {
    return this.checkBudget().currentTokens;
  }

  hasMessages(): boolean {
    return this.messages.length > 0;
  }

  removeMessages(count: number): StandardMessage[] {
    if (count >= this.messages.length) {
      const removed = [...this.messages];
      this.messages = [];
      return removed;
    }
    
    const removed = this.messages.splice(this.messages.length - count, count);
    this.logger.debug({ chatId: this.chatId, removedCount: removed.length }, 'Removed some historical messages');
    return removed;
  }

  onEvent(listener: (_event: MemoryEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const index = this.eventListeners.indexOf(listener);
      if (index > -1) {
        this.eventListeners.splice(index, 1);
      }
    };
  }

  private emitEvent(event: MemoryEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error({ error: error as unknown, eventType: event.type }, '记忆事件监听器执行失败');
      }
    }
  }

  exportMemory(): {
    chatId: string;
    messages: StandardMessage[];
    stats: MemoryStats;
    config: MemoryConfig;
  } {
    return {
      chatId: this.chatId,
      messages: this.getMessagesCopy(),
      stats: this.getStats(),
      config: this.config,
    };
  }

  importMemory(data: { messages: StandardMessage[]; config?: Partial<MemoryConfig> }): void {
    if (data.config) {
      this.updateConfig(data.config);
    }
    
    this.messages = [...data.messages];
    this.calculator.clearCache();
    
    this.logger.info(
      { 
        chatId: this.chatId,
        importedMessages: this.messages.length,
      },
      '记忆已导入'
    );
  }

  validateIntegrity(): boolean {
    if (this.messages.length === 0) return true;

    const hasSystemPrompt = this.messages[0]?.role === MessageRole.System;
    const hasContinuouslyUserMessages = this.validateUserMessageContinuity();
    
    return hasSystemPrompt && hasContinuouslyUserMessages;
  }

  private validateUserMessageContinuity(): boolean {
    for (let i = 1; i < this.messages.length; i++) {
      const prev = this.messages[i - 1];
      const curr = this.messages[i];
      
      if (curr.role === MessageRole.Tool && prev.role !== MessageRole.Assistant) {
        return false;
      }
    }
    return true;
  }

  getCurrentPhase(): CompressionPhase {
    return this.currentPhase;
  }

  isCompressing(): boolean {
    return this.currentPhase !== CompressionPhase.Idle;
  }

  getCompressionCount(): number {
    return this.compressionCount;
  }

  getLastCompressionTime(): Date | undefined {
    return this.lastCompressionTime;
  }
}