import { StandardMessage, MessageRole, ToolCall } from '../llm/types.js';

export class MessageFactory {
  static createSystemMessage(content: string): StandardMessage {
    return {
      role: MessageRole.System,
      content,
    };
  }

  static createUserMessage(content: string): StandardMessage {
    return {
      role: MessageRole.User,
      content,
    };
  }

  static createAssistantMessage(
    content: string,
    toolCalls?: ToolCall[]
  ): StandardMessage {
    return {
      role: MessageRole.Assistant,
      content,
      toolCalls,
    };
  }

  static createToolMessage(
    toolCallId: string,
    name: string,
    content: string
  ): StandardMessage {
    return {
      role: MessageRole.Tool,
      content,
      toolCallId,
      name,
    };
  }
}
