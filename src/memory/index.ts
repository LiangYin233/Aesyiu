import type { AgentContext } from '../context/index.js';
import type { Message, TokenUsage } from '../types/index.js';

export interface MemoryManagerConfig {
  compressThresholdRatio: number;
  retainLatestMessages: number;
}

interface MessagePartition {
  pinned: Message[];
  compressible: Message[];
  protectedLatest: Message[];
}

export class MemoryManager {
  private config: MemoryManagerConfig;

  constructor(config: MemoryManagerConfig) {
    this.config = config;
  }

  public async checkAndOptimize(ctx: AgentContext, currentApiUsage: TokenUsage): Promise<void> {
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
      const summary = await this.compressMessages(ctx, compressible);
      ctx.messages = [...pinned, summary, ...protectedLatest];
    } catch {
      ctx.messages = [...pinned, ...protectedLatest];
    }
  }

  private partitionMessages(messages: Message[]): MessagePartition {
    const pinned: Message[] = [];
    const nonPinned: Message[] = [];

    for (const msg of messages) {
      if (msg._meta?.isPinned) {
        pinned.push(msg);
      } else {
        nonPinned.push(msg);
      }
    }

    const retainCount = this.config.retainLatestMessages;
    const protectedLatest = nonPinned.length > retainCount
      ? nonPinned.splice(-retainCount)
      : nonPinned.splice(0);

    const compressible = nonPinned;

    return { pinned, compressible, protectedLatest };
  }

  private async compressMessages(ctx: AgentContext, messages: Message[]): Promise<Message> {
    const conversationSummary = messages
      .map((m) => `${m.role}: ${m.content ?? (m.tool_calls ? JSON.stringify(m.tool_calls) : '')}`)
      .join('\n');

    const summaryPrompt: Message = {
      role: 'system',
      content: `Please summarize the following conversation history, preserving key information and context:\n\n${conversationSummary}`,
    };

    const { message } = await ctx.activeProvider.generate(ctx.activeModel, [summaryPrompt]);

    return {
      role: 'system',
      content: `[Summary of earlier conversation] ${message.content}`,
      _meta: { isPinned: false },
    };
  }
}