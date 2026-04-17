import type { AgentContext } from '../context/index.js';
import type { Message, TokenUsage } from '../types/index.js';

export interface MemoryManagerConfig {
  compressThresholdRatio?: number;
  retainLatestMessages?: number;
}

export type MemoryLLMFn = (messages: Message[]) => Promise<{ message: Message; usage: TokenUsage }>;

const DEFAULTS: Required<MemoryManagerConfig> = {
  compressThresholdRatio: 0.8,
  retainLatestMessages: 5,
};

interface MessagePartition {
  pinned: Message[];
  compressible: Message[];
  protectedLatest: Message[];
}

export class MemoryManager {
  private config: Required<MemoryManagerConfig>;

  constructor(config?: MemoryManagerConfig) {
    this.config = { ...DEFAULTS, ...config };
  }

  public static default(): MemoryManager {
    return new MemoryManager();
  }

  public async checkAndOptimize(
    ctx: AgentContext,
    currentApiUsage: TokenUsage,
    llm?: MemoryLLMFn,
  ): Promise<void> {
    ctx.accumulateUsage(currentApiUsage);

    const threshold = ctx.activeModel.contextWindow * this.config.compressThresholdRatio;
    if (currentApiUsage.promptTokens <= threshold) {
      return;
    }

    const { pinned, compressible, protectedLatest } = this.partitionMessages(ctx.messages);

    if (compressible.length === 0) {
      return;
    }

    try {
      const summary = await this.compressMessages(ctx, compressible, llm);
      ctx.replaceMessages([...pinned, summary, ...protectedLatest]);
    } catch (error) {
      console.warn('[aesyiu] memory compression failed; dropping compressible history', error);
      ctx.replaceMessages([...pinned, ...protectedLatest]);
    }
  }

  private partitionMessages(messages: readonly Message[]): MessagePartition {
    const grouped = Object.groupBy(messages, (message) =>
      message._meta?.isPinned ? 'pinned' : 'rest',
    ) as { pinned?: Message[]; rest?: Message[] };
    const pinned = [...(grouped.pinned ?? [])];
    const rest = [...(grouped.rest ?? [])];

    const retainCount = this.config.retainLatestMessages;
    const protectedLatest = rest.length > retainCount
      ? rest.splice(-retainCount)
      : rest.splice(0);

    return { pinned, compressible: rest, protectedLatest };
  }

  private async compressMessages(
    ctx: AgentContext,
    messages: Message[],
    llm: MemoryLLMFn | undefined,
  ): Promise<Message> {
    const conversationSummary = messages
      .map((m) => `${m.role}: ${m.content ?? (m.tool_calls ? JSON.stringify(m.tool_calls) : '')}`)
      .join('\n');

    const summaryPrompt: Message = {
      role: 'system',
      content: `Please summarize the following conversation history, preserving key information and context:\n\n${conversationSummary}`,
    };

    const fn = llm ?? (async (msgs) => ctx.activeProvider.generate(ctx.activeModel, msgs));
    const { message } = await fn([summaryPrompt]);

    return {
      role: 'system',
      content: `[Summary of earlier conversation] ${message.content}`,
      _meta: { isPinned: false },
    };
  }
}
