import { StandardMessage } from '../llm/types.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ITool } from '../tools/types.js';
import type { ILogger } from '../contracts/logger.js';
import { MemoryConfig, CompressionPhase, type MemorySnapshot } from '../memory/index.js';
import type { ISystemPromptBuilder } from '../contracts/system-prompt-builder.js';
import { createNoOpLogger } from '../observability/logger.js';
import { TurnEngine, TurnStopReason, type ToolCallRecord } from './turn-engine.js';
import { DefaultRuntimeProviderState, type Provider, type RuntimeProviderState, type Model } from '../providers/index.js';
import { DynamicLLMClient } from '../llm/dynamic-client.js';

export interface AgentDeps {
  logger?: ILogger;
  systemPromptBuilder?: ISystemPromptBuilder;
}

export interface AgentConfig {
  provider: Provider;
  initialModelId?: string;
  maxSteps?: number;
  systemPrompt?: string;
  tools?: ITool[];
  memoryConfig?: Partial<MemoryConfig>;
}

export interface AgentRunResult {
  success: boolean;
  finalText: string;
  steps: number;
  toolCalls: number;
  stopReason: TurnStopReason;
  messages: StandardMessage[];
  memorySnapshot: MemorySnapshot;
  toolCallRecords: ToolCallRecord[];
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  error?: string;
}

export interface AgentRunInput {
  input: string;
  stateKey?: string;
  messages?: StandardMessage[];
  memorySnapshot?: MemorySnapshot;
  metadata?: Record<string, unknown>;
}

export class AgentEngine {
  readonly stateKey: string;
  private instanceId: string;
  private toolRegistry: ToolRegistry;
  private maxSteps: number;
  private deps: AgentDeps;
  private logger: ILogger;
  private providerRegistry: DefaultRuntimeProviderState;
  private llmClient: DynamicLLMClient;
  private config: AgentConfig;

  constructor(stateKey: string, config: AgentConfig, deps: AgentDeps = {}) {
    this.stateKey = stateKey;
    this.instanceId = `agent-${stateKey}-${Date.now()}`;
    this.deps = deps;
    this.logger = deps.logger ?? createNoOpLogger();

    this.config = {
      maxSteps: config.maxSteps || 15,
      systemPrompt: config.systemPrompt || 'You are a helpful AI assistant.',
      tools: config.tools || [],
      provider: config.provider,
      initialModelId: config.initialModelId,
      memoryConfig: config.memoryConfig ?? {
        maxContextTokens: 128000,
        compressionThreshold: 0.75,
        compressionProvider: 'openai',
        compressionModel: 'gpt-4o-mini',
      },
    };

    this.toolRegistry = new ToolRegistry(this.logger);
    this.maxSteps = this.config.maxSteps ?? 15;

    for (const tool of this.config.tools ?? []) {
      this.toolRegistry.register(tool);
    }

    this.providerRegistry = new DefaultRuntimeProviderState(
      this.config.provider,
      this.config.initialModelId
    );

    this.llmClient = new DynamicLLMClient({
      runtime: this.providerRegistry,
      logger: this.logger,
    });

    this.logger.info(
      {
        stateKey: this.stateKey,
        instanceId: this.instanceId,
        providerId: this.config.provider.id,
        providerType: this.config.provider.type,
        initialModelId: this.providerRegistry.getCurrentModel().id,
        maxSteps: this.maxSteps,
        toolCount: this.config.tools?.length ?? 0,
      },
      'AgentEngine instance created'
    );
  }

  async run(input: string | AgentRunInput): Promise<AgentRunResult> {
    return this.doRun(typeof input === 'string' ? { input } : input);
  }

  private async doRun(runInput: AgentRunInput): Promise<AgentRunResult> {
    this.logger.info(
      { stateKey: runInput.stateKey ?? this.stateKey, instanceId: this.instanceId, inputLength: runInput.input.length },
      'AgentEngine starting request processing'
    );

    try {
      const turnEngine = new TurnEngine({
        runtime: this.providerRegistry,
        systemPromptBuilder: this.deps.systemPromptBuilder ?? new FallbackSystemPromptBuilder(),
        logger: this.logger,
        memoryConfig: this.config.memoryConfig,
        maxSteps: this.maxSteps,
        defaultSystemPrompt: this.config.systemPrompt,
      });

      const turnResult = await turnEngine.runTurn({
        stateKey: runInput.stateKey ?? this.stateKey,
        input: runInput.input,
        messages: runInput.messages,
        memorySnapshot: runInput.memorySnapshot,
        tools: this.getRegisteredTools(),
        providerState: this.providerRegistry,
        maxSteps: this.maxSteps,
        memoryConfig: this.config.memoryConfig,
        systemContext: {
          systemPrompt: this.config.systemPrompt,
        },
        metadata: {
          traceId: this.instanceId,
          ...(runInput.metadata ?? {}),
        },
      });

      this.logger.info(
        {
          stateKey: runInput.stateKey ?? this.stateKey,
          instanceId: this.instanceId,
          steps: turnResult.steps,
          toolCalls: turnResult.toolCalls.length,
          tokenUsage: turnResult.tokenUsage,
          stopReason: turnResult.stopReason,
        },
        'AgentEngine task completed'
      );

      return {
        success: turnResult.stopReason !== TurnStopReason.Error,
        finalText: turnResult.outputText,
        steps: turnResult.steps,
        toolCalls: turnResult.toolCalls.length,
        stopReason: turnResult.stopReason,
        messages: turnResult.messages,
        memorySnapshot: turnResult.memorySnapshot,
        toolCallRecords: turnResult.toolCalls,
        tokenUsage: turnResult.tokenUsage,
        error: turnResult.error,
      };
    } catch (error) {
      this.logger.error(
        { stateKey: runInput.stateKey ?? this.stateKey, instanceId: this.instanceId, error: String(error) },
        'AgentEngine execution error'
      );

      const emptySnapshot: MemorySnapshot = {
        version: 1,
        stateKey: runInput.stateKey ?? this.stateKey,
        messages: runInput.messages ?? [],
        stats: {
          totalMessages: runInput.messages?.length ?? 0,
          totalTokens: 0,
          sacredMessages: 0,
          compressibleMessages: 0,
          compressionCount: 0,
          currentPhase: CompressionPhase.Idle,
        },
      };

      return {
        success: false,
        finalText: `Execution error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        steps: 0,
        toolCalls: 0,
        stopReason: TurnStopReason.Error,
        messages: runInput.messages ?? [],
        memorySnapshot: emptySnapshot,
        toolCallRecords: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getRegisteredTools(): ITool[] {
    return this.toolRegistry.getTools();
  }

  switchProvider(provider: Provider): void {
    this.providerRegistry.switchProvider(provider);
    this.logger.info(
      { stateKey: this.stateKey, providerId: provider.id, type: provider.type },
      'Provider switched'
    );
  }

  switchModel(modelId: string): void {
    this.providerRegistry.switchModel(modelId);
    this.logger.info({ stateKey: this.stateKey, modelId }, 'Model switched');
  }

  getCurrentProvider(): Provider {
    return this.providerRegistry.getCurrentProvider();
  }

  getCurrentModel(): Model {
    return this.providerRegistry.getCurrentModel();
  }

  unregisterTool(toolName: string): boolean {
    return this.toolRegistry.unregister(toolName);
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getProviderRegistry(): DefaultRuntimeProviderState {
    return this.providerRegistry;
  }
}

class FallbackSystemPromptBuilder implements ISystemPromptBuilder {
  buildSystemPrompt(params: { roleId?: string; chatId: string; toolDescriptions?: string; skillInstructions?: string; sessionMemory?: string }): string {
    return 'You are a helpful AI assistant.';
  }
}
