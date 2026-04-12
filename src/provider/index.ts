import type { Message, ModelDefinition, ProviderConfig, Tool, TokenUsage } from '../types/index.js';

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

  public abstract generate(
    modelDef: ModelDefinition,
    messages: Message[],
    tools?: Tool[],
  ): Promise<{ message: Message; usage: TokenUsage }>;

  public abstract generateStream(...args: any[]): AsyncGenerator<any>;

  protected mergeExtraBody(
    baseParams: Record<string, any>,
    extraBody?: Record<string, any>,
  ): Record<string, any> {
    if (!extraBody) return baseParams;
    const merged = { ...extraBody, ...baseParams };
    return merged;
  }
}