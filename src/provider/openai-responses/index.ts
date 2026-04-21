import OpenAI, { type ClientOptions as OpenAIClientOptions } from 'openai';
import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage, StreamEvent } from '../../types/index.js';
import { LLMProvider, requireToolCallId, type GenerateOptions } from '../index.js';
import { toProviderToolParameters } from '../../tool/schema.js';

export const OPENAI_RESPONSES_MODELS: ModelDefinition[] = [
  { id: 'gpt-4o', contextWindow: 128000, maxOutputTokens: 16384 },
  { id: 'gpt-4o-mini', contextWindow: 128000, maxOutputTokens: 16384 },
];

class StreamParser {
  private content = '';
  private toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private usage: TokenUsage | undefined;

  consume(event: OpenAI.Responses.ResponseStreamEvent): StreamEvent | undefined {
    switch (event.type) {
      case 'response.output_text.delta':
        this.content += event.delta;
        return { type: 'text', delta: event.delta, content: this.content };
      case 'response.function_call_arguments.delta': {
        const current = this.toolCalls.get(event.output_index) ?? {
          id: event.item_id,
          name: '',
          arguments: '',
        };
        current.arguments += event.delta;
        this.toolCalls.set(event.output_index, current);
        return undefined;
      }
      case 'response.function_call_arguments.done': {
        const current = this.toolCalls.get(event.output_index) ?? {
          id: event.item_id,
          name: event.name,
          arguments: '',
        };
        current.id = event.item_id;
        current.name = event.name;
        current.arguments = event.arguments;
        this.toolCalls.set(event.output_index, current);
        return undefined;
      }
      case 'response.output_item.done': {
        const item = event.item;
        if (item?.type === 'function_call') {
          const current = this.toolCalls.get(event.output_index) ?? {
            id: item.call_id ?? '',
            name: item.name ?? '',
            arguments: '',
          };
          current.id = item.call_id ?? current.id;
          current.name = item.name ?? current.name;
          current.arguments ||= item.arguments ?? '';
          this.toolCalls.set(event.output_index, current);
        }
        return undefined;
      }
      case 'response.completed': {
        const resp = event.response;
        if (resp?.usage) {
          this.usage = {
            promptTokens: resp.usage.input_tokens ?? 0,
            completionTokens: resp.usage.output_tokens ?? 0,
            totalTokens: (resp.usage.input_tokens ?? 0) + (resp.usage.output_tokens ?? 0),
          };
        }
        return undefined;
      }
      default:
        return undefined;
    }
  }

  getToolCalls(): { id: string; name: string; arguments: string }[] | undefined {
    if (this.toolCalls.size === 0) {return undefined;}
    return Array.from(this.toolCalls.entries())
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => tc);
  }

  getUsage(): TokenUsage | undefined {
    return this.usage;
  }
}

export class OpenAIResponsesProvider extends LLMProvider {
  private client: OpenAI;

  constructor(config: ProviderConfig, models: ModelDefinition[]) {
    super('openai-responses', config, models);

    const clientConfig: OpenAIClientOptions = {
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    };
    this.client = new OpenAI(clientConfig);
  }

  private toSDKInput(messages: Message[]): OpenAI.Responses.ResponseInputItem[] {
    const input: OpenAI.Responses.ResponseInputItem[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        input.push({
          role: 'system',
          content: msg.content ?? '',
        } as OpenAI.Responses.EasyInputMessage);
        continue;
      }

      if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: requireToolCallId(msg),
          output: msg.content ?? '',
        } as OpenAI.Responses.ResponseInputItem.FunctionCallOutput);
        continue;
      }

      if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            input.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            } as OpenAI.Responses.ResponseFunctionToolCall);
          }
          if (msg.content) {
            input.push({
              role: 'assistant',
              content: msg.content,
            } as OpenAI.Responses.EasyInputMessage);
          }
        } else {
          input.push({
            role: 'assistant',
            content: msg.content ?? '',
          } as OpenAI.Responses.EasyInputMessage);
        }
        continue;
      }

      input.push({
        role: msg.role as 'user' | 'developer',
        content: msg.content ?? '',
      } as OpenAI.Responses.EasyInputMessage);
    }

    return input;
  }

  private toSDKTools(tools?: Tool[]): OpenAI.Responses.Tool[] | undefined {
    return tools?.length ? tools.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: toProviderToolParameters(tool.parameters) as Record<string, unknown> | null,
      strict: null,
    })) : undefined;
  }

  private fromSDKResponse(response: OpenAI.Responses.Response): { message: Message; usage: TokenUsage } {
    const textParts: string[] = [];
    const toolCalls: { id: string; name: string; arguments: string }[] = [];

    for (const item of response.output) {
      if (item.type === 'message') {
        const msgItem = item as OpenAI.Responses.ResponseOutputMessage;
        for (const content of msgItem.content) {
          if (content.type === 'output_text') {
            textParts.push((content as OpenAI.Responses.ResponseOutputText).text);
          }
        }
      } else if (item.type === 'function_call') {
        const fc = item as OpenAI.Responses.ResponseFunctionToolCall;
        toolCalls.push({
          id: fc.call_id,
          name: fc.name,
          arguments: fc.arguments,
        });
      }
    }

    const usage: TokenUsage = {
      promptTokens: response.usage?.input_tokens ?? 0,
      completionTokens: response.usage?.output_tokens ?? 0,
      totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
    };

    return { message: this.buildAssistantMessage(textParts.join(''), toolCalls), usage };
  }

  public async generate(
    model: ModelDefinition | string,
    messages: Message[],
    tools?: Tool[],
    options?: GenerateOptions,
  ): Promise<{ message: Message; usage: TokenUsage }> {
    const modelDef = this.resolveModel(model);
    const input = this.toSDKInput(messages);
    const params: Record<string, any> = {
      model: modelDef.id,
      input,
    };
    const sdkTools = this.toSDKTools(tools);
    if (sdkTools) {
      params.tools = sdkTools;
    }
    const merged = modelDef.extraBody ? { ...modelDef.extraBody, ...params } : params;
    const response = await this.client.responses.create(
      merged as OpenAI.Responses.ResponseCreateParamsNonStreaming,
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
    const input = this.toSDKInput(messages);
    const params: Record<string, any> = {
      model: modelDef.id,
      input,
      stream: true,
    };
    const sdkTools = this.toSDKTools(tools);
    if (sdkTools) {
      params.tools = sdkTools;
    }
    const merged = modelDef.extraBody ? { ...modelDef.extraBody, ...params } : params;

    const stream = await this.client.responses.create(
      merged as OpenAI.Responses.ResponseCreateParamsStreaming,
      options?.signal ? { signal: options.signal } : undefined,
    );

    const parser = new StreamParser();

    for await (const event of stream) {
      const streamEvent = parser.consume(event);
      if (streamEvent) {yield streamEvent;}
    }

    const toolCalls = parser.getToolCalls();
    if (toolCalls) {yield { type: 'tool_calls', toolCalls };}
    const usage = parser.getUsage();
    if (usage) {yield { type: 'usage', usage };}
  }
}
