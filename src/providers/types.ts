export enum ProviderType {
  OpenAIChat = 'openai-chat',
  OpenAICompletion = 'openai-completion',
  Anthropic = 'anthropic',
}

export interface Model {
  id: string;
  contextWindow: number;
  extraBody?: Record<string, unknown>;
}

export interface Provider {
  id: string;
  type: ProviderType;
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  models: Model[];
  extra?: Record<string, unknown>;
}

export interface RuntimeProviderState {
  getCurrentProvider(): Provider;
  getCurrentModel(): Model;
  switchProvider(provider: Provider): void;
  switchModel(modelId: string): void;
}