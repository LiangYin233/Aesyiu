import type { AgentContext } from '../context/index.js';
import { AesyiuRuntimeError } from '../error/index.js';
import { encodeToolResultEnvelope, validateToolArguments, warnIfJSONSchemaTool } from '../tool/schema.js';
import type { Message, Tool, ToolCall } from '../types/index.js';
import type { AfterToolCallHook, BeforeToolCallHook, ToolMiddleware, ToolMiddlewareContext } from './types.js';
import {
  chainMiddleware,
  classifyAbortOrTimeout,
  combineAbortSignals,
  getErrorMessage,
  isAbortError,
  rethrowProgrammingError,
  runHooks,
} from './utils.js';

function toolFailureMessage(call: ToolCall, error: string): Message {
  return {
    role: 'tool',
    content: encodeToolResultEnvelope({ success: false, error }),
    tool_call_id: call.id,
  };
}

export async function runToolCalls(
  toolCalls: ToolCall[],
  availableTools: Map<string, Tool>,
  ctx: AgentContext,
  signal: AbortSignal | undefined,
  toolMiddlewares: ToolMiddleware[],
  beforeToolCallHooks: ReadonlyArray<BeforeToolCallHook>,
  afterToolCallHooks: ReadonlyArray<AfterToolCallHook>,
): Promise<Message[]> {
  const toolAbort = new AbortController();
  const combinedSignal = combineAbortSignals(signal, toolAbort.signal);
  const promises = toolCalls.map((call) =>
    runToolCall(call, availableTools, ctx, combinedSignal, toolMiddlewares, beforeToolCallHooks, afterToolCallHooks),
  );

  try {
    return await Promise.all(promises);
  } catch (error) {
    toolAbort.abort();
    await Promise.allSettled(promises);
    rethrowProgrammingError(error);
    throw new AesyiuRuntimeError(classifyAbortOrTimeout(error, signal) ?? 'tool', error);
  }
}

async function runToolCall(
  call: ToolCall,
  availableTools: Map<string, Tool>,
  ctx: AgentContext,
  signal: AbortSignal | undefined,
  toolMiddlewares: ToolMiddleware[],
  beforeToolCallHooks: ReadonlyArray<BeforeToolCallHook>,
  afterToolCallHooks: ReadonlyArray<AfterToolCallHook>,
): Promise<Message> {
  const tool = availableTools.get(call.name);
  if (!tool) {
    return toolFailureMessage(call, `Tool "${call.name}" not found`);
  }

  warnIfJSONSchemaTool(tool);

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

  const middlewareContext: ToolMiddlewareContext = {
    tool,
    toolCall: call,
    args: validation.data,
    agentContext: ctx,
  };

  try {
    const hookedContext = await runHooks(beforeToolCallHooks, middlewareContext);
    const result = await chainMiddleware(
      toolMiddlewares,
      hookedContext,
      () => tool.execute(hookedContext.args as never, ctx, { signal }) as Promise<unknown>,
    );
    const finalContext = await runHooks(afterToolCallHooks, {
      tool,
      toolCall: call,
      args: hookedContext.args,
      result,
      agentContext: ctx,
    });

    return {
      role: 'tool',
      content: encodeToolResultEnvelope({ success: true, result: finalContext.result }),
      tool_call_id: call.id,
    };
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    return toolFailureMessage(call, getErrorMessage(error));
  }
}
