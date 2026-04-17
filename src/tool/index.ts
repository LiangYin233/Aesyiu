import { z } from 'zod';
import type { AgentContext } from '../context/index.js';
import type { Tool, ToolCall, Message, ToolParameters, ToolResultEnvelope } from '../types/index.js';

function isZodSchema(obj: unknown): obj is z.ZodType<unknown> {
  return obj !== null &&
    typeof obj === 'object' &&
    'safeParse' in obj &&
    typeof (obj as { safeParse: unknown }).safeParse === 'function';
}

function encodeEnvelope<T>(envelope: ToolResultEnvelope<T>): string {
  return JSON.stringify(envelope);
}

const warnedTools = new WeakSet<object>();

export interface DefineToolConfig<TArgs, TResult> {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute: (args: TArgs, ctx: AgentContext) => Promise<TResult>;
}

export function defineTool<TArgs = unknown, TResult = unknown>(
  config: DefineToolConfig<TArgs, TResult>,
): Tool<TArgs, TResult, AgentContext> {
  return config;
}

export class ToolExecutor {
  public static async executeCalls(
    calls: ToolCall[],
    tools: Map<string, Tool>,
    ctx: AgentContext,
  ): Promise<Message[]> {
    return Promise.all(
      calls.map((call) => ToolExecutor.executeSingle(call, tools, ctx)),
    );
  }

  public static async executeSingle(
    call: ToolCall,
    tools: Map<string, Tool>,
    ctx: AgentContext,
  ): Promise<Message> {
    const tool = tools.get(call.name);

    if (!tool) {
      return {
        role: 'tool',
        content: encodeEnvelope({ success: false, error: `Tool "${call.name}" not found` }),
        tool_call_id: call.id,
      };
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(call.arguments);
    } catch (err) {
      return {
        role: 'tool',
        content: encodeEnvelope({ success: false, error: (err as Error).message }),
        tool_call_id: call.id,
      };
    }

    if (tool.parameters && isZodSchema(tool.parameters)) {
      const validationResult = tool.parameters.safeParse(parsedArgs);
      if (!validationResult.success) {
        return {
          role: 'tool',
          content: encodeEnvelope({ success: false, error: validationResult.error.message }),
          tool_call_id: call.id,
        };
      }
      parsedArgs = validationResult.data;
    } else if (tool.parameters && typeof tool.parameters === 'object' && !warnedTools.has(tool)) {
      warnedTools.add(tool);
      console.warn(
        `[aesyiu] tool "${tool.name}" uses a JSON schema; arguments pass through unvalidated. ` +
        'Provide a Zod schema to enable runtime validation.',
      );
    }

    try {
      const result = await tool.execute(parsedArgs as never, ctx);
      return {
        role: 'tool',
        content: encodeEnvelope({ success: true, result }),
        tool_call_id: call.id,
      };
    } catch (err) {
      return {
        role: 'tool',
        content: encodeEnvelope({ success: false, error: (err as Error).message }),
        tool_call_id: call.id,
      };
    }
  }
}
