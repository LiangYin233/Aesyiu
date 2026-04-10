import type { AgentEngine } from '../core/agent.js';
import type { SessionMemoryManager } from '../memory/session-memory-manager.js';
import type { SessionConfig } from './types.js';

export interface SessionMetadata {
  sessionId: string;
  channel: string;
  type: string;
  chatId: string;
  session: string;
  createdAt: Date;
  lastActiveAt: Date;
  messageCount: number;
}

export interface SessionContext {
  metadata: SessionMetadata;
  agent: AgentEngine;
  memory: SessionMemoryManager;
  config: SessionConfig;
}

export function createSessionMetadata(
  sessionId: string,
  channel: string,
  type: string,
  chatId: string,
  session: string
): SessionMetadata {
  return {
    sessionId,
    channel,
    type,
    chatId,
    session,
    createdAt: new Date(),
    lastActiveAt: new Date(),
    messageCount: 0,
  };
}
