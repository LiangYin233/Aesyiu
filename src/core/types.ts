export interface IUnifiedMessage {
  channelId: string;
  chatId: string;
  text: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface IOutboundMessage {
  text: string;
  mediaFiles?: Array<{
    type: string;
    url: string;
  }>;
  error?: string;
}

export interface IOutboundPayload {
  text: string;
  mediaFiles?: Array<{ type: string; url: string }>;
}

export interface PipelineState {
  config?: {
    config: unknown;
  };
  session?: {
    sessionContext: unknown;
    sessionId: string;
  };
  agent?: {
    llmConfig: unknown;
    systemPrompt: string;
    [key: string]: unknown;
  };
}

export interface IChannelContext {
  traceId: string;
  inbound: IUnifiedMessage;
  outbound: IOutboundMessage;
  createdAt: number;
  state?: PipelineState;
  blocked?: boolean;
  sendFn?: (_payload: IOutboundPayload) => Promise<void>;
}

export type MiddlewareFunc = (
  _ctx: IChannelContext,
  _next: () => Promise<void>
) => Promise<void>;
