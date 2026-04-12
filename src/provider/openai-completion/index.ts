import OpenAI, { type ClientOptions as OpenAIClientOptions } from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage } from '../../types/index.js';
import { LLMProvider } from '../index.js';

export const OPENAI_COMPLETION_MODELS: ModelDefinition[] = [
  { id: 'gpt-4o', contextWindow: 128000, maxOutputTokens: 16384 },
  { id: 'gpt-4o-mini', contextWindow: 128000, maxOutputTokens: 16384 },
  { id: 'gpt-4-turbo', contextWindow: 128000, maxOutputTokens: 4096 },
];

export class OpenAICompletionProvider extends LLMProvider {
  private client: OpenAI;

  constructor(config: ProviderConfig, models: ModelDefinition[]) {
    try {
      require('openai');
    } catch {
      throw new Error(
        'openai is required for OpenAICompletionProvider. Install it with: npm install openai',
      );
    }
    super('openai-completion', config, models);

    const clientConfig: OpenAIClientOptions = { apiKey: config.apiKey };
    if (config.baseURL) {
      clientConfig.baseURL = config.baseURL;
    }
    this.client = new OpenAI(clientConfig);
  }

  private toSDKMessages(messages: Message[]): ChatCompletionMessageParam[] {
    const sdkMessages: ChatCompletionMessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'tool') {
        sdkMessages.push({
          role: 'tool',
          tool_call_id: msg.tool_call_id ?? '',
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
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
      },
    }));
  }

  private fromSDKResponse(response: OpenAI.ChatCompletion): { message: Message; usage: TokenUsage } {
    const choice = response.choices[0];
    const msg = choice?.message;

    const toolCalls = msg?.tool_calls?.map((tc) => ({
      id: tc.id,
      name: ('function' in tc ? tc.function.name : ''),
      arguments: ('function' in tc ? tc.function.arguments : ''),
    }));

    const message: Message = {
      role: 'assistant',
      content: msg?.content ?? null,
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };

    const usage: TokenUsage = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    };

    return { message, usage };
  }

  public async generate(
    modelDef: ModelDefinition,
    messages: Message[],
    tools?: Tool[],
  ): Promise<{ message: Message; usage: TokenUsage }> {
    try {
      const sdkMessages = this.toSDKMessages(messages);
      const params: Record<string, any> = {
        model: modelDef.id,
        messages: sdkMessages,
      };
      const sdkTools = this.toSDKTools(tools);
      if (sdkTools) {
        params.tools = sdkTools;
      }
      const merged = this.mergeExtraBody(params, modelDef.extraBody);
      const response = await this.client.chat.completions.create(merged as OpenAI.ChatCompletionCreateParamsNonStreaming);
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
      const merged = this.mergeExtraBody(params, modelDef.extraBody);

      const stream = await this.client.chat.completions.create(merged as OpenAI.ChatCompletionCreateParamsStreaming);

      let content = '';
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let finalUsage: TokenUsage | undefined;

      for await (const chunk of stream) {
        if (chunk.usage) {
          finalUsage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
          };
        }

        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          content += delta.content;
          yield { message: { role: 'assistant', content } };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCalls.get(tc.index);
            if (!existing) {
              toolCalls.set(tc.index, {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? '',
              });
            } else {
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            }
          }
        }
      }

      const tcArray = Array.from(toolCalls.values());
      const finalMessage: Message = {
        role: 'assistant',
        content: content || null,
        ...(tcArray.length > 0 ? { tool_calls: tcArray } : {}),
      };
      yield { message: finalMessage, usage: finalUsage };
    } catch (error) {
      throw error;
    }
  }
}