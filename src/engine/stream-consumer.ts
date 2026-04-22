import type { Message, RunStreamEvent, StreamEvent, TokenUsage, ToolCall } from '../types/index.js';

type LLMOperationResult = { message: Message; usage: TokenUsage };

/**
 * Core generator that consumes a provider stream and yields text_delta events.
 * Both middleware and non-middleware paths share this logic.
 */
export async function* consumeLLMStreamGen(
  stream: AsyncIterable<StreamEvent>,
  streamOutput: boolean,
  onResponseStarted?: () => void,
): AsyncGenerator<RunStreamEvent, LLMOperationResult, void> {
  let content = '';
  let toolCalls: ToolCall[] | undefined;
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for await (const event of stream) {
    switch (event.type) {
      case 'response_started':
        onResponseStarted?.();
        break;
      case 'text':
        content += event.delta;
        if (streamOutput) {
          yield { type: 'text_delta', delta: event.delta, content: event.content };
        }
        break;
      case 'tool_calls':
        toolCalls = event.toolCalls;
        break;
      case 'usage':
        usage = event.usage;
        break;
    }
  }

  return {
    message: {
      role: 'assistant',
      content: content || null,
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    usage,
  };
}

/**
 * Adapter that drives consumeLLMStreamGen and forwards each yielded event
 * to an onEvent callback, returning the final result as a Promise.
 * Used by the middleware path where events must be bridged through a queue.
 */
export async function consumeLLMStream(
  stream: AsyncIterable<StreamEvent>,
  streamOutput: boolean,
  onEvent: (event: RunStreamEvent) => void,
  onResponseStarted?: () => void,
): Promise<LLMOperationResult> {
  const gen = consumeLLMStreamGen(stream, streamOutput, onResponseStarted);
  while (true) {
    const next = await gen.next();
    if (next.done) {
      return next.value;
    }
    onEvent(next.value);
  }
}
