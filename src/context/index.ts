import { randomUUID } from 'node:crypto';
import type { Message, MessageMeta, TokenUsage, ModelDefinition } from '../types/index.js';
import type { LLMProvider } from '../provider/index.js';

export interface AgentContextConfig {
  provider: LLMProvider;
  modelId?: string;
  initialState?: Record<string, unknown>;
}

export type MessageInput = Omit<Message, 'id'> & { id?: string };

function cloneInitialState(initialState?: Record<string, unknown>): Record<string, unknown> {
  return initialState ? structuredClone(initialState) : {};
}

export class AgentContext {
  private _messages: Message[] = [];
  public state: Record<string, unknown>;
  public sessionUsage: TokenUsage;
  public activeProvider!: LLMProvider;
  public activeModel!: ModelDefinition;

  constructor(config: AgentContextConfig) {
    this.state = cloneInitialState(config.initialState);
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
    this.activeProvider = provider;
    this.activeModel = provider.getModel(resolvedModelId);
  }

  public accumulateUsage(usage: TokenUsage): void {
    this.sessionUsage.promptTokens += usage.promptTokens;
    this.sessionUsage.completionTokens += usage.completionTokens;
    this.sessionUsage.totalTokens += usage.totalTokens;
  }

  public addMessage(message: MessageInput): Message {
    const storedMessage = this.ensureMessageId(message);
    const insertIndex = this.findInsertIndex(storedMessage.role);
    this._messages.splice(insertIndex, 0, storedMessage);
    return storedMessage;
  }

  public addMessages(messages: MessageInput[]): Message[] {
    return messages.map(this.addMessage, this);
  }

  public clearMessages(): void {
    this._messages = [];
  }

  public replaceMessages(messages: MessageInput[]): void {
    this._messages = messages.map((message) => this.ensureMessageId(message));
  }

  public setSystemPrompt(name: string, content: string): void {
    const meta: MessageMeta = { promptSection: name };
    const existing = this._messages.find((m) => m._meta?.promptSection === name);
    if (existing?.id) {
      const idx = this._messages.findIndex((m) => m.id === existing.id);
      this._messages[idx] = { ...this._messages[idx], content, _meta: meta };
    } else {
      this.addMessage({ role: 'system', content, _meta: meta });
    }
  }

  public removeSystemPrompt(name: string): void {
    this._messages = this._messages.filter((m) => m._meta?.promptSection !== name);
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
    return 0;
  }
}
