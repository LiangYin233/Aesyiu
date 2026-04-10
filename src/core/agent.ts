import {
  StandardMessage,
  MessageRole,
  UnifiedLLMClientConfig,
  UnifiedRequestOptions,
  LLMProviderType,
} from '../llm/types.js';
import { LLMConfig } from '../llm/factory.js';
import { UnifiedLLMClient } from '../llm/unified-client.js';
import { ToolRegistry } from '../tools/registry.js';
import { MessageFactory } from './message-factory.js';
import {
  ToolDefinition,
  ToolExecuteContext,
  ToolCallRequest,
} from '../tools/types.js';
import type { ILogger } from '../contracts/logger.js';
import {
  SessionMemoryManager,
  MemoryConfig,
} from '../memory/index.js';
import type { ISystemPromptBuilder } from '../contracts/system-prompt-builder.js';
import { createNoOpLogger } from '../observability/logger.js';

export interface AgentDeps {
  logger?: ILogger;
  systemPromptBuilder?: ISystemPromptBuilder;
  memory?: SessionMemoryManager;
}

export interface AgentConfig {
  llm: LLMConfig;
  maxSteps?: number;
  systemPrompt?: string;
  tools?: ToolDefinition[];
  memoryConfig?: Partial<MemoryConfig>;
}

export interface AgentRunResult {
  success: boolean;
  finalText: string;
  steps: number;
  toolCalls: number;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  error?: string;
}

export class AgentEngine {
  readonly chatId: string;
  private instanceId: string;
  private config: Required<AgentConfig>;
  private client: UnifiedLLMClient | null = null;
  private toolRegistry: ToolRegistry;
  private tools: ToolDefinition[];
  private maxSteps: number;
  private memory: SessionMemoryManager;
  private deps: AgentDeps;
  private logger: ILogger;
  private processingLock: Promise<AgentRunResult> | null = null;

  constructor(chatId: string, config: AgentConfig, deps: AgentDeps = {}) {
    this.chatId = chatId;
    this.instanceId = `agent-${chatId}-${Date.now()}`;
    this.deps = deps;
    this.logger = deps.logger ?? createNoOpLogger();

    this.config = {
      maxSteps: config.maxSteps || 15,
      systemPrompt: config.systemPrompt || 'You are a helpful AI assistant.',
      tools: config.tools || [],
      llm: config.llm,
      memoryConfig: config.memoryConfig ?? {
        maxContextTokens: 128000,
        compressionThreshold: 0.75,
        compressionProvider: 'openai',
        compressionModel: 'gpt-4o-mini',
      },
    };

    this.toolRegistry = new ToolRegistry(this.logger);
    this.tools = this.config.tools;
    this.maxSteps = this.config.maxSteps;

    if (deps.memory) {
      this.memory = deps.memory;
      this.logger.info(
        { chatId: this.chatId, instanceId: this.instanceId },
        'AgentEngine using injected SessionMemoryManager'
      );
    } else {
      const memoryDeps: SessionMemoryManagerDependencies = {
        systemPromptBuilder: deps.systemPromptBuilder ?? new FallbackSystemPromptBuilder(),
        logger: this.logger,
      };

      this.memory = new SessionMemoryManager(chatId, this.config.memoryConfig, memoryDeps);

      this.logger.warn(
        { chatId: this.chatId },
        'AgentEngine creating internal SessionMemoryManager. Inject memory via deps.memory for proper session management. This fallback will be removed in a future version.'
      );

      if (!this.memory.hasMessages() && this.config.systemPrompt) {
        this.memory.addMessage(MessageFactory.createSystemMessage(this.config.systemPrompt));
      }
    }

    this.logger.info(
      {
        chatId: this.chatId,
        instanceId: this.instanceId,
        model: this.config.llm.model,
        maxSteps: this.maxSteps,
        toolCount: this.tools.length,
      },
      'AgentEngine instance created'
    );
  }

  private getClient(): UnifiedLLMClient {
    if (!this.client) {
      const filteredTools = this.getFilteredTools();

      const clientConfig: UnifiedLLMClientConfig = {
        provider: this.config.llm.provider as LLMProviderType,
        model: this.config.llm.model || 'gpt-4o-mini',
        apiKey: this.config.llm.apiKey,
        baseUrl: this.config.llm.baseUrl,
        timeout: this.config.llm.timeout,
      };

      this.client = new UnifiedLLMClient(clientConfig);

      this.logger.debug(
        {
          chatId: this.chatId,
          totalTools: this.toolRegistry.getAllToolDefinitions().length,
          filteredTools: filteredTools.length,
        },
        'UnifiedLLMClient created with tools'
      );
    }
    return this.client;
  }

  async run(userInput: string): Promise<AgentRunResult> {
    if (this.processingLock) {
      this.logger.warn(
        { chatId: this.chatId },
        'Agent run already in progress, waiting for completion'
      );
      return this.processingLock;
    }

    const runPromise = this.doRun(userInput);
    this.processingLock = runPromise;

    try {
      return await runPromise;
    } finally {
      this.processingLock = null;
    }
  }

  private async doRun(userInput: string): Promise<AgentRunResult> {
    this.logger.info(
      { chatId: this.chatId, instanceId: this.instanceId, inputLength: userInput.length },
      'AgentEngine starting request processing'
    );

    await this.memory.addMessage(MessageFactory.createUserMessage(userInput));

    const client = this.getClient();

    const context: ToolExecuteContext = {
      chatId: this.chatId,
      senderId: 'user',
      traceId: this.instanceId,
    };

    let step = 0;
    let totalToolCalls = 0;
    let finalText = '';
    const totalTokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    try {
      while (step < this.maxSteps) {
        step++;
        this.logger.info(
          { chatId: this.chatId, step, maxSteps: this.maxSteps },
          `Starting step ${step}`
        );

        const filteredTools = this.getFilteredTools();
        const currentMessages = this.memory.getMessages();

        const response = await client.generate({
          messages: [...currentMessages],
          systemPrompt: this.config.systemPrompt,
          tools: filteredTools,
        }, {
          sessionId: this.chatId,
          userId: 'user',
          metadata: {
            traceId: this.instanceId,
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

          const toolNames = response.toolCalls.map(tc => tc.name).join(', ');
          this.logger.info(
            { chatId: this.chatId, step, toolCallCount: response.toolCalls.length, toolNames },
            'Tool calls detected'
          );

          const assistantMessage = MessageFactory.createAssistantMessage(
            response.text || '',
            response.toolCalls
          );
          await this.memory.addMessage(assistantMessage);

          const toolRequests: ToolCallRequest[] = response.toolCalls.map(tc => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          }));

          for (const toolRequest of toolRequests) {
            const results = await this.toolRegistry.executeTools([toolRequest], context);
            const toolResult = {
              success: results[0].success,
              content: results[0].content,
              error: results[0].error,
            };

            const toolMessage = MessageFactory.createToolMessage(
              toolRequest.id,
              toolRequest.name,
              toolResult.content
            );
            await this.memory.addMessage(toolMessage);
          }

          continue;
        }

        finalText = response.text;
        await this.memory.addMessage(MessageFactory.createAssistantMessage(finalText));

        this.logger.info(
          { chatId: this.chatId, step, responseLength: finalText.length },
          'LLM inference completed, no more tool calls'
        );
        break;
      }

      if (step >= this.maxSteps) {
        this.logger.warn(
          { chatId: this.chatId, steps: step },
          'Reached maximum reasoning step limit'
        );
        finalText = `Sorry, the task was not completed within ${this.maxSteps} steps. Please simplify your request or proceed step by step.`;
      }

      this.logger.info(
        {
          chatId: this.chatId,
          instanceId: this.instanceId,
          steps: step,
          toolCalls: totalToolCalls,
          tokenUsage: totalTokenUsage,
        },
        'AgentEngine task completed'
      );

      return {
        success: true,
        finalText,
        steps: step,
        toolCalls: totalToolCalls,
        tokenUsage: totalTokenUsage,
      };
    } catch (error) {
      this.logger.error(
        { chatId: this.chatId, instanceId: this.instanceId, error: String(error) },
        'AgentEngine execution error'
      );

      return {
        success: false,
        finalText: `Execution error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        steps: step,
        toolCalls: totalToolCalls,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getFilteredTools(): ToolDefinition[] {
    return this.toolRegistry.getAllToolDefinitions();
  }

  updateModel(model: string): void {
    this.config.llm.model = model;
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.logger.info({ chatId: this.chatId, model }, 'Agent model updated');
  }

  getMemory(): SessionMemoryManager {
    return this.memory;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }
}

import type { SessionMemoryManagerDependencies } from '../memory/session-memory-manager.js';

class FallbackSystemPromptBuilder implements ISystemPromptBuilder {
  buildSystemPrompt(params: { roleId?: string; chatId: string; toolDescriptions?: string; skillInstructions?: string; sessionMemory?: string }): string {
    return 'You are a helpful AI assistant.';
  }
}
