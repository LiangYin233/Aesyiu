import { type Provider, type Model, type RuntimeProviderState } from './types.js';

export class DefaultRuntimeProviderState implements RuntimeProviderState {
  private currentProvider: Provider;
  private currentModelId: string;

  constructor(provider: Provider, initialModelId?: string) {
    this.currentProvider = provider;
    this.currentModelId = initialModelId ?? provider.models[0].id;
  }

  getCurrentProvider(): Provider {
    return this.currentProvider;
  }

  getCurrentModel(): Model {
    const m = this.currentProvider.models.find(m => m.id === this.currentModelId);
    if (!m) {
      throw new Error(`Model "${this.currentModelId}" not found in provider "${this.currentProvider.id}"`);
    }
    return m;
  }

  switchProvider(provider: Provider): void {
    this.currentProvider = provider;
    this.currentModelId = provider.models[0].id;
  }

  switchModel(modelId: string): void {
    const exists = this.currentProvider.models.some(m => m.id === modelId);
    if (!exists) {
      throw new Error(`Model "${modelId}" not found in provider "${this.currentProvider.id}"`);
    }
    this.currentModelId = modelId;
  }
}