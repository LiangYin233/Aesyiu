import { TokenUsage } from '../types.js';

interface OpenAITokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface AnthropicTokenUsage {
  input_tokens: number;
  output_tokens: number;
}

interface CompletionTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export class TokenUsageMapper {
  static fromOpenAI(usage: OpenAITokenUsage | undefined): TokenUsage | undefined {
    if (!usage) {
      return undefined;
    }
    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    };
  }

  static fromAnthropic(usage: AnthropicTokenUsage | undefined): TokenUsage | undefined {
    if (!usage) {
      return undefined;
    }
    return {
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
    };
  }

  static fromCompletion(usage: CompletionTokenUsage | undefined): TokenUsage | undefined {
    if (!usage) {
      return undefined;
    }
    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    };
  }
}
