import { randomUUID } from 'node:crypto';
import type { Message, TokenUsage, ModelDefinition } from '../types/index.js';
import type { LLMProvider } from '../provider/index.js';

export interface AgentContextConfig {
  provider: LLMProvider;
  modelId?: string;
}

export type MessageInput = Omit<Message, 'id'> & { id?: string };
export type MessagePatch = Partial<Omit<Message, 'id' | 'role'>>;

export class AgentContext {
  public messages: Message[];
  public state: Record<string, any>;
  public sessionUsage: TokenUsage;
  public activeProvider!: LLMProvider;
  public activeModel!: ModelDefinition;

  constructor(config: AgentContextConfig) {
    this.messages = [];
    this.state = {};
    this.sessionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.switchLLM(config.provider, config.modelId);
  }

  public switchLLM(provider: LLMProvider, modelId?: string): void {
    const resolvedModelId = modelId ?? Array.from(provider.supportedModels.keys())[0];
    const resolvedModel = provider.getModel(resolvedModelId);
    this.activeProvider = provider;
    this.activeModel = resolvedModel;
  }

  public accumulateUsage(usage: TokenUsage): void {
    this.sessionUsage.promptTokens += usage.promptTokens;
    this.sessionUsage.completionTokens += usage.completionTokens;
    this.sessionUsage.totalTokens += usage.totalTokens;
  }

  public getMessages(): Message[] {
    return [...this.messages];
  }

  public addMessage(message: MessageInput): Message {
    const storedMessage = this.ensureMessageId(message);
    const insertIndex = this.findInsertIndex(storedMessage.role);
    this.messages.splice(insertIndex, 0, storedMessage);
    return storedMessage;
  }

  public addMessages(messages: MessageInput[]): Message[] {
    return messages.map((message) => this.addMessage(message));
  }

  public setMessage(id: string, patch: MessagePatch): Message {
    if ('id' in patch) {
      throw new Error('setMessage does not allow changing message id');
    }

    if ('role' in patch) {
      throw new Error('setMessage does not allow changing message role');
    }

    const messageIndex = this.messages.findIndex((message) => message.id === id);
    if (messageIndex < 0) {
      throw new Error(`Message "${id}" not found`);
    }

    const updatedMessage: Message = {
      ...this.messages[messageIndex],
      ...patch,
      id,
    };
    this.messages[messageIndex] = updatedMessage;
    return updatedMessage;
  }

  public clearMessages(): void {
    this.messages = [];
  }

  public removeMessages(predicate: (message: Message, index: number) => boolean): number {
    const originalLength = this.messages.length;
    this.messages = this.messages.filter((message, index) => !predicate(message, index));
    return originalLength - this.messages.length;
  }

  private ensureMessageId(message: MessageInput): Message {
    return {
      ...message,
      id: message.id ?? randomUUID(),
    };
  }

  private findInsertIndex(role: Message['role']): number {
    if (role !== 'system') {
      return this.messages.length;
    }

    return this.messages.findIndex((message) => message.role !== 'system') === -1
      ? this.messages.length
      : this.messages.findIndex((message) => message.role !== 'system');
  }
}
