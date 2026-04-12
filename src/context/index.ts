import type { Message, TokenUsage, ModelDefinition, ProviderConfig } from '../types/index.js';
import type { LLMProvider } from '../provider/index.js';

export interface AgentContextConfig {
  providers: Map<string, LLMProvider>;
  defaultProvider: string;
  defaultModel?: string;
}

export class AgentContext {
  public messages: Message[];
  public state: Record<string, any>;
  public sessionUsage: TokenUsage;
  public activeProvider!: LLMProvider;
  public activeModel!: ModelDefinition;
  private availableProviders: Map<string, LLMProvider>;

  constructor(config: AgentContextConfig) {
    this.messages = [];
    this.state = {};
    this.sessionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.availableProviders = config.providers;
    this.switchLLM(config.defaultProvider, config.defaultModel);
  }

  public switchLLM(providerName: string, modelId?: string): void {
    const provider = this.availableProviders.get(providerName);
    if (!provider) {
      throw new Error(`Provider "${providerName}" not found`);
    }
    this.activeProvider = provider;
    const resolvedModelId = modelId ?? Array.from(provider.supportedModels.keys())[0];
    this.activeModel = provider.getModel(resolvedModelId);
  }

  public accumulateUsage(usage: TokenUsage): void {
    this.sessionUsage.promptTokens += usage.promptTokens;
    this.sessionUsage.completionTokens += usage.completionTokens;
    this.sessionUsage.totalTokens += usage.totalTokens;
  }
}