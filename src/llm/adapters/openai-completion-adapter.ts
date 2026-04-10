import OpenAI from 'openai';
import {
  ILLMProvider,
  LLMProviderType,
  LLMMode,
  StandardResponse,
  StandardStreamChunk,
  StreamCallbacks,
  ToolCall,
  LLMProviderConfig,
  MessageRole,
} from '../types.js';
import { ToolDefinition } from '../../tools/types.js';
import { createNoOpLogger } from '../../observability/logger.js';
import type { ILogger } from '../../contracts/logger.js';
import { randomUUID } from 'crypto';
import { PromptContext } from '../prompt-context.js';
import { TokenUsageMapper } from '../utils/token-usage-mapper.js';

const TOOL_CALL_PATTERN = /<tool_call\s*name:\s*(\w+)\s*arguments:\s*(\{[^}]+\})\s*<\/tool_call>/gi;

export class OpenAICompletionAdapter implements ILLMProvider {
  readonly providerType = LLMProviderType.OpenAICompletion;
  readonly supportedModes: LLMMode[] = [LLMMode.Completion];

  private client: OpenAI;
  private model: string;
  private logger: ILogger;

  constructor(config: LLMProviderConfig) {
    const apiKey = config.apiKey;
    if (!apiKey) {
      throw new Error('OpenAI API key is required. Please configure it in config.json.');
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeout || 60000,
    });

    this.model = config.model || 'gpt-3.5-turbo-instruct';
    this.logger = config.logger ?? createNoOpLogger();

    this.logger.info(
      { provider: this.providerType, model: this.model },
      'OpenAI Completion Adapter 已初始化'
    );
  }

  validateConfig(): boolean {
    return !!this.client.apiKey;
  }

  async generate(context: PromptContext): Promise<StandardResponse> {
    const prompt = this.buildPromptFromContext(context);

    this.logger.debug(
      {
        promptLength: prompt.length,
        hasTools: context.tools.length > 0,
        toolCount: context.tools.length,
        contextMetadata: context.metadata,
      },
      '从 PromptContext 发送请求到 OpenAI Completion API'
    );

    try {
      const response = await this.client.completions.create({
        model: this.model,
        prompt,
        stop: ['</tool_call >', '\n\n\n'],
        ...(context.providerExtra ?? {}),
        ...(context.modelExtraBody ?? {}),
      });

      const text = response.choices[0]?.text || '';
      const tokenUsage = TokenUsageMapper.fromCompletion(response.usage);

      const toolCalls = this.extractToolCalls(text, context.tools);

      const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';

      this.logger.info(
        {
          finishReason,
          textLength: text.length,
          toolCallCount: toolCalls.length,
          tokenUsage,
        },
        '从 PromptContext 收到 OpenAI Completion 响应'
      );

      return {
        text: text.replace(TOOL_CALL_PATTERN, '').trim(),
        toolCalls,
        tokenUsage,
        finishReason,
        rawResponse: response,
      };
    } catch (error) {
      this.logger.error({ error }, '从 PromptContext 调用 OpenAI Completion API 失败');
      throw error;
    }
  }

  async generateStream(
    context: PromptContext,
    callbacks: StreamCallbacks
  ): Promise<AsyncIterable<StandardStreamChunk>> {
    const prompt = this.buildPromptFromContext(context);

    this.logger.debug(
      {
        promptLength: prompt.length,
        hasTools: context.tools.length > 0,
        toolCount: context.tools.length,
        contextMetadata: context.metadata,
      },
      '📤 从 PromptContext 发送流式请求到 OpenAI Completion API'
    );

    async function* generateChunks(): AsyncGenerator<StandardStreamChunk> {
      const stream = await client.completions.create({
        model: model,
        prompt,
        stop: ['</tool_call >', '\n\n\n'],
        stream: true,
        ...(context.providerExtra ?? {}),
        ...(context.modelExtraBody ?? {}),
      });

      let accumulatedText = '';

      for await (const chunk of stream) {
        const text = chunk.choices[0]?.text || '';
        if (text) {
          accumulatedText += text;
          if (callbacks.onToken) {
            callbacks.onToken(text);
          }
          yield { type: 'text', text };
        }
      }

      const finalToolCalls = extractToolCallsSync(accumulatedText, context.tools);
      const tokenUsage = TokenUsageMapper.fromCompletion(
        (stream as unknown as { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }).usage
      );

      if (callbacks.onComplete) {
        callbacks.onComplete({
          text: accumulatedText.replace(TOOL_CALL_PATTERN, '').trim(),
          toolCalls: finalToolCalls,
          tokenUsage,
          finishReason: finalToolCalls.length > 0 ? 'tool_calls' : 'stop',
        });
      }

      yield {
        type: 'done',
        tokenUsage,
        finishReason: finalToolCalls.length > 0 ? 'tool_calls' : 'stop',
      };
    }

    const client = this.client;
    const model = this.model;
    const extractToolCallsSync = this.extractToolCalls.bind(this);

    return {
      [Symbol.asyncIterator]: generateChunks,
    };
  }

  private buildPromptFromContext(context: PromptContext): string {
    const parts: string[] = [];

    parts.push('=== SYSTEM INSTRUCTIONS ===\n');
    parts.push(context.system.systemPrompt);
    parts.push('\n');

    if (context.tools && context.tools.length > 0) {
      parts.push('=== AVAILABLE TOOLS ===\n');
      parts.push('You can call one or more functions to assist with the user query.\n\n');

      for (const tool of context.tools) {
        const paramsStr = JSON.stringify(tool.parameters, null, 2);
        parts.push(`## ${tool.name}\n`);
        parts.push(`Description: ${tool.description}\n`);
        parts.push(`Parameters:\n${paramsStr}\n\n`);
      }

      parts.push('=== TOOL CALLING FORMAT ===\n');
      parts.push('When you want to call a tool, respond with:\n');
      parts.push('<tool_call >\n');
      parts.push('name: <function_name>\n');
      parts.push('arguments: <json_arguments>\n');
      parts.push('</tool_call >\n\n');
      parts.push('For multiple calls, use separate <tool_call > blocks.\n\n');
    }

    parts.push('=== CONVERSATION ===\n');
    for (const msg of context.messages) {
      if (msg.role === MessageRole.User) {
        parts.push(`User: ${msg.content}\n`);
      } else if (msg.role === MessageRole.Assistant) {
        parts.push(`Assistant: ${msg.content}\n`);
      } else if (msg.role === MessageRole.Tool) {
        parts.push(`[TOOL RESULT: ${msg.content}]\n`);
      }
    }

    parts.push('\nAssistant: ');
    return parts.join('');
  }

  private extractToolCalls(text: string, tools: ToolDefinition[]): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    const toolNames = new Set(tools.map(t => t.name));

    let match;
    const pattern = new RegExp(TOOL_CALL_PATTERN.source, 'gi');
    
    while ((match = pattern.exec(text)) !== null) {
      const toolName = match[1];
      const argsStr = match[2];

      if (toolNames.has(toolName)) {
        try {
          const args = JSON.parse(argsStr);
          toolCalls.push({
            id: randomUUID(),
            name: toolName,
            arguments: args,
          });
        } catch {
          this.logger.warn({ toolName, argsStr }, '无法解析工具参数');
        }
      } else {
        this.logger.warn({ toolName }, 'LLM 调用了未注册的工具');
      }
    }

    return toolCalls;
  }
}
