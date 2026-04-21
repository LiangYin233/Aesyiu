import OpenAI, { type ClientOptions as OpenAIClientOptions } from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage, StreamEvent } from '../../types/index.js';
import { LLMProvider, requireToolCallId, type GenerateOptions } from '../index.js';
import { toProviderToolParameters } from '../../tool/schema.js';

export const OPENAI_COMPLETION_MODELS: ModelDefinition[] = [
  { id: 'gpt-4o', contextWindow: 128000, maxOutputTokens: 16384 },
  { id: 'gpt-4o-mini', contextWindow: 128000, maxOutputTokens: 16384 },
  { id: 'gpt-4-turbo', contextWindow: 128000, maxOutputTokens: 4096 },
];

class StreamParser {
  private content = '';
  private toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private usage: TokenUsage | undefined;

  consume(delta: OpenAI.ChatCompletionChunk.Choice.Delta): StreamEvent | undefined {
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

  setUsage(usage: OpenAI.CompletionUsage | undefined): void {
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

  private toSDKMessages(messages: Message[]): ChatCompletionMessageParam[] {
    const sdkMessages: ChatCompletionMessageParam[] = [];

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

  private toSDKTools(tools?: Tool[]): ChatCompletionTool[] | undefined {
    return tools?.length ? tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toProviderToolParameters(tool.parameters) as Record<string, unknown>,
      },
    })) : undefined;
  }

  private fromSDKResponse(response: OpenAI.ChatCompletion): { message: Message; usage: TokenUsage } {
    const choice = response.choices[0];
    const msg = choice?.message;

    const toolCalls = msg?.tool_calls
      ?.filter((tc): tc is Extract<typeof tc, { type: 'function' }> => 'function' in tc)
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));

    const usage: TokenUsage = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    };

    return { message: this.buildAssistantMessage(msg?.content ?? null, toolCalls), usage };
  }

  public async generate(
    model: ModelDefinition | string,
    messages: Message[],
    tools?: Tool[],
    options?: GenerateOptions,
  ): Promise<{ message: Message; usage: TokenUsage }> {
    const modelDef = this.resolveModel(model);
    const sdkMessages = this.toSDKMessages(messages);
    const params: Record<string, any> = {
      model: modelDef.id,
      messages: sdkMessages,
    };
    const sdkTools = this.toSDKTools(tools);
    if (sdkTools) {
      params.tools = sdkTools;
    }
    const merged = modelDef.extraBody ? { ...modelDef.extraBody, ...params } : params;
    const response = await this.client.chat.completions.create(
      merged as OpenAI.ChatCompletionCreateParamsNonStreaming,
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
    const sdkMessages = this.toSDKMessages(messages);
    const params: Record<string, any> = {
      model: modelDef.id,
      messages: sdkMessages,
      stream: true,
      stream_options: { include_usage: true },
    };
    const sdkTools = this.toSDKTools(tools);
    if (sdkTools) {
      params.tools = sdkTools;
    }
    const merged = modelDef.extraBody ? { ...modelDef.extraBody, ...params } : params;

    const stream = await this.client.chat.completions.create(
      merged as OpenAI.ChatCompletionCreateParamsStreaming,
      options?.signal ? { signal: options.signal } : undefined,
    );

    const parser = new StreamParser();

    for await (const chunk of stream) {
      parser.setUsage(chunk.usage ?? undefined);
      const delta = chunk.choices[0]?.delta;
      if (!delta) {continue;}
      const event = parser.consume(delta);
      if (event) {yield event;}
    }

    const toolCalls = parser.getToolCalls();
    if (toolCalls) {yield { type: 'tool_calls', toolCalls };}
    const usage = parser.getUsage();
    if (usage) {yield { type: 'usage', usage };}
  }
}
