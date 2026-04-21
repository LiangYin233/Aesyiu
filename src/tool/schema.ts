import { z } from 'zod';
import type { JSONSchema, Tool, ToolParameters, ToolResultEnvelope } from '../types/index.js';

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

export function encodeToolResultEnvelope<T>(envelope: ToolResultEnvelope<T>): string {
  return JSON.stringify(envelope);
}

const warnedTools = new WeakSet<object>();

export function warnIfJSONSchemaTool(tool: Tool): void {
  if (!tool.parameters || isZodSchema(tool.parameters)) {return;}
  if (warnedTools.has(tool)) {return;}
  warnedTools.add(tool);
  console.warn(
    `[aesyiu] tool "${tool.name}" uses a JSON schema; arguments pass through unvalidated. ` +
    'Provide a Zod schema to enable runtime validation.',
  );
}
