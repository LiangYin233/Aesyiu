import { LLMConfig } from '../llm/factory.js';
import { createUnifiedLLMClient } from '../llm/unified-client.js';
import { LLMProviderType } from '../llm/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { MessageFactory } from './message-factory.js';
import type { ToolExecuteContext, ITool } from '../tools/types.js';
import type { ILogger } from '../contracts/logger.js';
import type { ISystemPromptBuilder } from '../contracts/system-prompt-builder.js';
import type { MemoryConfig, MemoryEvent } from '../memory/types.js';
import { SessionMemoryManager } from '../memory/session-memory-manager.js';
import type { SessionMemoryManagerDependencies } from '../memory/session-memory-manager.js';
import type { MemorySnapshot } from '../memory/types.js';
import { createNoOpLogger } from '../observability/logger.js';

export enum TurnStopReason {
  Completed = 'completed',
  MaxSteps = 'maxSteps',
  Error = 'error',
}

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: {
    success: boolean;
    content: string;
    error?: string;
  };
}

export interface TurnEngineConfig {
  llmConfig: LLMConfig;
  systemPromptBuilder?: ISystemPromptBuilder;
  logger?: ILogger;
  memoryConfig?: Partial<MemoryConfig>;
  defaultTools?: ITool[];
  maxSteps?: number;
  defaultSystemPrompt?: string;
}

export interface TurnInput {
  sessionKey: string;
  input: string;
  memorySnapshot?: MemorySnapshot;
  tools?: ITool[];
  llmConfig?: LLMConfig;
  systemContext?: {
    roleId?: string;
    systemPrompt?: string;
    toolDescriptions?: string;
    skillInstructions?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface TurnResult {
  outputText: string;
  nextMemorySnapshot: MemorySnapshot;
  toolCalls: ToolCallRecord[];
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  stopReason: TurnStopReason;
  events: MemoryEvent[];
  steps: number;
  error?: string;
}

class FallbackSystemPromptBuilder implements ISystemPromptBuilder {
  buildSystemPrompt(params: { roleId?: string; chatId: string; toolDescriptions?: string; skillInstructions?: string; sessionMemory?: string }): string {
    return 'You are a helpful AI assistant.';
  }
}

export class TurnEngine {
  private config: TurnEngineConfig;
  private logger: ILogger;

  constructor(config: TurnEngineConfig) {
    this.config = config;
    this.logger = config.logger ?? createNoOpLogger();
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const llmConfig = input.llmConfig ?? this.config.llmConfig;
    const tools = input.tools ?? this.config.defaultTools ?? [];
    const maxSteps = this.config.maxSteps ?? 15;
    const systemPrompt = input.systemContext?.systemPrompt
      ?? this.config.defaultSystemPrompt
      ?? 'You are a helpful AI assistant.';

    const systemPromptBuilder = this.config.systemPromptBuilder ?? new FallbackSystemPromptBuilder();

    const memoryDeps: SessionMemoryManagerDependencies = {
      systemPromptBuilder,
      logger: this.logger,
    };
    const memory = new SessionMemoryManager(
      input.sessionKey,
      this.config.memoryConfig,
      memoryDeps
    );

    if (input.memorySnapshot) {
      memory.importMemory(input.memorySnapshot);
    } else {
      await memory.addMessage(MessageFactory.createSystemMessage(
        systemPromptBuilder.buildSystemPrompt({
          chatId: input.sessionKey,
          toolDescriptions: input.systemContext?.toolDescriptions,
          skillInstructions: input.systemContext?.skillInstructions,
        })
      ));
    }

    const collectedEvents: MemoryEvent[] = [];
    const unsubscribe = memory.onEvent((event) => {
      collectedEvents.push(event);
    });

    const client = createUnifiedLLMClient({
      provider: llmConfig.provider as LLMProviderType,
      model: llmConfig.model ?? 'gpt-4o-mini',
      apiKey: llmConfig.apiKey,
      baseUrl: llmConfig.baseUrl,
      timeout: llmConfig.timeout,
    });

    const toolRegistry = new ToolRegistry(this.logger);
    for (const tool of tools) {
      toolRegistry.register(tool);
    }

    const context: ToolExecuteContext = {
      chatId: input.sessionKey,
      senderId: 'user',
      traceId: `turn-${input.sessionKey}-${Date.now()}`,
    };

    await memory.addMessage(MessageFactory.createUserMessage(input.input));

    let step = 0;
    let totalToolCalls = 0;
    const toolCallRecords: ToolCallRecord[] = [];
    let finalText = '';
    let stopReason = TurnStopReason.Completed;
    let error: string | undefined;
    const totalTokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    try {
      while (step < maxSteps) {
        step++;

        const filteredTools = toolRegistry.getAllToolDefinitions();
        const currentMessages = memory.getMessages();

        const response = await client.generate({
          messages: [...currentMessages],
          systemPrompt,
          tools: filteredTools,
        }, {
          sessionId: input.sessionKey,
          userId: 'user',
          metadata: {
            traceId: context.traceId,
            ...(input.metadata ?? {}),
          },
        });

        if (response.finishReason === 'error') {
          throw new Error('LLM returned error');
        }

        if (response.tokenUsage) {
          totalTokenUsage.promptTokens += response.tokenUsage.promptTokens;
          totalTokenUsage.completionTokens += response.tokenUsage.completionTokens;
          totalTokenUsage.totalTokens += response.tokenUsage.totalTokens;
        }

        if (response.toolCalls && response.toolCalls.length > 0) {
          totalToolCalls += response.toolCalls.length;

          const assistantMessage = MessageFactory.createAssistantMessage(
            response.text || '',
            response.toolCalls
          );
          await memory.addMessage(assistantMessage);

          for (const tc of response.toolCalls) {
            const record: ToolCallRecord = {
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            };

            const toolRequests = [{ id: tc.id, name: tc.name, arguments: tc.arguments }];
            const results = await toolRegistry.executeTools(toolRequests, context);

            const toolResult = {
              success: results[0].success,
              content: results[0].content,
              error: results[0].error,
            };

            record.result = toolResult;
            toolCallRecords.push(record);

            const toolMessage = MessageFactory.createToolMessage(
              tc.id,
              tc.name,
              toolResult.content
            );
            await memory.addMessage(toolMessage);
          }

          continue;
        }

        finalText = response.text;
        await memory.addMessage(MessageFactory.createAssistantMessage(finalText));
        break;
      }

      if (step >= maxSteps) {
        stopReason = TurnStopReason.MaxSteps;
        finalText = `Task not completed within ${maxSteps} steps. Please simplify your request or proceed step by step.`;
      }
    } catch (err) {
      stopReason = TurnStopReason.Error;
      error = err instanceof Error ? err.message : String(err);
      finalText = `Execution error: ${error}`;
    } finally {
      unsubscribe();
      client.destroy();
    }

    const nextSnapshot = memory.exportMemory();

    return {
      outputText: finalText,
      nextMemorySnapshot: nextSnapshot,
      toolCalls: toolCallRecords,
      tokenUsage: totalTokenUsage,
      stopReason,
      events: collectedEvents,
      steps: step,
      error,
    };
  }
}
