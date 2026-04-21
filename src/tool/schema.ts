import { z } from 'zod';
import type { JSONSchema, ToolParameters } from '../types/index.js';

export function isZodSchema(obj: unknown): obj is z.ZodType<unknown> {
  return obj !== null
    && typeof obj === 'object'
    && 'safeParse' in obj
    && typeof (obj as { safeParse: unknown }).safeParse === 'function';
}

export function toProviderToolParameters(parameters: ToolParameters): JSONSchema {
  return isZodSchema(parameters)
    ? (z.toJSONSchema(parameters) as JSONSchema)
    : parameters;
}

export function validateToolArguments(
  parameters: ToolParameters | undefined,
  args: unknown,
): { success: true; data: unknown } | { success: false; error: string } {
  if (!parameters || !isZodSchema(parameters)) {
    return { success: true, data: args };
  }

  const validation = parameters.safeParse(args);
  if (!validation.success) {
    return { success: false, error: validation.error.message };
  }

  return { success: true, data: validation.data };
}
