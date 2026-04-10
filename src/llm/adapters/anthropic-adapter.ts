import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import {
  ILLMProvider,
  LLMProviderType,
  LLMMode,
  StandardMessage,
  StandardResponse,
  StandardStreamChunk,
  StreamCallbacks,
  ToolCall,
  LLMProviderConfig,
  AnthropicConvertedMessages,
  AnthropicToolDefinition,
} from '../types.js';
import { ToolDefinition, ToolParameters } from '../../tools/types.js';
import { createNoOpLogger } from '../../observability/logger.js';
import type { ILogger } from '../../contracts/logger.js';
import { PromptContext } from '../prompt-context.js';
import { TokenUsageMapper } from '../utils/token-usage-mapper.js';
import { FinishReasonMapper } from '../utils/finish-reason-mapper.js';

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export class AnthropicAdapter implements ILLMProvider {
  readonly providerType = LLMProviderType.Anthropic;
  readonly supportedModes: LLMMode[] = [LLMMode.Chat];

  private client: Anthropic;
  private model: string;
  private logger: ILogger;

  constructor(config: LLMProviderConfig) {
    const apiKey = config.apiKey;
    if (!apiKey) {
      throw new Error('Anthropic API key is required. Please configure it in config.json.');
    }

    this.client = new Anthropic({
      apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeout || 60000,
    });

    this.model = config.model || 'claude-sonnet-4-20250514';
    this.logger = config.logger ?? createNoOpLogger();

    this.logger.info(
      { provider: this.providerType, model: this.model },
      'Anthropic Claude Adapter 已初始化'
    );
  }

  validateConfig(): boolean {
    return !!this.client.apiKey;
  }

  private formatMessages(messages: StandardMessage[], systemPrompt?: string): AnthropicConvertedMessages {
    const result: AnthropicMessage[] = [];
    let currentUserContent: AnthropicContentBlock[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        continue;
      }

      if (msg.role === 'assistant' && currentUserContent.length > 0) {
        result.push({ role: 'user', content: currentUserContent });
        currentUserContent = [];
      }

      const converted = this.convertMessage(msg, currentUserContent);

      if (converted) {
        result.push(converted.message);
        currentUserContent = converted.newCurrentContent;
      }
    }

    if (currentUserContent.length > 0) {
      result.push({ role: 'user', content: currentUserContent });
    }

    return { systemPrompt, messages: result };
  }

  private convertMessage(
    msg: StandardMessage,
    currentUserContent: AnthropicContentBlock[]
  ): { message: AnthropicMessage; newCurrentContent: AnthropicContentBlock[] } | null {
    switch (msg.role) {
      case 'user':
        currentUserContent.push({ type: 'text', text: msg.content });
        return null;

      case 'assistant': {
        const assistantContent: AnthropicContentBlock[] = [];

        if (msg.content) {
          assistantContent.push({ type: 'text', text: msg.content });
        }

        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            assistantContent.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
        }

        return {
          message: { role: 'assistant', content: assistantContent },
          newCurrentContent: [],
        };
      }

      case 'tool':
        currentUserContent.push({
          type: 'tool_result',
          tool_use_id: msg.toolCallId || `tool_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          content: msg.content,
        });
        return null;

      default:
        return null;
    }
  }

  private formatTools(tools: ToolDefinition[]): AnthropicToolDefinition[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: this.transformParameters(tool.parameters),
    }));
  }

  private transformParameters(parameters: ToolParameters): ToolParameters {
    return {
      type: parameters.type || 'object',
      properties: parameters.properties || {},
      required: parameters.required,
      additionalProperties: parameters.additionalProperties,
    };
  }

  async generate(context: PromptContext): Promise<StandardResponse> {
    const convertedMessages = this.formatMessages(
      context.messages,
      context.system.systemPrompt
    );

    const anthropicTools = this.formatTools(context.tools);

    this.logger.debug(
      {
        messageCount: convertedMessages.messages.length,
        hasTools: context.tools.length > 0,
        toolCount: context.tools.length,
        contextMetadata: context.metadata,
      },
      '从 PromptContext 发送请求到 Anthropic Claude API'
    );

    try {
      const response = await this.client.messages.create({
        model: this.model,
        system: convertedMessages.systemPrompt || context.system.systemPrompt,
        messages: convertedMessages.messages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        max_tokens: context.metadata?.maxTokens || 8192,
        ...(context.providerExtra ?? {}),
        ...(context.modelExtraBody ?? {}),
      });

      const toolCalls: ToolCall[] = [];
      const contentBlocks = response.content;
      let text = '';

      for (const block of contentBlocks) {
        if (block.type === 'text') {
          text += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          });
        }
      }

      const tokenUsage = TokenUsageMapper.fromAnthropic(response.usage);

      const finishReason = FinishReasonMapper.fromAnthropic(response.stop_reason);

      this.logger.info(
        {
          finishReason,
          hasContent: !!text,
          toolCallCount: toolCalls.length,
          tokenUsage,
        },
        '从 PromptContext 收到 Anthropic Claude 响应'
      );

      return {
        text: text.trim(),
        toolCalls,
        tokenUsage,
        finishReason,
        rawResponse: response,
      };
    } catch (error) {
      this.logger.error({ error }, '从 PromptContext 调用 Anthropic Claude API 失败');
      throw error;
    }
  }

  async generateStream(
    context: PromptContext,
    callbacks: StreamCallbacks
  ): Promise<AsyncIterable<StandardStreamChunk>> {
    const convertedMessages = this.formatMessages(
      context.messages,
      context.system.systemPrompt
    );

    const anthropicTools = this.formatTools(context.tools);

    this.logger.debug(
      {
        messageCount: convertedMessages.messages.length,
        hasTools: context.tools.length > 0,
        toolCount: context.tools.length,
        contextMetadata: context.metadata,
      },
      '从 PromptContext 发送流式请求到 Anthropic Claude API'
    );

    const toolCallsMap = new Map<number, ToolCall>();
    let accumulatedText = '';

    async function* generateChunks(): AsyncGenerator<StandardStreamChunk> {
      const stream = await client.messages.stream({
        model: model,
        system: convertedMessages.systemPrompt || context.system.systemPrompt,
        messages: convertedMessages.messages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        max_tokens: context.metadata?.maxTokens || 8192,
        ...(context.providerExtra ?? {}),
        ...(context.modelExtraBody ?? {}),
      });

      for await (const event of stream) {
        if (event.type === 'message_delta' && event.usage) {
          const tokenUsage = TokenUsageMapper.fromAnthropic({
            input_tokens: 0,
            output_tokens: event.usage.output_tokens,
          });
          yield {
            type: 'done',
            tokenUsage,
            finishReason: 'stop',
          };
        }

        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta' && delta.text) {
            accumulatedText += delta.text;
            if (callbacks.onToken) {
              callbacks.onToken(delta.text);
            }
            yield { type: 'text', text: delta.text };
          }

          if (delta.type === 'input_json_delta' && delta.partial_json) {
            const blockIndex = event.index;
            let toolCall = toolCallsMap.get(blockIndex);
            if (toolCall) {
              try {
                const partialArgs = JSON.parse(delta.partial_json);
                Object.assign(toolCall.arguments, partialArgs);
              } catch {
                // ignore partial JSON
              }
            }
          }
        }

        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            const toolCall: ToolCall = {
              id: block.id || '',
              name: block.name || '',
              arguments: {},
            };
            toolCallsMap.set(event.index, toolCall);
          }
        }

        if (event.type === 'message_stop') {
          const finalToolCalls = Array.from(toolCallsMap.values());
          for (const tc of finalToolCalls) {
            if (callbacks.onToolCall) {
              callbacks.onToolCall(tc);
            }
            yield { type: 'tool_call', toolCall: tc };
          }

          if (callbacks.onComplete) {
            callbacks.onComplete({
              text: accumulatedText,
              toolCalls: finalToolCalls,
              finishReason: 'stop',
            });
          }
        }
      }
    }

    const client = this.client;
    const model = this.model;

    return {
      [Symbol.asyncIterator]: generateChunks,
    };
  }
}