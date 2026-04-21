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

export class MemoryManager {
  private config: Required<MemoryManagerConfig>;

  constructor(config?: MemoryManagerConfig) {
    this.config = { ...DEFAULTS, ...config };
  }

  public async checkAndOptimize(ctx: AgentContext, currentApiUsage: TokenUsage): Promise<void> {
    ctx.accumulateUsage(currentApiUsage);

    const threshold = ctx.activeModel.contextWindow * this.config.compressThresholdRatio;
    if (currentApiUsage.promptTokens <= threshold) {
      return;
    }

    const pinned: Message[] = [];
    const rest: Message[] = [];
    for (const message of ctx.messages) {
      (message._meta?.isPinned ? pinned : rest).push(message);
    }

    const retainCount = this.config.retainLatestMessages;
    let splitIndex = Math.max(0, rest.length - retainCount);
    while (splitIndex > 0 && rest[splitIndex].role === 'tool') {
      splitIndex--;
    }

    const compressible = rest.slice(0, splitIndex);
    const protectedLatest = rest.slice(splitIndex);

    if (compressible.length === 0) {
      return;
    }

    try {
      const summary = await this.compressMessages(ctx, compressible);
      ctx.replaceMessages([...pinned, summary, ...protectedLatest]);
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw error;
      }
      if (isProgrammingError(error)) {
        throw error;
      }
      console.warn('[aesyiu] memory compression failed; dropping compressible history', error);
      ctx.replaceMessages([...pinned, ...protectedLatest]);
    }
  }

  private async compressMessages(ctx: AgentContext, messages: Message[]): Promise<Message> {
    const conversationSummary = messages
      .map((m) => `${m.role}: ${m.content ?? (m.tool_calls ? JSON.stringify(m.tool_calls) : '')}`)
      .join('\n');

    const summaryPrompt: Message = {
      role: 'system',
      content: `Please summarize the following conversation history, preserving key information and context:\n\n${conversationSummary}`,
    };

    const { message, usage } = await ctx.activeProvider.generate(ctx.activeModel, [summaryPrompt]);
    ctx.accumulateUsage(usage);

    return {
      role: 'system',
      content: `[Summary of earlier conversation] ${message.content ?? ''}`,
      _meta: { isPinned: false },
    };
  }
}
