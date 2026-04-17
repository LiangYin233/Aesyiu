import { randomUUID } from 'node:crypto';
import type { Message, MessageMeta, TokenUsage, ModelDefinition } from '../types/index.js';
import type { LLMProvider } from '../provider/index.js';

export interface AgentContextConfig<TState extends Record<string, unknown> = Record<string, unknown>> {
  provider: LLMProvider;
  modelId?: string;
  initialState?: TState;
}

export type MessageInput = Omit<Message, 'id'> & { id?: string };
export type MessagePatch = Partial<Omit<Message, 'id' | 'role'>>;

export interface PromptSection {
  content: string;
  pinned?: boolean;
}

export class AgentContext<TState extends Record<string, unknown> = Record<string, unknown>> {
  private _messages: Message[] = [];
  public state: TState;
  public sessionUsage: TokenUsage;
  public activeProvider!: LLMProvider;
  public activeModel!: ModelDefinition;

  constructor(config: AgentContextConfig<TState>) {
    this.state = (config.initialState ?? {}) as TState;
    this.sessionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.switchLLM(config.provider, config.modelId);
  }

  public get messages(): readonly Message[] {
    return this._messages;
  }

  public switchLLM(provider: LLMProvider, modelId?: string): void {
    const resolvedModelId = modelId ?? provider.supportedModels.keys().next().value;
    if (!resolvedModelId) {
      throw new Error(`Provider "${provider.name}" has no models registered`);
    }
    const resolvedModel = provider.getModel(resolvedModelId);
    this.activeProvider = provider;
    this.activeModel = resolvedModel;
  }

  public accumulateUsage(usage: TokenUsage): void {
    this.sessionUsage.promptTokens += usage.promptTokens;
    this.sessionUsage.completionTokens += usage.completionTokens;
    this.sessionUsage.totalTokens += usage.totalTokens;
  }

  public getMessages(): readonly Message[] {
    return this._messages;
  }

  public getVisibleMessages(): Message[] {
    return this._messages.filter((message) => !message._meta?.internal);
  }

  public addMessage(message: MessageInput): Message {
    const storedMessage = this.ensureMessageId(message);
    const insertIndex = this.findInsertIndex(storedMessage.role);
    this._messages.splice(insertIndex, 0, storedMessage);
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

    const messageIndex = this._messages.findIndex((message) => message.id === id);
    if (messageIndex < 0) {
      throw new Error(`Message "${id}" not found`);
    }

    const updatedMessage: Message = {
      ...this._messages[messageIndex],
      ...patch,
      id,
    };
    this._messages[messageIndex] = updatedMessage;
    return updatedMessage;
  }

  public clearMessages(): void {
    this._messages = [];
  }

  public replaceMessages(messages: MessageInput[]): void {
    this._messages = [];
    this.addMessages(messages);
  }

  public removeMessages(predicate: (message: Message, index: number) => boolean): number {
    const originalLength = this._messages.length;
    this._messages = this._messages.filter((message, index) => !predicate(message, index));
    return originalLength - this._messages.length;
  }

  public registerPromptSection(name: string, section: PromptSection): Message {
    const meta: MessageMeta = {
      isPinned: section.pinned ?? true,
      promptSection: name,
      internal: true,
    };

    const existing = this._messages.find((message) => message._meta?.promptSection === name);
    if (existing?.id) {
      return this.setMessage(existing.id, { content: section.content, _meta: meta });
    }

    return this.addMessage({ role: 'system', content: section.content, _meta: meta });
  }

  public removePromptSection(name: string): number {
    return this.removeMessages((message) => message._meta?.promptSection === name);
  }

  private ensureMessageId(message: MessageInput): Message {
    return {
      ...message,
      id: message.id ?? randomUUID(),
    };
  }

  private findInsertIndex(role: Message['role']): number {
    if (role !== 'system') {
      return this._messages.length;
    }

    return this._messages.findLastIndex((message) => message.role === 'system') + 1;
  }
}
