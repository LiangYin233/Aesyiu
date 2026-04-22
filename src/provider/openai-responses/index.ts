import OpenAI, { type ClientOptions as OpenAIClientOptions } from 'openai';
import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage, StreamEvent } from '../../types/index.js';
import { LLMProvider, requireToolCallId, type GenerateOptions, type StreamParserLike } from '../index.js';
import { toProviderToolParameters } from '../../tool/schema.js';

export const OPENAI_RESPONSES_MODELS: ModelDefinition[] = [
  { id: 'gpt-4o', contextWindow: 128000, maxOutputTokens: 16384 },
  { id: 'gpt-4o-mini', contextWindow: 128000, maxOutputTokens: 16384 },
];

class StreamParser implements StreamParserLike {
  private content = '';
  private toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private refusalParts = new Map<string, string>();
  private usage: TokenUsage | undefined;

  isResponseStarted(event: unknown): boolean {
    const e = event as OpenAI.Responses.ResponseStreamEvent;
    return e.type === 'response.output_text.delta'
      || e.type === 'response.refusal.delta'
      || e.type === 'response.refusal.done'
      || e.type === 'response.function_call_arguments.delta'
      || e.type === 'response.function_call_arguments.done'
      || (e.type === 'response.output_item.done' && (e as { item?: { type?: string } }).item?.type === 'function_call');
  }

  parseEvent(event: unknown): StreamEvent | undefined {
    const e = event as OpenAI.Responses.ResponseStreamEvent;
    switch (e.type) {
      case 'response.output_text.delta':
        this.content += e.delta;
        return { type: 'text', delta: e.delta, content: this.content };
      case 'response.refusal.delta': {
        const key = `${e.output_index}:${e.content_index}`;
        const next = (this.refusalParts.get(key) ?? '') + e.delta;
        this.refusalParts.set(key, next);
        this.content += e.delta;
        return { type: 'text', delta: e.delta, content: this.content };
      }
      case 'response.refusal.done': {
        const key = `${e.output_index}:${e.content_index}`;
        const current = this.refusalParts.get(key) ?? '';
        const missing = e.refusal.startsWith(current)
          ? e.refusal.slice(current.length)
          : e.refusal;
        this.refusalParts.set(key, e.refusal);
        if (!missing) {
          return undefined;
        }
        this.content += missing;
        return { type: 'text', delta: missing, content: this.content };
      }
      case 'response.function_call_arguments.delta': {
        const current = this.toolCalls.get(e.output_index) ?? {
          id: e.item_id,
          name: '',
          arguments: '',
        };
        current.arguments += e.delta;
        this.toolCalls.set(e.output_index, current);
        return undefined;
      }
      case 'response.function_call_arguments.done': {
        const current = this.toolCalls.get(e.output_index) ?? {
          id: e.item_id,
          name: e.name,
          arguments: '',
        };
        current.id = e.item_id;
        current.name = e.name;
        current.arguments = e.arguments;
        this.toolCalls.set(e.output_index, current);
        return undefined;
      }
      case 'response.output_item.done': {
        const item = (e as { item?: { type?: string; call_id?: string; name?: string; arguments?: string } }).item;
        if (item?.type === 'function_call') {
          const current = this.toolCalls.get(e.output_index) ?? {
            id: item.call_id ?? '',
            name: item.name ?? '',
            arguments: '',
          };
          current.id = item.call_id ?? current.id;
          current.name = item.name ?? current.name;
          current.arguments ||= item.arguments ?? '';
          this.toolCalls.set(e.output_index, current);
        }
        return undefined;
      }
      case 'response.completed': {
        const resp = (e as { response?: { usage?: { input_tokens?: number; output_tokens?: number } } }).response;
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

  protected createRequest(model: ModelDefinition, messages: Message[], tools?: Tool[], stream?: boolean): Record<string, unknown> {
    const params: Record<string, unknown> = {
      model: model.id,
      input: this.toSDKInput(messages),
    };
    const sdkTools = this.toSDKTools(tools);
    if (sdkTools) {
      params.tools = sdkTools;
    }
    if (stream) {
      params.stream = true;
    }
    return params;
  }

  protected async sendRequest(request: Record<string, unknown>, options?: GenerateOptions): Promise<unknown> {
    return this.client.responses.create(
      request as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
      options?.signal ? { signal: options.signal } : undefined,
    );
  }

  protected async sendStream(request: Record<string, unknown>, options?: GenerateOptions): Promise<AsyncIterable<unknown>> {
    const stream = await this.client.responses.create(
      request as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
      options?.signal ? { signal: options.signal } : undefined,
    );
    return stream as AsyncIterable<unknown>;
  }

  protected parseResponse(response: unknown): { message: Message; usage: TokenUsage } {
    const resp = response as OpenAI.Responses.Response;
    const textParts: string[] = [];
    const toolCalls: { id: string; name: string; arguments: string }[] = [];

    for (const item of resp.output) {
      if (item.type === 'message') {
        const msgItem = item as OpenAI.Responses.ResponseOutputMessage;
        for (const content of msgItem.content) {
          if (content.type === 'output_text') {
            textParts.push((content as OpenAI.Responses.ResponseOutputText).text);
          } else if (content.type === 'refusal') {
            textParts.push(content.refusal);
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
      promptTokens: resp.usage?.input_tokens ?? 0,
      completionTokens: resp.usage?.output_tokens ?? 0,
      totalTokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
    };

    return { message: this.buildAssistantMessage(textParts.join(''), toolCalls), usage };
  }

  protected createStreamParser(): StreamParserLike {
    return new StreamParser();
  }
}
