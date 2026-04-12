import Anthropic, { type ClientOptions as AnthropicClientOptions } from '@anthropic-ai/sdk';
import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage } from '../../types/index.js';
import { LLMProvider } from '../index.js';

export const ANTHROPIC_MODELS: ModelDefinition[] = [
  { id: 'claude-3-5-sonnet-20241022', contextWindow: 200000, maxOutputTokens: 8192 },
  { id: 'claude-3-5-haiku-20241022', contextWindow: 200000, maxOutputTokens: 8192 },
  { id: 'claude-3-opus-20240229', contextWindow: 200000, maxOutputTokens: 4096 },
];

type AnthropicContentBlock = Anthropic.ContentBlockParam;
type AnthropicToolUseBlock = Anthropic.ToolUseBlock;
type AnthropicToolResultBlockParam = Anthropic.ToolResultBlockParam;
type AnthropicMessageParam = Anthropic.MessageParam;
type AnthropicTool = Anthropic.Tool;

export class AnthropicProvider extends LLMProvider {
  private client: Anthropic;

  constructor(config: ProviderConfig, models: ModelDefinition[]) {
    let AnthropicClient: typeof Anthropic;
    try {
      AnthropicClient = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    } catch {
      throw new Error(
        '@anthropic-ai/sdk is required for AnthropicProvider. Install it with: npm install @anthropic-ai/sdk',
      );
    }
    super('anthropic', config, models);

    const clientConfig: AnthropicClientOptions = { apiKey: config.apiKey };
    if (config.baseURL) {
      clientConfig.baseURL = config.baseURL;
    }
    this.client = new AnthropicClient(clientConfig);
  }

  private toSDKMessages(messages: Message[]): { system?: string | Anthropic.ContentBlockParam[]; messages: AnthropicMessageParam[] } {
    const systemMessages: string[] = [];
    const sdkMessages: AnthropicMessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg.content ?? '');
        continue;
      }

      if (msg.role === 'tool') {
        const contentBlocks: AnthropicToolResultBlockParam[] = [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id ?? '',
            content: msg.content ?? '',
          },
        ];
        sdkMessages.push({ role: 'user', content: contentBlocks });
        continue;
      }

      if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const contentBlocks: AnthropicContentBlock[] = [];
          if (msg.content) {
            contentBlocks.push({ type: 'text', text: msg.content });
          }
          for (const tc of msg.tool_calls) {
            contentBlocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: JSON.parse(tc.arguments),
            });
          }
          sdkMessages.push({ role: 'assistant', content: contentBlocks });
        } else {
          sdkMessages.push({
            role: 'assistant',
            content: msg.content ?? '',
          });
        }
        continue;
      }

      sdkMessages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content ?? '',
      });
    }

    return {
      system: systemMessages.length > 0 ? systemMessages.join('\n') : undefined,
      messages: sdkMessages,
    };
  }

  private toSDKTools(tools?: Tool[]): AnthropicTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  private fromSDKResponse(response: Anthropic.Message): { message: Message; usage: TokenUsage } {
    const textContents: string[] = [];
    const toolCalls: { id: string; name: string; arguments: string }[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textContents.push(block.text);
      } else if (block.type === 'tool_use') {
        const useBlock = block as AnthropicToolUseBlock;
        toolCalls.push({
          id: useBlock.id,
          name: useBlock.name,
          arguments: JSON.stringify(useBlock.input),
        });
      }
    }

    const message: Message = {
      role: 'assistant',
      content: textContents.length > 0 ? textContents.join('') : (toolCalls.length > 0 ? null : ''),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };

    const usage: TokenUsage = {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    };

    return { message, usage };
  }

  public async generate(
    modelDef: ModelDefinition,
    messages: Message[],
    tools?: Tool[],
  ): Promise<{ message: Message; usage: TokenUsage }> {
    try {
      const { system, messages: sdkMessages } = this.toSDKMessages(messages);
      const params: Record<string, any> = {
        model: modelDef.id,
        max_tokens: modelDef.maxOutputTokens,
        messages: sdkMessages,
      };
      if (system) {
        params.system = system;
      }
      const sdkTools = this.toSDKTools(tools);
      if (sdkTools) {
        params.tools = sdkTools;
      }
      const merged = this.mergeExtraBody(params, modelDef.extraBody);
      const response = await this.client.messages.create(merged as Anthropic.MessageCreateParamsNonStreaming);
      return this.fromSDKResponse(response);
    } catch (error) {
      throw error;
    }
  }

  public async *generateStream(
    modelDef: ModelDefinition,
    messages: Message[],
    tools?: Tool[],
  ): AsyncGenerator<{ message: Partial<Message>; usage?: TokenUsage }> {
    try {
      const { system, messages: sdkMessages } = this.toSDKMessages(messages);
      const params: Record<string, any> = {
        model: modelDef.id,
        max_tokens: modelDef.maxOutputTokens,
        messages: sdkMessages,
      };
      if (system) {
        params.system = system;
      }
      const sdkTools = this.toSDKTools(tools);
      if (sdkTools) {
        params.tools = sdkTools;
      }
      const merged = this.mergeExtraBody(params, modelDef.extraBody);

      const stream = this.client.messages.stream(merged as Anthropic.MessageCreateParamsNonStreaming);

      let content = '';
      const toolCalls: { id: string; name: string; arguments: string }[] = [];
      let currentToolId = '';
      let currentToolName = '';
      let currentToolInput = '';
      let finalUsage: TokenUsage | undefined;

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            currentToolId = event.content_block.id;
            currentToolName = event.content_block.name;
            currentToolInput = '';
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            content += event.delta.text;
            yield {
              message: { role: 'assistant', content: content },
            };
          } else if (event.delta.type === 'input_json_delta') {
            currentToolInput += event.delta.partial_json;
          }
        } else if (event.type === 'content_block_stop') {
          if (currentToolId) {
            toolCalls.push({
              id: currentToolId,
              name: currentToolName,
              arguments: currentToolInput || '{}',
            });
            currentToolId = '';
            currentToolName = '';
            currentToolInput = '';
          }
        } else if (event.type === 'message_delta') {
          if (event.usage) {
            finalUsage = {
              promptTokens: event.usage.input_tokens ?? 0,
              completionTokens: event.usage.output_tokens ?? 0,
              totalTokens: (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0),
            };
          }
        }
      }

      const finalMessage: Message = {
        role: 'assistant',
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
      yield { message: finalMessage, usage: finalUsage };
    } catch (error) {
      throw error;
    }
  }
}