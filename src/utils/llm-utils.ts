import { LLMProviderType } from '../llm/types.js';

export function mapProviderType(type: string): LLMProviderType {
  switch (type) {
    case 'openai_chat':
      return LLMProviderType.OpenAIChat;
    case 'openai_completion':
      return LLMProviderType.OpenAICompletion;
    case 'anthropic':
      return LLMProviderType.Anthropic;
    default:
      return LLMProviderType.OpenAIChat;
  }
}