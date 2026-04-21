import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage, StreamChunk } from '../types/index.js';
import { AesyiuProgrammingError } from '../error/index.js';

export interface GenerateOptions {
  signal?: AbortSignal;
}

export function requireToolCallId(message: Message): string {
  if (!message.tool_call_id) {
    throw new AesyiuProgrammingError('Tool message is missing tool_call_id');
  }
  return message.tool_call_id;
}

export abstract class LLMProvider {
  public readonly name: string;
  public readonly supportedModels: Map<string, ModelDefinition>;
  protected config: ProviderConfig;

  constructor(name: string, config: ProviderConfig, models: ModelDefinition[]) {
    this.name = name;
    this.config = config;
    this.supportedModels = new Map();
    for (const model of models) {
      this.supportedModels.set(model.id, model);
    }
  }

  public getModel(modelId: string): ModelDefinition {
    const model = this.supportedModels.get(modelId);
    if (!model) {
      throw new Error(`Model "${modelId}" not found in provider "${this.name}"`);
    }
    return model;
  }

  public registerModel(model: ModelDefinition): void {
    this.supportedModels.set(model.id, model);
  }

  protected resolveModel(model: ModelDefinition | string): ModelDefinition {
    return typeof model === 'string' ? this.getModel(model) : model;
  }

  protected buildAssistantMessage(content: string | null, toolCalls?: Message['tool_calls']): Message {
    const hasToolCalls = Boolean(toolCalls?.length);
    return {
      role: 'assistant',
      content: content === '' && hasToolCalls ? null : content,
      ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
    };
  }

  protected getRequestOptions(options?: GenerateOptions): { signal: AbortSignal } | undefined {
    return options?.signal ? { signal: options.signal } : undefined;
  }

  protected mapTools<TResult>(
    tools: Tool[] | undefined,
    map: (tool: Tool) => TResult,
  ): TResult[] | undefined {
    return tools?.length ? tools.map(map) : undefined;
  }

  public abstract generate(
    model: ModelDefinition | string,
    messages: Message[],
    tools?: Tool[],
    options?: GenerateOptions,
  ): Promise<{ message: Message; usage: TokenUsage }>;

  public abstract generateStream(
    model: ModelDefinition | string,
    messages: Message[],
    tools?: Tool[],
    options?: GenerateOptions,
  ): AsyncGenerator<StreamChunk, void>;

  protected mergeExtraBody(
    baseParams: Record<string, any>,
    extraBody?: Record<string, unknown>,
  ): Record<string, any> {
    if (!extraBody) {return baseParams;}
    return { ...extraBody, ...baseParams };
  }
}
