import { randomBytes } from 'crypto';
import type { IUnifiedMessage } from '../core/types.js';

export interface SessionIdComponents {
  channel: string;
  type: string;
  chatId: string;
  session: string;
}

export class SessionId {
  private static readonly SESSION_LENGTH = 8;
  private static readonly CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';
  private static readonly DELIMITER = ':';

  static generateSession(): string {
    const bytes = randomBytes(this.SESSION_LENGTH);
    let result = '';
    for (let i = 0; i < this.SESSION_LENGTH; i++) {
      result += this.CHARSET[bytes[i] % this.CHARSET.length];
    }
    return result;
  }

  static parse(sessionId: string): SessionIdComponents {
    const parts = sessionId.split(this.DELIMITER);

    if (parts.length !== 4) {
      throw new Error(`Invalid sessionId format: ${sessionId}`);
    }

    const [channel, type, chatId, session] = parts;

    if (!channel || !type || !chatId || !session) {
      throw new Error(`Invalid sessionId format: ${sessionId}`);
    }

    return { channel, type, chatId, session };
  }

  static compose(components: SessionIdComponents): string {
    return [
      components.channel,
      components.type,
      components.chatId,
      components.session,
    ].join(this.DELIMITER);
  }

  static fromUnifiedMessage(msg: IUnifiedMessage): string {
    const channel = msg.channelId || 'unknown';
    const type = (msg.metadata?.type as string) || 'default';
    const chatId = msg.chatId || 'unknown';
    const session = this.generateSession();

    return this.compose({ channel, type, chatId, session });
  }

  static isValid(sessionId: string): boolean {
    try {
      const parts = sessionId.split(this.DELIMITER);
      if (parts.length !== 4) {
        return false;
      }
      const [channel, type, chatId, session] = parts;
      return !!(channel && type && chatId && session);
    } catch {
      return false;
    }
  }

  static getSessionFromId(sessionId: string): string {
    const components = this.parse(sessionId);
    return components.session;
  }

  static getBaseSession(sessionId: string): string {
    const components = this.parse(sessionId);
    return this.compose({
      ...components,
      session: 'default',
    });
  }
}