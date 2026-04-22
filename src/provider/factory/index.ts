import type { ModelDefinition, ProviderConfig } from '../../types/index.js';
import { AnthropicProvider, ANTHROPIC_MODELS } from '../anthropic/index.js';
import { OpenAICompletionProvider, OPENAI_COMPLETION_MODELS } from '../openai-completion/index.js';
import { OpenAIResponsesProvider, OPENAI_RESPONSES_MODELS } from '../openai-responses/index.js';
import type { LLMProvider } from '../index.js';

export type LLMProviderType = 'anthropic' | 'openai-completion' | 'openai-responses';

export interface CreateLLMProviderInput {
  type: LLMProviderType;
  config: ProviderConfig;
  models: ModelDefinition[];
}

type ProviderRegistryEntry = {
  create: (config: ProviderConfig, models: ModelDefinition[]) => LLMProvider;
  models: ModelDefinition[];
};

const PROVIDERS: Record<LLMProviderType, ProviderRegistryEntry> = {
  anthropic: {
    create: (config, models) => new AnthropicProvider(config, models),
    models: ANTHROPIC_MODELS,
  },
  'openai-completion': {
    create: (config, models) => new OpenAICompletionProvider(config, models),
    models: OPENAI_COMPLETION_MODELS,
  },
  'openai-responses': {
    create: (config, models) => new OpenAIResponsesProvider(config, models),
    models: OPENAI_RESPONSES_MODELS,
  },
};

function cloneModelDefinition(model: ModelDefinition): ModelDefinition {
  return { ...model };
}

export function createLLMProvider(input: CreateLLMProviderInput): LLMProvider {
  return PROVIDERS[input.type].create(input.config, input.models);
}

export function getDefaultModels(type: LLMProviderType): ModelDefinition[] {
  return PROVIDERS[type].models.map(cloneModelDefinition);
}

export function getDefaultModel(type: LLMProviderType, modelId: string): ModelDefinition {
  const model = PROVIDERS[type].models.find((entry) => entry.id === modelId);
  if (!model) {
    throw new Error(`Model "${modelId}" not found for provider "${type}"`);
  }
  return cloneModelDefinition(model);
}
