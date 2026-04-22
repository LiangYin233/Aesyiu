import type { AgentContext } from '../context/index.js';
import { isProgrammingError } from '../error/index.js';
import type { Message, TokenUsage } from '../types/index.js';

export interface MemoryManagerConfig {
  compressThresholdRatio?: number;
  retainLatestMessages?: number;
}

const DEFAULTS: Required<MemoryManagerConfig> = {
  compressThresholdRatio: 0.8,
  retainLatestMessages: 5,
};

function estimateMessageTokens(messages: readonly Message[]): number {
  return messages.reduce((total, message) => {
    const serializedToolCalls = message.tool_calls ? JSON.stringify(message.tool_calls) : '';
    const serializedMeta = message._meta ? JSON.stringify(message._meta) : '';
    const serializedMessage = [
      message.role,
      message.content ?? '',
      message.tool_call_id ?? '',
      serializedToolCalls,
      serializedMeta,
    ].join(' ');

    return total + Math.max(4, Math.ceil(serializedMessage.length / 4));
  }, 0);
}

export class MemoryManager {
  private config: Required<MemoryManagerConfig>;

  constructor(config?: MemoryManagerConfig) {
    this.config = { ...DEFAULTS, ...config };
  }

  public async checkAndOptimize(ctx: AgentContext, currentApiUsage: TokenUsage, signal?: AbortSignal): Promise<void> {
    ctx.accumulateUsage(currentApiUsage);

    await this.optimizeIfNeeded(ctx, currentApiUsage.promptTokens, signal);
  }

  public async optimizeIfNeeded(ctx: AgentContext, promptTokens?: number, signal?: AbortSignal): Promise<void> {
    const estimatedPromptTokens = Math.max(promptTokens ?? 0, estimateMessageTokens(ctx.messages));

    const threshold = ctx.activeModel.contextWindow * this.config.compressThresholdRatio;
    if (estimatedPromptTokens <= threshold) {
      return;
    }

    const systemMessages: Message[] = [];
    const nonSystem: Message[] = [];
    for (const message of ctx.messages) {
      if (message.role === 'system') {
        systemMessages.push(message);
      } else {
        nonSystem.push(message);
      }
    }

    const retainCount = Number.isFinite(this.config.retainLatestMessages)
      ? Math.max(0, Math.trunc(this.config.retainLatestMessages))
      : DEFAULTS.retainLatestMessages;
    let splitIndex = Math.min(nonSystem.length, Math.max(0, nonSystem.length - retainCount));
    while (splitIndex > 0 && splitIndex < nonSystem.length && nonSystem[splitIndex].role === 'tool') {
      splitIndex--;
    }

    const compressible = nonSystem.slice(0, splitIndex);
    const protectedLatest = nonSystem.slice(splitIndex);

    if (compressible.length === 0) {
      return;
    }

    try {
      const summary = await this.compressMessages(ctx, compressible, signal);
      ctx.replaceMessages([...systemMessages, summary, ...protectedLatest]);
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw error;
      }
      if (isProgrammingError(error)) {
        throw error;
      }
      console.warn('[aesyiu] memory compression failed; keeping existing history', error);
    }
  }

  private async compressMessages(ctx: AgentContext, messages: Message[], signal?: AbortSignal): Promise<Message> {
    const conversationSummary = messages
      .map((m) => `${m.role}: ${m.content ?? (m.tool_calls ? JSON.stringify(m.tool_calls) : '')}`)
      .join('\n');

    const summaryMessages: Message[] = [{
      role: 'system',
      content: 'Please summarize the following conversation history, preserving key information and context.',
    }, {
      role: 'user',
      content: conversationSummary,
    }];

    const { message, usage } = await ctx.activeProvider.generate(
      ctx.activeModel,
      summaryMessages,
      undefined,
      signal ? { signal } : undefined,
    );
    ctx.accumulateUsage(usage);

    return {
      role: 'user',
      content: `[Summary of earlier conversation] ${message.content ?? ''}`,
    };
  }
}
