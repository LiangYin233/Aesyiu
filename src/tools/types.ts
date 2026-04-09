export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParameterProperty;
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolParameters {
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
}

export interface ToolExecuteContext {
  chatId: string;
  senderId: string;
  traceId: string;
  [key: string]: unknown;
}

export interface ToolExecutionResult {
  success: boolean;
  content: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ITool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameters;

  getDefinition(): ToolDefinition;
  execute(_args: unknown, _context: ToolExecuteContext): Promise<ToolExecutionResult>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallResult {
  toolCallId: string;
  toolName: string;
  success: boolean;
  content: string;
  error?: string;
  executionTime?: number;
}

export function validateParameters(
  args: unknown,
  schema: ToolParameters
): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];

  if (typeof args !== 'object' || args === null) {
    return { valid: false, errors: ['参数必须是对象'] };
  }

  const obj = args as Record<string, unknown>;

  for (const required of schema.required || []) {
    if (!(required in obj)) {
      errors.push(`缺少必填字段: ${required}`);
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    const prop = schema.properties[key];
    if (prop) {
      const typeValid = validateType(value, prop.type);
      if (!typeValid) {
        errors.push(`字段 "${key}" 类型错误，期望 ${prop.type}，实际 ${typeof value}`);
      }

      if (prop.enum && !prop.enum.includes(String(value))) {
        errors.push(`字段 "${key}" 的值必须在 [${prop.enum.join(', ')}] 中`);
      }

      if (prop.type === 'array' && Array.isArray(value) && prop.items) {
        for (let i = 0; i < value.length; i++) {
          if (!validateType(value[i], prop.items.type)) {
            errors.push(`数组 "${key}" 的第 ${i + 1} 个元素类型错误`);
          }
        }
      }

      if (prop.type === 'object' && typeof value === 'object' && value !== null && prop.properties) {
        const nestedResult = validateParameters(value, {
          type: 'object',
          properties: prop.properties,
          required: prop.required,
        });
        if (!nestedResult.valid) {
          for (const err of nestedResult.errors || []) {
            errors.push(`${key}.${err}`);
          }
        }
      }
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!(key in schema.properties)) {
        errors.push(`不允许的字段: ${key}`);
      }
    }
  }

  return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
}

function validateType(value: unknown, expectedType: string): boolean {
  if (value === null) {
    return expectedType === 'null';
  }
  if (value === undefined) {
    return true;
  }

  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}
