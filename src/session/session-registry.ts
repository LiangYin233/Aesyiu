import { createNoOpLogger } from '../observability/logger.js';
import type { ILogger } from '../contracts/logger.js';
import { LLMProviderType } from '../llm/types.js';
import type { LLMConfig } from '../llm/factory.js';
import type { ISystemPromptBuilder } from '../contracts/system-prompt-builder.js';
import type { SessionOptions, SessionConfig } from './types.js';
import { DEFAULT_SESSION_CONFIG } from './types.js';
import type { SessionContext } from './session-context.js';
import { createSessionMetadata } from './session-context.js';
import type { MemoryConfig as MemoryConfigInternal } from '../memory/types.js';
import { SessionMemoryManager } from '../memory/session-memory-manager.js';
import { AgentEngine } from '../core/agent.js';

export interface SessionRegistryDependencies {
  systemPromptBuilder: ISystemPromptBuilder;
  defaultLLMConfig?: LLMConfig;
  logger?: ILogger;
}

export class SessionRegistry {
  private sessions: Map<string, SessionContext> = new Map();
  private chatToSession: Map<string, string> = new Map();
  private config: SessionConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private deps: SessionRegistryDependencies;
  private logger: ILogger;

  constructor(deps: SessionRegistryDependencies) {
    this.deps = deps;
    this.config = { ...DEFAULT_SESSION_CONFIG };
    this.logger = deps.logger ?? createNoOpLogger();
    this.logger.info('SessionRegistry initialized');
  }

  private getDefaultLLMConfig(): LLMConfig {
    if (this.deps.defaultLLMConfig) {
      return this.deps.defaultLLMConfig;
    }

    return {
      provider: LLMProviderType.OpenAIChat,
      model: 'gpt-4o-mini',
    };
  }

  async getOrCreate(sessionId: string, options: SessionOptions): Promise<SessionContext> {
    if (this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId)!;
      existing.metadata.lastActiveAt = new Date();
      this.logger.debug({ sessionId }, '复用已存在的会话');
      return existing;
    }

    this.logger.debug({ sessionId, channel: options.channel, type: options.type, chatId: options.chatId }, '创建新会话');

    const { manager: memory, config: memoryConfig } = this.createMemory(sessionId, options);
    const agent = this.createAgent(sessionId, options, memory, memoryConfig);

    const metadata = createSessionMetadata(
      sessionId,
      options.channel,
      options.type,
      options.chatId,
      options.session
    );

    const context: SessionContext = {
      metadata,
      agent,
      memory,
      config: this.config,
    };

    this.sessions.set(sessionId, context);
    this.chatToSession.set(`${options.channel}:${options.type}:${options.chatId}`, sessionId);
    await this.enforceMaxSessions(options.chatId);

    return context;
  }

  getSessionIdByChatId(channel: string, type: string, chatId: string): string | null {
    return this.chatToSession.get(`${channel}:${type}:${chatId}`) || null;
  }

  private createMemory(sessionId: string, options: SessionOptions): { manager: SessionMemoryManager; config: MemoryConfigInternal } {
    const memoryConfig: MemoryConfigInternal = options.memoryConfig as MemoryConfigInternal ?? {
      maxContextTokens: 128000,
      compressionThreshold: 0.75,
      compressionProvider: 'openai',
      compressionModel: 'qwen3.5-plus',
    };

    const manager = new SessionMemoryManager(sessionId, memoryConfig, {
      systemPromptBuilder: this.deps.systemPromptBuilder,
    });
    return { manager, config: memoryConfig };
  }

  private createAgent(sessionId: string, options: SessionOptions, memory: SessionMemoryManager, memoryConfig: MemoryConfigInternal) {
    const llmConfig = options.llm || this.getDefaultLLMConfig();
    const maxSteps = options.maxSteps || 50;
    const systemPrompt = options.systemPrompt || this.deps.systemPromptBuilder.buildSystemPrompt({
      chatId: options.chatId,
    });

    return new AgentEngine(sessionId, {
      llm: llmConfig,
      maxSteps,
      systemPrompt,
      tools: [],
      memoryConfig: memoryConfig,
    });
  }

  private async enforceMaxSessions(chatId: string): Promise<void> {
    const sessionsForChat = this.getSessionsByChatId(chatId);

    if (sessionsForChat.length > this.config.maxSessionsPerChat) {
      const sortedSessions = sessionsForChat.sort(
        (a, b) => a.metadata.lastActiveAt.getTime() - b.metadata.lastActiveAt.getTime()
      );

      const toRemove = sortedSessions.slice(0, sessionsForChat.length - this.config.maxSessionsPerChat);
      for (const session of toRemove) {
        await this.removeSession(session.metadata.sessionId);
        this.logger.info({ sessionId: session.metadata.sessionId }, '清理超出限制的旧会话');
      }
    }
  }

  getSession(sessionId: string): SessionContext | undefined {
    return this.sessions.get(sessionId);
  }

  async removeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (session) {
      const key = `${session.metadata.channel}:${session.metadata.type}:${session.metadata.chatId}`;
      this.chatToSession.delete(key);
      await session.memory.clear();
      this.sessions.delete(sessionId);
      this.logger.info({ sessionId }, '会话已删除');
      return true;
    }
    return false;
  }

  getAllSessions(): SessionContext[] {
    return Array.from(this.sessions.values());
  }

  getSessionsByChatId(chatId: string): SessionContext[] {
    return this.getAllSessions().filter(s => s.metadata.chatId === chatId);
  }

  async cleanupInactive(maxAge: number): Promise<void> {
    const now = Date.now();
    const sessionsToRemove: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      const age = now - session.metadata.lastActiveAt.getTime();
      if (age > maxAge) {
        sessionsToRemove.push(sessionId);
      }
    }

    for (const sessionId of sessionsToRemove) {
      await this.removeSession(sessionId);
    }

    if (sessionsToRemove.length > 0) {
      this.logger.info({ count: sessionsToRemove.length }, '不活跃会话已清理');
    }
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  getStats(): { total: number; byChannel: Record<string, number>; byType: Record<string, number> } {
    const sessions = this.getAllSessions();
    const byChannel: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const session of sessions) {
      byChannel[session.metadata.channel] = (byChannel[session.metadata.channel] || 0) + 1;
      byType[session.metadata.type] = (byType[session.metadata.type] || 0) + 1;
    }

    return {
      total: sessions.length,
      byChannel,
      byType,
    };
  }

  startAutoCleanup(intervalMs: number = 3600000): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(async () => {
      if (this.config.autoCleanup) {
        await this.cleanupInactive(this.config.sessionTTL);
      }
    }, intervalMs);

    this.logger.info({ intervalMs }, '自动清理已启动');
  }

  stopAutoCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      this.logger.info('自动清理已停止');
    }
  }

  shutdown(): void {
    this.stopAutoCleanup();
    for (const session of this.sessions.values()) {
      session.memory.clear();
    }
    this.sessions.clear();
    this.logger.info('SessionRegistry shutdown');
  }
}