import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  ILLMProvider,
  LLMProviderType,
  LLMMode,
  StandardResponse,
  StandardStreamChunk,
  StreamCallbacks,
  ToolCall,
  LLMProviderConfig,
} from '../types.js';
import { createNoOpLogger } from '../../observability/logger.js';
import type { ILogger } from '../../contracts/logger.js';
import { PromptContext } from '../prompt-context.js';
import { TokenUsageMapper } from '../utils/token-usage-mapper.js';
import { FinishReasonMapper } from '../utils/finish-reason-mapper.js';
import { MessageTransformer } from '../transformers/message-transformer.js';
import { ToolTransformer } from '../transformers/tool-transformer.js';

export class OpenAIChatAdapter implements ILLMProvider {
  readonly providerType = LLMProviderType.OpenAIChat;
  readonly supportedModes: LLMMode[] = [LLMMode.Chat];

  private client: OpenAI;
  private model: string;
  private messageTransformer: MessageTransformer;
  private toolTransformer: ToolTransformer;
  private logger: ILogger;

  constructor(config: LLMProviderConfig) {
    const apiKey = config.apiKey;
    if (!apiKey) {
      throw new Error('OpenAI API key is required. Please configure it in config.json.');
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeout || 60000,
    });

    this.model = config.model || 'gpt-4o-mini';
    this.logger = config.logger ?? createNoOpLogger();
    
    this.messageTransformer = new MessageTransformer();
    this.toolTransformer = new ToolTransformer();

    this.logger.info(
      { provider: this.providerType, model: this.model },
      '🤖 OpenAI Chat Adapter 已初始化'
    );
  }

  validateConfig(): boolean {
    return !!this.client.apiKey;
  }

  async generate(context: PromptContext): Promise<StandardResponse> {
    const convertedMessages = this.messageTransformer.toOpenAI(
      context.messages,
      context.system.systemPrompt
    );

    const allMessages: ChatCompletionMessageParam[] = [];
    
    if (convertedMessages.systemMessage) {
      allMessages.push(convertedMessages.systemMessage);
    }
    
    allMessages.push(...convertedMessages.messages);

    const openAITools = this.toolTransformer.toOpenAI(context.tools);

    this.logger.debug(
      {
        messageCount: allMessages.length,
        hasTools: context.tools.length > 0,
        toolCount: context.tools.length,
        contextMetadata: context.metadata,
      },
      '📤 从 PromptContext 发送请求到 OpenAI Chat API'
    );

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: allMessages,
        tools: openAITools.length > 0 ? openAITools : undefined,
        tool_choice: openAITools.length > 0 ? 'auto' : undefined,
      });

      const choice = response.choices[0];
      const message = choice.message;

      const toolCalls: ToolCall[] = [];
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const tc of message.tool_calls) {
          if (tc.type === 'function' && 'function' in tc) {
            let args = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch (error) {
              this.logger.error(
                { raw: tc.function.arguments, error },
                'Failed to parse function arguments'
              );
            }
            toolCalls.push({
              id: tc.id,
              name: tc.function.name,
              arguments: args,
            });
          }
        }
      }

      const tokenUsage = TokenUsageMapper.fromOpenAI(response.usage);

      const finishReason = FinishReasonMapper.fromOpenAI(choice.finish_reason);

      this.logger.info(
        {
          finishReason,
          hasContent: !!message.content,
          toolCallCount: toolCalls.length,
          tokenUsage,
        },
        '从 PromptContext 收到 OpenAI 响应'
      );

      return {
        text: message.content || '',
        toolCalls,
        tokenUsage,
        finishReason,
        rawResponse: response,
      };
    } catch (error) {
      this.logger.error({ error }, '从 PromptContext 调用 OpenAI Chat API 失败');
      throw error;
    }
  }

  async generateStream(
    context: PromptContext,
    callbacks: StreamCallbacks
  ): Promise<AsyncIterable<StandardStreamChunk>> {
    const convertedMessages = this.messageTransformer.toOpenAI(
      context.messages,
      context.system.systemPrompt
    );

    const allMessages: ChatCompletionMessageParam[] = [];

    if (convertedMessages.systemMessage) {
      allMessages.push(convertedMessages.systemMessage);
    }

    allMessages.push(...convertedMessages.messages);

    const openAITools = this.toolTransformer.toOpenAI(context.tools);

    this.logger.debug(
      {
        messageCount: allMessages.length,
        hasTools: context.tools.length > 0,
        toolCount: context.tools.length,
        contextMetadata: context.metadata,
      },
      '📤 从 PromptContext 发送流式请求到 OpenAI Chat API'
    );

    const toolCallsMap = new Map<number, ToolCall>();
    let accumulatedText = '';
    let finishReason = '';

    async function* generateChunks(): AsyncGenerator<StandardStreamChunk> {
      const stream = await client.chat.completions.create({
        model: model,
        messages: allMessages,
        tools: openAITools.length > 0 ? openAITools : undefined,
        tool_choice: openAITools.length > 0 ? 'auto' : undefined,
        stream: true,
      });

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        if (delta.content) {
          accumulatedText += delta.content;
          if (callbacks.onToken) {
            callbacks.onToken(delta.content);
          }
          yield { type: 'text', text: delta.content };
        }

        if (delta.tool_calls && delta.tool_calls.length > 0) {
          for (const toolCallDelta of delta.tool_calls) {
            const index = toolCallDelta.index;
            let toolCall = toolCallsMap.get(index);

            if (!toolCall && toolCallDelta.id) {
              toolCall = {
                id: toolCallDelta.id,
                name: toolCallDelta.function?.name || '',
                arguments: {},
              };
              toolCallsMap.set(index, toolCall);
            } else if (toolCall && toolCallDelta.function?.arguments) {
              const existingArgs = (toolCall.arguments as Record<string, unknown>);
              try {
                const partialArgs = JSON.parse(toolCallDelta.function.arguments);
                Object.assign(existingArgs, partialArgs);
              } catch {
                // ignore partial JSON
              }
            }

            if (toolCall && callbacks.onToolCall) {
              callbacks.onToolCall(toolCall);
            }
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }

      const finalToolCalls = Array.from(toolCallsMap.values());
      const tokenUsage = TokenUsageMapper.fromOpenAI(
        (stream as unknown as { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }).usage
      );

      if (callbacks.onComplete) {
        callbacks.onComplete({
          text: accumulatedText,
          toolCalls: finalToolCalls,
          tokenUsage,
          finishReason: finishReason,
        });
      }

      yield {
        type: 'done',
        tokenUsage,
        finishReason: finishReason,
      };
    }

    const client = this.client;
    const model = this.model;

    return {
      [Symbol.asyncIterator]: generateChunks,
    };
  }
}
