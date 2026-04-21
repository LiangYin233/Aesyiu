import type { AgentContext } from '../context/index.js';
import type { Tool, ToolExecutionOptions, ToolParameters } from '../types/index.js';

export interface DefineToolConfig<TArgs, TResult> {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute: (args: TArgs, ctx: AgentContext, options?: ToolExecutionOptions) => Promise<TResult>;
}

export function defineTool<TArgs = unknown, TResult = unknown>(
  config: DefineToolConfig<TArgs, TResult>,
): Tool<TArgs, TResult, AgentContext> {
  return config;
}
