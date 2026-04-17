import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage, StreamChunk } from '../types/index.js';

export interface GenerateOptions {
  signal?: AbortSignal;
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
    if (!extraBody) return baseParams;
    return { ...extraBody, ...baseParams };
  }
}
