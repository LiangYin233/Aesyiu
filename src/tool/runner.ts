import type { AgentContext } from '../context/index.js';
import { validateToolArguments } from './schema.js';
import type { Message, Tool, ToolCall } from '../types/index.js';
import type { ToolMiddleware } from '../engine/types.js';
import {
  chainMiddleware,
  combineAbortSignals,
  getErrorMessage,
  isAbortError,
  rethrowProgrammingError,
} from '../engine/utils.js';

function toolFailureMessage(call: ToolCall, error: string): Message {
  return {
    role: 'tool',
    content: JSON.stringify({ success: false, error }),
    tool_call_id: call.id,
  };
}

export async function runToolCalls(
  toolCalls: ToolCall[],
  availableTools: Map<string, Tool>,
  ctx: AgentContext,
  signal: AbortSignal | undefined,
  toolMiddlewares: ToolMiddleware[],
): Promise<Message[]> {
  const toolAbort = new AbortController();
  const combinedSignal = combineAbortSignals(signal, toolAbort.signal);
  const promises = toolCalls.map((call) =>
    runToolCall(call, availableTools, ctx, combinedSignal, toolMiddlewares),
  );

  try {
    return await Promise.all(promises);
  } catch (error) {
    const isExternalAbort = isAbortError(error, signal);
    toolAbort.abort();
    await Promise.allSettled(promises);
    rethrowProgrammingError(error);
    if (isExternalAbort) {
      throw error;
    }
    throw new Error(getErrorMessage(error));
  }
}

async function runToolCall(
  call: ToolCall,
  availableTools: Map<string, Tool>,
  ctx: AgentContext,
  signal: AbortSignal,
  toolMiddlewares: ToolMiddleware[],
): Promise<Message> {
  const tool = availableTools.get(call.name);
  if (!tool) {
    return toolFailureMessage(call, `Tool "${call.name}" not found`);
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(call.arguments);
  } catch (error) {
    return toolFailureMessage(call, getErrorMessage(error));
  }

  const validation = validateToolArguments(tool.parameters, parsedArgs);
  if (!validation.success) {
    return toolFailureMessage(call, validation.error);
  }

  const middlewareContext = {
    tool,
    toolCall: call,
    args: validation.data,
    agentContext: ctx,
  };

  try {
    const result = await chainMiddleware(
      toolMiddlewares,
      middlewareContext,
      () => tool.execute(middlewareContext.args, ctx, { signal }),
    );

    return {
      role: 'tool',
      content: JSON.stringify({ success: true, result }),
      tool_call_id: call.id,
    };
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    return toolFailureMessage(call, getErrorMessage(error));
  }
}
