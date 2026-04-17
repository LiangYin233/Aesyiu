import OpenAI, { type ClientOptions as OpenAIClientOptions } from 'openai';
import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage, StreamChunk } from '../../types/index.js';
import { LLMProvider, type GenerateOptions } from '../index.js';

export const OPENAI_RESPONSES_MODELS: ModelDefinition[] = [
  { id: 'gpt-4o', contextWindow: 128000, maxOutputTokens: 16384 },
  { id: 'gpt-4o-mini', contextWindow: 128000, maxOutputTokens: 16384 },
];

interface StreamedToolCallState {
  id: string;
  name: string;
  arguments: string;
}

export class OpenAIResponsesProvider extends LLMProvider {
  private client: OpenAI;

  constructor(config: ProviderConfig, models: ModelDefinition[]) {
    super('openai-responses', config, models);

    const clientConfig: OpenAIClientOptions = { apiKey: config.apiKey };
    if (config.baseURL) {
      clientConfig.baseURL = config.baseURL;
    }
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
          call_id: msg.tool_call_id ?? '',
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
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown> | null,
      strict: null,
    }));
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

    const message: Message = {
      role: 'assistant',
      content: textParts.length > 0 ? textParts.join('') : (toolCalls.length > 0 ? null : ''),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };

    const usage: TokenUsage = {
      promptTokens: response.usage?.input_tokens ?? 0,
      completionTokens: response.usage?.output_tokens ?? 0,
      totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
    };

    return { message, usage };
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
    const merged = this.mergeExtraBody(params, modelDef.extraBody);
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
  ): AsyncGenerator<StreamChunk, void> {
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
    const merged = this.mergeExtraBody(params, modelDef.extraBody);

    const stream = await this.client.responses.create(
      merged as OpenAI.Responses.ResponseCreateParamsStreaming,
      options?.signal ? { signal: options.signal } : undefined,
    );

    let content = '';
    const toolCalls = new Map<number, StreamedToolCallState>();
    let finalUsage: TokenUsage | undefined;

    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        content += event.delta;
        yield { message: { role: 'assistant', content }, delta: event.delta };
      } else if (event.type === 'response.function_call_arguments.delta') {
        const current = toolCalls.get(event.output_index) ?? {
          id: event.item_id,
          name: '',
          arguments: '',
        };
        current.arguments += event.delta;
        toolCalls.set(event.output_index, current);
      } else if (event.type === 'response.function_call_arguments.done') {
        const current = toolCalls.get(event.output_index) ?? {
          id: event.item_id,
          name: event.name,
          arguments: '',
        };
        current.id = event.item_id;
        current.name = event.name;
        current.arguments = event.arguments;
        toolCalls.set(event.output_index, current);
      } else if (event.type === 'response.output_item.done') {
        const item = event.item;
        if (item?.type === 'function_call') {
          const current = toolCalls.get(event.output_index) ?? {
            id: item.call_id ?? '',
            name: item.name ?? '',
            arguments: '',
          };
          current.id = item.call_id ?? current.id;
          current.name = item.name ?? current.name;
          current.arguments = current.arguments || item.arguments || '{}';
          toolCalls.set(event.output_index, current);
        }
      } else if (event.type === 'response.completed') {
        const resp = event.response;
        if (resp?.usage) {
          finalUsage = {
            promptTokens: resp.usage.input_tokens ?? 0,
            completionTokens: resp.usage.output_tokens ?? 0,
            totalTokens: (resp.usage.input_tokens ?? 0) + (resp.usage.output_tokens ?? 0),
          };
        }
      }
    }

    const finalToolCalls = toolCalls.entries()
      .toArray()
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]) => toolCall);

    const finalMessage: Message = {
      role: 'assistant',
      content: content || null,
      ...(finalToolCalls.length > 0 ? { tool_calls: finalToolCalls } : {}),
    };
    yield { message: finalMessage, usage: finalUsage };
  }
}
