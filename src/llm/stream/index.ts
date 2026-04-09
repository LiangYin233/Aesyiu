/**
 * 流式处理模块
 * 用于处理 LLM 的流式响应
 */

export {
  StreamHandler,
  createOpenAIStreamHandler,
  createAnthropicStreamHandler,
  handleStream,
  handleOpenAIStream,
  handleAnthropicStream,
  type StreamChunk,
  type OpenAIStreamChunk,
  type AnthropicStreamChunk,
  type StreamHandlerOptions,
  type StreamOutput,
} from './stream-handler.js';
