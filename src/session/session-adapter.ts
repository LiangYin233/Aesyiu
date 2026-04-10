import type { SessionRegistryDependencies } from './session-registry.js';
import { SessionRegistry } from './session-registry.js';
import type { SessionOptions } from './types.js';
import type { MemorySnapshot } from '../memory/types.js';
import { TurnEngine, type TurnEngineConfig, type TurnInput, type TurnResult } from '../core/turn-engine.js';
import type { ITool } from '../tools/types.js';
import type { LLMConfig } from '../llm/factory.js';
import type { ISystemPromptBuilder } from '../contracts/system-prompt-builder.js';
import type { ILogger } from '../contracts/logger.js';
import { createNoOpLogger } from '../observability/logger.js';

export interface SessionAdapterConfig {
  llmConfig: LLMConfig;
  systemPromptBuilder?: ISystemPromptBuilder;
  logger?: ILogger;
  defaultTools?: ITool[];
  maxSteps?: number;
  defaultSystemPrompt?: string;
}

export class SessionAdapter {
  private registry: SessionRegistry;
  private turnEngine: TurnEngine;
  private snapshots: Map<string, MemorySnapshot> = new Map();
  private logger: ILogger;

  constructor(
    registryDeps: SessionRegistryDependencies,
    adapterConfig: SessionAdapterConfig
  ) {
    this.registry = new SessionRegistry(registryDeps);
    this.logger = adapterConfig.logger ?? createNoOpLogger();

    const turnEngineConfig: TurnEngineConfig = {
      llmConfig: adapterConfig.llmConfig,
      systemPromptBuilder: adapterConfig.systemPromptBuilder ?? registryDeps.systemPromptBuilder,
      logger: this.logger,
      defaultTools: adapterConfig.defaultTools,
      maxSteps: adapterConfig.maxSteps,
      defaultSystemPrompt: adapterConfig.defaultSystemPrompt,
    };

    this.turnEngine = new TurnEngine(turnEngineConfig);
    this.logger.info('SessionAdapter initialized');
  }

  async sendMessage(
    sessionId: string,
    options: SessionOptions,
    input: string
  ): Promise<TurnResult> {
    const context = await this.registry.getOrCreate(sessionId, options);

    const previousSnapshot = this.snapshots.get(sessionId);

    const turnInput: TurnInput = {
      sessionKey: sessionId,
      input,
      memorySnapshot: previousSnapshot,
      metadata: {
        channel: options.channel,
        type: options.type,
        chatId: options.chatId,
      },
    };

    context.metadata.lastActiveAt = new Date();

    const result = await this.turnEngine.runTurn(turnInput);

    this.snapshots.set(sessionId, result.nextMemorySnapshot);

    return result;
  }

  getSession(sessionId: string) {
    return this.registry.getSession(sessionId);
  }

  async removeSession(sessionId: string): Promise<boolean> {
    this.snapshots.delete(sessionId);
    return this.registry.removeSession(sessionId);
  }

  getSnapshot(sessionId: string): MemorySnapshot | undefined {
    return this.snapshots.get(sessionId);
  }

  getRegistry(): SessionRegistry {
    return this.registry;
  }

  startAutoCleanup(intervalMs?: number): void {
    this.registry.startAutoCleanup(intervalMs);
  }

  stopAutoCleanup(): void {
    this.registry.stopAutoCleanup();
  }

  shutdown(): void {
    this.registry.shutdown();
    this.snapshots.clear();
  }
}