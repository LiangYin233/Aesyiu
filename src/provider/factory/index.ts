import type { ModelDefinition, ProviderConfig } from '../../types/index.js';
import { AnthropicProvider, ANTHROPIC_MODELS } from '../anthropic/index.js';
import { OpenAICompletionProvider, OPENAI_COMPLETION_MODELS } from '../openai-completion/index.js';
import { OpenAIResponsesProvider, OPENAI_RESPONSES_MODELS } from '../openai-responses/index.js';
import { LLMProvider } from '../index.js';

export type LLMProviderType = 'anthropic' | 'openai-completion' | 'openai-responses';

export interface CreateLLMProviderInput {
  type: LLMProviderType;
  config: ProviderConfig;
  models: ModelDefinition[];
}

function cloneModelDefinition(model: ModelDefinition): ModelDefinition {
  return structuredClone(model);
}

export function createLLMProvider(input: CreateLLMProviderInput): LLMProvider {
  switch (input.type) {
    case 'anthropic':
      return new AnthropicProvider(input.config, input.models);
    case 'openai-completion':
      return new OpenAICompletionProvider(input.config, input.models);
    case 'openai-responses':
      return new OpenAIResponsesProvider(input.config, input.models);
  }
}

export function getDefaultModels(type: LLMProviderType): ModelDefinition[] {
  switch (type) {
    case 'anthropic':
      return ANTHROPIC_MODELS.map(cloneModelDefinition);
    case 'openai-completion':
      return OPENAI_COMPLETION_MODELS.map(cloneModelDefinition);
    case 'openai-responses':
      return OPENAI_RESPONSES_MODELS.map(cloneModelDefinition);
  }
}

export function getDefaultModel(type: LLMProviderType, modelId: string): ModelDefinition {
  const model = getDefaultModels(type).find((entry) => entry.id === modelId);
  if (!model) {
    throw new Error(`Model "${modelId}" not found for provider "${type}"`);
  }
  return model;
}
