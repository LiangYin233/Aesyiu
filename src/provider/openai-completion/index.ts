import OpenAI, { type ClientOptions as OpenAIClientOptions } from 'openai';
import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage, StreamEvent } from '../../types/index.js';
import { LLMProvider, requireToolCallId, type GenerateOptions, type StreamParserLike } from '../index.js';
import { toProviderToolParameters } from '../../tool/schema.js';

export const OPENAI_COMPLETION_MODELS: ModelDefinition[] = [
  { id: 'gpt-4o', contextWindow: 128000, maxOutputTokens: 16384 },
  { id: 'gpt-4o-mini', contextWindow: 128000, maxOutputTokens: 16384 },
  { id: 'gpt-4-turbo', contextWindow: 128000, maxOutputTokens: 4096 },
];

class StreamParser implements StreamParserLike {
  private content = '';
  private toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private usage: TokenUsage | undefined;

  isResponseStarted(event: unknown): boolean {
    const chunk = event as OpenAI.ChatCompletionChunk;
    return Boolean(chunk.choices[0]?.delta?.content) || Boolean(chunk.choices[0]?.delta?.tool_calls?.length);
  }

  parseEvent(event: unknown): StreamEvent | undefined {
    const chunk = event as OpenAI.ChatCompletionChunk;
    this.setUsage(chunk.usage ?? undefined);
    const delta = chunk.choices[0]?.delta;
    if (!delta) {return undefined;}

    if (delta.content) {
      this.content += delta.content;
      return { type: 'text', delta: delta.content, content: this.content };
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const existing = this.toolCalls.get(tc.index);
        if (!existing) {
          this.toolCalls.set(tc.index, {
            id: tc.id ?? '',
            name: tc.function?.name ?? '',
            arguments: tc.function?.arguments ?? '',
          });
        } else {
          if (tc.id) {existing.id = tc.id;}
          if (tc.function?.name) {existing.name = tc.function.name;}
          if (tc.function?.arguments) {existing.arguments += tc.function.arguments;}
        }
      }
    }

    return undefined;
  }

  private setUsage(usage: OpenAI.CompletionUsage | undefined): void {
    if (usage) {
      this.usage = {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      };
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

export class OpenAICompletionProvider extends LLMProvider {
  private client: OpenAI;

  constructor(config: ProviderConfig, models: ModelDefinition[]) {
    super('openai-completion', config, models);

    const clientConfig: OpenAIClientOptions = {
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    };
    this.client = new OpenAI(clientConfig);
  }

  private toSDKMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
    const sdkMessages: OpenAI.ChatCompletionMessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'tool') {
        sdkMessages.push({
          role: 'tool',
          tool_call_id: requireToolCallId(msg),
          content: msg.content ?? '',
        });
        continue;
      }

      if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          sdkMessages.push({
            role: 'assistant',
            content: msg.content,
            tool_calls: msg.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: tc.arguments,
              },
            })),
          });
        } else {
          sdkMessages.push({
            role: 'assistant',
            content: msg.content,
          });
        }
        continue;
      }

      sdkMessages.push({
        role: msg.role as 'system' | 'user',
        content: msg.content ?? '',
      });
    }

    return sdkMessages;
  }

  private toSDKTools(tools?: Tool[]): OpenAI.ChatCompletionTool[] | undefined {
    return tools?.length ? tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toProviderToolParameters(tool.parameters) as Record<string, unknown>,
      },
    })) : undefined;
  }

  protected createRequest(model: ModelDefinition, messages: Message[], tools?: Tool[], stream?: boolean): Record<string, unknown> {
    const params: Record<string, unknown> = {
      model: model.id,
      messages: this.toSDKMessages(messages),
    };
    const sdkTools = this.toSDKTools(tools);
    if (sdkTools) {
      params.tools = sdkTools;
    }
    if (stream) {
      params.stream = true;
      params.stream_options = { include_usage: true };
    }
    return params;
  }

  protected async sendRequest(request: Record<string, unknown>, options?: GenerateOptions): Promise<unknown> {
    return this.client.chat.completions.create(
      request as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
      options?.signal ? { signal: options.signal } : undefined,
    );
  }

  protected async sendStream(request: Record<string, unknown>, options?: GenerateOptions): Promise<AsyncIterable<unknown>> {
    const stream = await this.client.chat.completions.create(
      request as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
      options?.signal ? { signal: options.signal } : undefined,
    );
    return stream as AsyncIterable<unknown>;
  }

  protected parseResponse(response: unknown): { message: Message; usage: TokenUsage } {
    const resp = response as OpenAI.ChatCompletion;
    const choice = resp.choices[0];
    const msg = choice?.message;

    const toolCalls = msg?.tool_calls
      ?.filter((tc): tc is Extract<typeof tc, { type: 'function' }> => 'function' in tc)
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));

    const usage: TokenUsage = {
      promptTokens: resp.usage?.prompt_tokens ?? 0,
      completionTokens: resp.usage?.completion_tokens ?? 0,
      totalTokens: resp.usage?.total_tokens ?? 0,
    };

    return { message: this.buildAssistantMessage(msg?.content ?? null, toolCalls), usage };
  }

  protected createStreamParser(): StreamParserLike {
    return new StreamParser();
  }
}
