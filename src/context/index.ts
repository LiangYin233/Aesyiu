import type { Message, TokenUsage, ModelDefinition } from '../types/index.js';
import type { LLMProvider } from '../provider/index.js';

export interface AgentContextConfig {
  provider: LLMProvider;
  modelId?: string;
}

export class AgentContext {
  public messages: Message[];
  public state: Record<string, any>;
  public sessionUsage: TokenUsage;
  public activeProvider!: LLMProvider;
  public activeModel!: ModelDefinition;

  constructor(config: AgentContextConfig) {
    this.messages = [];
    this.state = {};
    this.sessionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.switchLLM(config.provider, config.modelId);
  }

  public switchLLM(provider: LLMProvider, modelId?: string): void {
    const resolvedModelId = modelId ?? Array.from(provider.supportedModels.keys())[0];
    const resolvedModel = provider.getModel(resolvedModelId);
    this.activeProvider = provider;
    this.activeModel = resolvedModel;
  }

  public accumulateUsage(usage: TokenUsage): void {
    this.sessionUsage.promptTokens += usage.promptTokens;
    this.sessionUsage.completionTokens += usage.completionTokens;
    this.sessionUsage.totalTokens += usage.totalTokens;
  }
}
