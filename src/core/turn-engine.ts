import { type StandardMessage, MessageRole } from '../llm/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { MessageFactory } from './message-factory.js';
import type { ToolExecuteContext, ITool } from '../tools/types.js';
import type { ILogger } from '../contracts/logger.js';
import type { ISystemPromptBuilder } from '../contracts/system-prompt-builder.js';
import type { MemoryConfig, MemoryEvent, MemorySnapshot } from '../memory/types.js';
import { MemoryStateManager } from '../memory/memory-state-manager.js';
import type { MemoryStateManagerDependencies } from '../memory/memory-state-manager.js';
import { createNoOpLogger } from '../observability/logger.js';
import { DynamicLLMClient } from '../llm/dynamic-client.js';
import type { RuntimeProviderState } from '../providers/types.js';

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
  runtime: RuntimeProviderState;
  systemPromptBuilder?: ISystemPromptBuilder;
  logger?: ILogger;
  memoryConfig?: Partial<MemoryConfig>;
  defaultTools?: ITool[];
  maxSteps?: number;
  defaultSystemPrompt?: string;
}

export interface TurnInput {
  stateKey?: string;
  input: string;
  messages?: StandardMessage[];
  memorySnapshot?: MemorySnapshot;
  tools?: ITool[];
  providerState?: RuntimeProviderState;
  maxSteps?: number;
  memoryConfig?: Partial<MemoryConfig>;
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
  messages: StandardMessage[];
  memorySnapshot: MemorySnapshot;
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
    const stateKey = input.stateKey ?? 'default';
    const runtime = input.providerState ?? this.config.runtime;
    const tools = input.tools ?? this.config.defaultTools ?? [];
    const maxSteps = input.maxSteps ?? this.config.maxSteps ?? 15;
    const memoryConfig = input.memoryConfig ?? this.config.memoryConfig;
    const systemPrompt = input.systemContext?.systemPrompt
      ?? this.config.defaultSystemPrompt
      ?? 'You are a helpful AI assistant.';

    const systemPromptBuilder = this.config.systemPromptBuilder ?? new FallbackSystemPromptBuilder();

    const memoryDeps: MemoryStateManagerDependencies = {
      systemPromptBuilder,
      logger: this.logger,
    };
    const memory = new MemoryStateManager(
      stateKey,
      memoryConfig,
      memoryDeps
    );

    const resolvedSystemPrompt = input.systemContext?.systemPrompt
      ?? systemPromptBuilder.buildSystemPrompt({
        chatId: stateKey,
        toolDescriptions: input.systemContext?.toolDescriptions,
        skillInstructions: input.systemContext?.skillInstructions,
      });

    if (input.memorySnapshot) {
      memory.importMemory({
        ...input.memorySnapshot,
        stateKey,
        messages: input.messages ? [...input.messages] : input.memorySnapshot.messages,
      });
      this.upsertSystemPrompt(memory, resolvedSystemPrompt);
    } else if (input.messages && input.messages.length > 0) {
      const emptySnapshot = memory.exportMemory();
      memory.importMemory({
        ...emptySnapshot,
        stateKey,
        messages: [...input.messages],
      });
      this.upsertSystemPrompt(memory, resolvedSystemPrompt);
    } else {
      await memory.addMessage(MessageFactory.createSystemMessage(resolvedSystemPrompt));
    }

    const collectedEvents: MemoryEvent[] = [];
    const unsubscribe = memory.onEvent((event) => {
      collectedEvents.push(event);
    });

    const client = new DynamicLLMClient({ runtime });

    const toolRegistry = new ToolRegistry(this.logger);
    for (const tool of tools) {
      toolRegistry.register(tool);
    }

    const context: ToolExecuteContext = {
      chatId: stateKey,
      senderId: 'user',
      traceId: `turn-${stateKey}-${Date.now()}`,
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

        const currentModel = runtime.getCurrentModel();
        memory.setRuntimeContextWindow(currentModel.contextWindow);

        const filteredTools = toolRegistry.getAllToolDefinitions();
        const currentMessages = memory.getMessages();

        const response = await client.generate({
          messages: [...currentMessages],
          systemPrompt,
          tools: filteredTools,
        }, {
          conversationId: stateKey,
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
              this.buildToolMessageContent(toolResult)
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
      messages: nextSnapshot.messages,
      memorySnapshot: nextSnapshot,
      toolCalls: toolCallRecords,
      tokenUsage: totalTokenUsage,
      stopReason,
      events: collectedEvents,
      steps: step,
      error,
    };
  }

  private buildToolMessageContent(result: { success: boolean; content: string; error?: string }): string {
    if (result.success) {
      return result.content;
    }

    if (result.error && result.content) {
      return `Tool execution failed: ${result.error}\n\n${result.content}`;
    }

    if (result.error) {
      return `Tool execution failed: ${result.error}`;
    }

    return result.content;
  }

  private upsertSystemPrompt(memory: MemoryStateManager, prompt: string): void {
    const messages = memory.getMessagesCopy();

    if (messages.length > 0 && messages[0].role === MessageRole.System) {
      messages[0] = {
        ...messages[0],
        content: prompt,
      };
    } else {
      messages.unshift(MessageFactory.createSystemMessage(prompt));
    }

    memory.importMemory({
      ...memory.exportMemory(),
      messages,
    });
  }
}
