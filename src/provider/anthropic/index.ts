import Anthropic, { type ClientOptions as AnthropicClientOptions } from '@anthropic-ai/sdk';
import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage, StreamEvent } from '../../types/index.js';
import { LLMProvider, requireToolCallId, type GenerateOptions } from '../index.js';
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

class StreamParser {
  private content = '';
  private toolCalls: { id: string; name: string; arguments: string }[] = [];
  private currentToolId = '';
  private currentToolName = '';
  private currentToolInput = '';
  private usage: TokenUsage | undefined;

  consume(event: Anthropic.Messages.MessageStreamEvent): StreamEvent | undefined {
    switch (event.type) {
      case 'content_block_start':
        if (event.content_block.type === 'tool_use') {
          this.currentToolId = event.content_block.id;
          this.currentToolName = event.content_block.name;
          this.currentToolInput = '';
        }
        return undefined;
      case 'content_block_delta':
        if (event.delta.type === 'text_delta') {
          this.content += event.delta.text;
          return { type: 'text', delta: event.delta.text, content: this.content };
        }
        if (event.delta.type === 'input_json_delta') {
          this.currentToolInput += event.delta.partial_json;
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
        if (event.usage) {
          this.usage = {
            promptTokens: event.usage.input_tokens ?? 0,
            completionTokens: event.usage.output_tokens ?? 0,
            totalTokens: (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0),
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

    const usage: TokenUsage = {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    };

    return { message: this.buildAssistantMessage(textContents.join(''), toolCalls), usage };
  }

  public async generate(
    model: ModelDefinition | string,
    messages: Message[],
    tools?: Tool[],
    options?: GenerateOptions,
  ): Promise<{ message: Message; usage: TokenUsage }> {
    const modelDef = this.resolveModel(model);
    const { system, messages: sdkMessages } = this.toSDKMessages(messages);
    const params: Record<string, unknown> = {
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
    const merged = modelDef.extraBody ? { ...modelDef.extraBody, ...params } : params;
    const response = await this.client.messages.create(
      merged as unknown as Anthropic.MessageCreateParamsNonStreaming,
      options?.signal ? { signal: options.signal } : undefined,
    );
    return this.fromSDKResponse(response);
  }

  public async *generateStream(
    model: ModelDefinition | string,
    messages: Message[],
    tools?: Tool[],
    options?: GenerateOptions,
  ): AsyncGenerator<StreamEvent, void> {
    const modelDef = this.resolveModel(model);
    const { system, messages: sdkMessages } = this.toSDKMessages(messages);
    const params: Record<string, unknown> = {
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
    const merged = modelDef.extraBody ? { ...modelDef.extraBody, ...params } : params;

    const stream = this.client.messages.stream(
      merged as unknown as Anthropic.MessageCreateParamsNonStreaming,
      options?.signal ? { signal: options.signal } : undefined,
    );

    const parser = new StreamParser();
    let responseStarted = false;

    for await (const event of stream) {
      if (!responseStarted && event.type === 'content_block_start') {
        responseStarted = true;
        yield { type: 'response_started' };
      }
      const streamEvent = parser.consume(event);
      if (streamEvent) {yield streamEvent;}
    }

    const toolCalls = parser.getToolCalls();
    if (toolCalls) {yield { type: 'tool_calls', toolCalls };}
    const usage = parser.getUsage();
    if (usage) {yield { type: 'usage', usage };}
  }
}
