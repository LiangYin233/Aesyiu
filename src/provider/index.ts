import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage, StreamEvent, ToolCall } from '../types/index.js';
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

export interface StreamParserLike {
  isResponseStarted(event: unknown): boolean;
  parseEvent(event: unknown): StreamEvent | undefined;
  getToolCalls(): ToolCall[] | undefined;
  getUsage(): TokenUsage | undefined;
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

  protected abstract createRequest(model: ModelDefinition, messages: Message[], tools?: Tool[], stream?: boolean): Record<string, unknown>;
  protected abstract sendRequest(request: Record<string, unknown>, options?: GenerateOptions): Promise<unknown>;
  protected abstract sendStream(request: Record<string, unknown>, options?: GenerateOptions): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;
  protected abstract parseResponse(response: unknown): { message: Message; usage: TokenUsage };
  protected abstract createStreamParser(): StreamParserLike;

  public async generate(
    model: ModelDefinition | string,
    messages: Message[],
    tools?: Tool[],
    options?: GenerateOptions,
  ): Promise<{ message: Message; usage: TokenUsage }> {
    const modelDef = this.resolveModel(model);
    const request = this.createRequest(modelDef, messages, tools, false);
    const merged = modelDef.extraBody ? { ...modelDef.extraBody, ...request } : request;
    const response = await this.sendRequest(merged, options);
    return this.parseResponse(response);
  }

  public async *generateStream(
    model: ModelDefinition | string,
    messages: Message[],
    tools?: Tool[],
    options?: GenerateOptions,
  ): AsyncGenerator<StreamEvent, void> {
    const modelDef = this.resolveModel(model);
    const request = this.createRequest(modelDef, messages, tools, true);
    const merged = modelDef.extraBody ? { ...modelDef.extraBody, ...request } : request;
    const stream = await this.sendStream(merged, options);
    const parser = this.createStreamParser();
    let responseStarted = false;
    for await (const event of stream) {
      if (!responseStarted && parser.isResponseStarted(event)) {
        responseStarted = true;
        yield { type: 'response_started' };
      }
      const streamEvent = parser.parseEvent(event);
      if (streamEvent) { yield streamEvent; }
    }
    const toolCalls = parser.getToolCalls();
    if (toolCalls) { yield { type: 'tool_calls', toolCalls }; }
    const usage = parser.getUsage();
    if (usage) { yield { type: 'usage', usage }; }
  }
}
