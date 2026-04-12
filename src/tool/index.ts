import { ZodSchema } from 'zod';
import type { AgentContext } from '../context/index.js';
import type { Tool, ToolCall, Message } from '../types/index.js';

export class ToolExecutor {
  public static async executeCalls(
    calls: ToolCall[],
    tools: Map<string, Tool>,
    ctx: AgentContext,
  ): Promise<Message[]> {
    const results = await Promise.all(
      calls.map((call) => ToolExecutor.executeSingle(call, tools, ctx)),
    );
    return results;
  }

  private static async executeSingle(
    call: ToolCall,
    tools: Map<string, Tool>,
    ctx: AgentContext,
  ): Promise<Message> {
    const tool = tools.get(call.name);

    if (!tool) {
      return {
        role: 'tool',
        content: JSON.stringify({ success: false, error: `Tool "${call.name}" not found` }),
        tool_call_id: call.id,
      };
    }

    let parsedArgs: any;
    try {
      parsedArgs = JSON.parse(call.arguments);
    } catch (err) {
      return {
        role: 'tool',
        content: JSON.stringify({ success: false, error: (err as Error).message }),
        tool_call_id: call.id,
      };
    }

    if (tool.parameters && tool.parameters instanceof ZodSchema) {
      const validationResult = tool.parameters.safeParse(parsedArgs);
      if (!validationResult.success) {
        return {
          role: 'tool',
          content: JSON.stringify({ success: false, error: validationResult.error.message }),
          tool_call_id: call.id,
        };
      }
      parsedArgs = validationResult.data;
    }

    try {
      const result = await tool.execute(parsedArgs, ctx);
      return {
        role: 'tool',
        content: JSON.stringify({ success: true, result }),
        tool_call_id: call.id,
      };
    } catch (err) {
      return {
        role: 'tool',
        content: JSON.stringify({ success: false, error: (err as Error).message }),
        tool_call_id: call.id,
      };
    }
  }
}