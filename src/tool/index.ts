import type { AgentContext } from '../context/index.js';
import type { Tool, ToolExecutionOptions, ToolParameters } from '../types/index.js';

export interface DefineToolConfig {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute: (args: unknown, ctx: AgentContext, options?: ToolExecutionOptions) => Promise<unknown>;
}

export function defineTool(config: DefineToolConfig): Tool {
  return config;
}
