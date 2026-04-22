import Anthropic, { type ClientOptions as AnthropicClientOptions } from '@anthropic-ai/sdk';
import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage, StreamEvent } from '../../types/index.js';
import { LLMProvider, requireToolCallId, type GenerateOptions, type StreamParserLike } from '../index.js';
import { toProviderToolParameters } from '../../tool/schema.js';

export const ANTHROPIC_MODELS: ModelDefinition[] = [
  { id: 'claude-opus-4-7', contextWindow: 200000, maxOutputTokens: 32000 },
  { id: 'claude-sonnet-4-6', contextWindow: 1000000, maxOutputTokens: 64000 },
  { id: 'claude-haiku-4-5-20251001', contextWindow: 200000, maxOutputTokens: 16000 },
  { id: 'claude-3-5-sonnet-20241022', contextWindow: 200000, maxOutputTokens: 8192 },
  { id: 'claude-3-5-haiku-20241022', contextWindow: 200000, maxOutputTokens: 8192 },
];

type AnthropicContentBlock = Anthropic.ContentBlockParam;
type AnthropicToolUseBlock = Anthropic.ToolUseBlock;
type AnthropicToolResultBlockParam = Anthropic.ToolResultBlockParam;
type AnthropicMessageParam = Anthropic.MessageParam;
type AnthropicTool = Anthropic.Tool;

function parseToolCallArguments(toolCall: { id: string; name: string; arguments: string }): unknown {
  try {
    return JSON.parse(toolCall.arguments);
  } catch (error) {
    throw new Error(
      `Failed to parse assistant tool call arguments for "${toolCall.name}" (${toolCall.id})`,
      { cause: error },
    );
  }
}

class StreamParser implements StreamParserLike {
  private content = '';
  private toolCalls: { id: string; name: string; arguments: string }[] = [];
  private currentToolId = '';
  private currentToolName = '';
  private currentToolInput = '';
  private usage: TokenUsage | undefined;

  isResponseStarted(event: unknown): boolean {
    const e = event as Anthropic.Messages.MessageStreamEvent;
    return e.type === 'content_block_start';
  }

  parseEvent(event: unknown): StreamEvent | undefined {
    const e = event as Anthropic.Messages.MessageStreamEvent;
    switch (e.type) {
      case 'content_block_start':
        if (e.content_block.type === 'tool_use') {
          this.currentToolId = e.content_block.id;
          this.currentToolName = e.content_block.name;
          this.currentToolInput = '';
        }
        return undefined;
      case 'content_block_delta':
        if (e.delta.type === 'text_delta') {
          this.content += e.delta.text;
          return { type: 'text', delta: e.delta.text, content: this.content };
        }
        if (e.delta.type === 'input_json_delta') {
          this.currentToolInput += e.delta.partial_json;
        }
        return undefined;
      case 'content_block_stop':
        if (this.currentToolId) {
          this.toolCalls.push({
            id: this.currentToolId,
            name: this.currentToolName,
            arguments: this.currentToolInput,
          });
          this.currentToolId = '';
          this.currentToolName = '';
          this.currentToolInput = '';
        }
        return undefined;
      case 'message_delta':
        if (e.usage) {
          this.usage = {
            promptTokens: e.usage.input_tokens ?? 0,
            completionTokens: e.usage.output_tokens ?? 0,
            totalTokens: (e.usage.input_tokens ?? 0) + (e.usage.output_tokens ?? 0),
          };
        }
        return undefined;
      default:
        return undefined;
    }
  }

  getToolCalls(): { id: string; name: string; arguments: string }[] | undefined {
    return this.toolCalls.length > 0 ? this.toolCalls : undefined;
  }

  getUsage(): TokenUsage | undefined {
    return this.usage;
  }
}

export class AnthropicProvider extends LLMProvider {
  private client: Anthropic;

  constructor(config: ProviderConfig, models: ModelDefinition[]) {
    super('anthropic', config, models);

    const clientConfig: AnthropicClientOptions = {
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    };
    this.client = new Anthropic(clientConfig);
  }

  private toSDKMessages(messages: Message[]): { system?: string | Anthropic.ContentBlockParam[]; messages: AnthropicMessageParam[] } {
    const systemMessages: string[] = [];
    const sdkMessages: AnthropicMessageParam[] = [];
    let pendingToolResults: AnthropicToolResultBlockParam[] = [];

    const flushPendingToolResults = (): void => {
      if (pendingToolResults.length === 0) {
        return;
      }
      sdkMessages.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    };

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg.content ?? '');
        continue;
      }

      if (msg.role === 'tool') {
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: requireToolCallId(msg),
          content: msg.content ?? '',
        });
        continue;
      }

      flushPendingToolResults();

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
              input: parseToolCallArguments(tc),
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
        role: 'user',
        content: msg.content ?? '',
      });
    }

    flushPendingToolResults();

    return {
      system: systemMessages.length > 0 ? systemMessages.join('\n') : undefined,
      messages: sdkMessages,
    };
  }

  private toSDKTools(tools?: Tool[]): AnthropicTool[] | undefined {
    return tools?.length ? tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: toProviderToolParameters(tool.parameters) as Anthropic.Tool.InputSchema,
    })) : undefined;
  }

  protected createRequest(model: ModelDefinition, messages: Message[], tools?: Tool[]): Record<string, unknown> {
    const { system, messages: sdkMessages } = this.toSDKMessages(messages);
    const params: Record<string, unknown> = {
      model: model.id,
      max_tokens: model.maxOutputTokens,
      messages: sdkMessages,
    };
    if (system) {
      params.system = system;
    }
    const sdkTools = this.toSDKTools(tools);
    if (sdkTools) {
      params.tools = sdkTools;
    }
    return params;
  }

  protected async sendRequest(request: Record<string, unknown>, options?: GenerateOptions): Promise<unknown> {
    return this.client.messages.create(
      request as unknown as Anthropic.MessageCreateParamsNonStreaming,
      options?.signal ? { signal: options.signal } : undefined,
    );
  }

  protected async sendStream(request: Record<string, unknown>, options?: GenerateOptions): Promise<AsyncIterable<unknown>> {
    const stream = this.client.messages.stream(
      request as unknown as Anthropic.MessageCreateParamsNonStreaming,
      options?.signal ? { signal: options.signal } : undefined,
    );
    return stream as AsyncIterable<unknown>;
  }

  protected parseResponse(response: unknown): { message: Message; usage: TokenUsage } {
    const resp = response as Anthropic.Message;
    const textContents: string[] = [];
    const toolCalls: { id: string; name: string; arguments: string }[] = [];

    for (const block of resp.content) {
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

    const usage: TokenUsage = {
      promptTokens: resp.usage.input_tokens,
      completionTokens: resp.usage.output_tokens,
      totalTokens: resp.usage.input_tokens + resp.usage.output_tokens,
    };

    return { message: this.buildAssistantMessage(textContents.join(''), toolCalls), usage };
  }

  protected createStreamParser(): StreamParserLike {
    return new StreamParser();
  }
}
