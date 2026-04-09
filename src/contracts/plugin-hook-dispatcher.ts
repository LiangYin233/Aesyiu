export interface HookPayloadMessageReceive {
  message: {
    channelId: string;
    chatId: string;
    text: string;
    timestamp?: number;
    metadata?: Record<string, unknown>;
  };
}

export interface HookPayloadBeforeLLMRequest {
  messages: ReadonlyArray<import('../llm/types.js').StandardMessage>;
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

export interface HookPayloadToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface HookPayloadAfterToolCall {
  toolCall: HookPayloadToolCall;
  result: {
    success: boolean;
    content: string;
    error?: string;
  };
}

export interface HookPayloadMessageSend {
  message: {
    chatId: string;
    text: string;
    mediaFiles?: Array<{
      type: string;
      url: string;
    }>;
    error?: string;
  };
}

export interface IPluginHookDispatcher {
  dispatchMessageReceive(payload: HookPayloadMessageReceive): Promise<HookPayloadMessageReceive['message'] | null>;
  dispatchBeforeLLMRequest(payload: HookPayloadBeforeLLMRequest): Promise<void>;
  dispatchBeforeToolCall(toolCall: HookPayloadToolCall): Promise<{ success: boolean; content: string; error?: string } | null>;
  dispatchAfterToolCall(payload: HookPayloadAfterToolCall): Promise<HookPayloadAfterToolCall['result']>;
  dispatchMessageSend(payload: HookPayloadMessageSend): Promise<HookPayloadMessageSend['message'] | null>;
}
