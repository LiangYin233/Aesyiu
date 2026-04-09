/**
 * 工具转换器模块
 * 用于统一处理不同 LLM 提供商的工具格式转换
 */

import type { ToolDefinition, ToolParameters } from '../../tools/types.js';
import {
  OpenAIToolDefinition,
  AnthropicToolDefinition,
  ToolFormatter,
} from '../types.js';

export { OpenAIToolDefinition, AnthropicToolDefinition, ToolFormatter };

/**
 * OpenAI 工具格式化器
 * 生成符合 OpenAI function calling 规范的工具定义
 *
 * OpenAI 格式特点：
 * - 使用 `type: 'function'` 包装
 * - 参数放在 `function.parameters` 中
 */
export class OpenAIToolFormatter implements ToolFormatter<OpenAIToolDefinition> {
  /**
   * 将通用工具定义转换为 OpenAI 格式
   * @param tool 通用工具定义
   * @returns OpenAI 格式的工具定义
   */
  format(tool: ToolDefinition): OpenAIToolDefinition {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.transformParameters(tool.parameters),
      },
    };
  }

  /**
   * 批量转换工具定义为 OpenAI 格式
   * @param tools 通用工具定义数组
   * @returns OpenAI 格式的工具定义数组
   */
  formatAll(tools: ToolDefinition[]): OpenAIToolDefinition[] {
    return tools.map(tool => this.format(tool));
  }

  /**
   * 转换参数 schema
   * OpenAI 接受标准的 JSON Schema 格式，直接传递即可
   * @param parameters 工具参数定义
   * @returns 转换后的参数定义
   */
  private transformParameters(parameters: ToolParameters): ToolParameters {
    return {
      type: parameters.type || 'object',
      properties: parameters.properties || {},
      required: parameters.required,
      additionalProperties: parameters.additionalProperties,
    };
  }
}

/**
 * Anthropic 工具格式化器
 * 生成符合 Anthropic tool use 规范的工具定义
 *
 * Anthropic 格式特点：
 * - 使用 `input_schema` 字段
 * - 参数直接放在 `input_schema` 中
 */
export class AnthropicToolFormatter implements ToolFormatter<AnthropicToolDefinition> {
  /**
   * 将通用工具定义转换为 Anthropic 格式
   * @param tool 通用工具定义
   * @returns Anthropic 格式的工具定义
   */
  format(tool: ToolDefinition): AnthropicToolDefinition {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: this.transformParameters(tool.parameters),
    };
  }

  /**
   * 批量转换工具定义为 Anthropic 格式
   * @param tools 通用工具定义数组
   * @returns Anthropic 格式的工具定义数组
   */
  formatAll(tools: ToolDefinition[]): AnthropicToolDefinition[] {
    return tools.map(tool => this.format(tool));
  }

  /**
   * 转换参数 schema
   * Anthropic 使用 input_schema 字段，格式与标准 JSON Schema 类似
   * @param parameters 工具参数定义
   * @returns 转换后的参数定义
   */
  private transformParameters(parameters: ToolParameters): ToolParameters {
    return {
      type: parameters.type || 'object',
      properties: parameters.properties || {},
      required: parameters.required,
      additionalProperties: parameters.additionalProperties,
    };
  }
}

/**
 * 工具转换器
 * 统一管理不同提供商的工具格式转换
 *
 * 使用示例：
 * ```typescript
 * const transformer = new ToolTransformer();
 * const openaiTools = transformer.toOpenAI(tools);
 * const anthropicTools = transformer.toAnthropic(tools);
 * ```
 */
export class ToolTransformer {
  private openaiFormatter: OpenAIToolFormatter;
  private anthropicFormatter: AnthropicToolFormatter;

  constructor() {
    this.openaiFormatter = new OpenAIToolFormatter();
    this.anthropicFormatter = new AnthropicToolFormatter();
  }

  /**
   * 将工具定义转换为 OpenAI 格式
   * @param tools 通用工具定义数组
   * @returns OpenAI 格式的工具定义数组
   */
  toOpenAI(tools: ToolDefinition[]): OpenAIToolDefinition[] {
    return this.openaiFormatter.formatAll(tools);
  }

  /**
   * 将工具定义转换为 Anthropic 格式
   * @param tools 通用工具定义数组
   * @returns Anthropic 格式的工具定义数组
   */
  toAnthropic(tools: ToolDefinition[]): AnthropicToolDefinition[] {
    return this.anthropicFormatter.formatAll(tools);
  }
}
