import {
  ITool,
  ToolDefinition,
  ToolExecuteContext,
  ToolExecutionResult,
  ToolCallResult,
  ToolCallRequest,
  validateParameters,
} from './types.js';
import { createNoOpLogger } from '../observability/logger.js';
import type { ILogger } from '../contracts/logger.js';

export interface ToolValidationError {
  toolName: string;
  error: string;
  issues?: Array<{
    path: string[];
    message: string;
  }>;
}

export interface ToolExecutionReport {
  success: boolean;
  toolName: string;
  executionTime: number;
  result: ToolExecutionResult;
}

export class ToolRegistry {
  private static readonly MAX_HISTORY_SIZE = 1000;
  private tools: Map<string, ITool> = new Map();
  private toolCallHistory: ToolCallResult[] = [];
  private logger: ILogger;

  constructor(logger?: ILogger) {
    this.logger = logger ?? createNoOpLogger();
    this.logger.info('ToolRegistry initialized');
  }

  register(tool: ITool): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn(`Tool already exists, will be overwritten: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    this.logger.info(`Tool registered: ${tool.name} (total: ${this.tools.size})`);
  }

  unregister(toolName: string): boolean {
    const deleted = this.tools.delete(toolName);
    if (deleted) {
      this.logger.info(`Tool unregistered: ${toolName} (remaining: ${this.tools.size})`);
    }
    return deleted;
  }

  getTool(toolName: string): ITool | undefined {
    return this.tools.get(toolName);
  }

  hasTool(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  getAllToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => tool.getDefinition());
  }

  getTools(): ITool[] {
    return Array.from(this.tools.values());
  }

  validateToolArguments(
    toolName: string,
    args: Record<string, unknown>
  ): { valid: boolean; errors?: ToolValidationError; parsedArgs?: Record<string, unknown> } {
    const tool = this.tools.get(toolName);

    if (!tool) {
      return {
        valid: false,
        errors: {
          toolName,
          error: `Tool "${toolName}" is not registered`,
        },
      };
    }

    const result = validateParameters(args, tool.parameters);

    if (!result.valid) {
      const issues = (result.errors || []).map(msg => ({
        path: [],
        message: msg,
      }));
      return {
        valid: false,
        errors: {
          toolName,
          error: `Parameter validation failed: ${result.errors?.join(', ')}`,
          issues,
        },
      };
    }

    return { valid: true, parsedArgs: args };
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecuteContext
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();

    this.logger.info({ chatId: context.chatId, traceId: context.traceId }, `Executing tool: ${toolName}`);

    const tool = this.tools.get(toolName);
    if (!tool) {
      const errorResult: ToolExecutionResult = {
        success: false,
        content: '',
        error: `Tool "${toolName}" is not registered`,
      };
      this.logger.error(`Tool not found: ${toolName}`);
      return errorResult;
    }

    const validation = this.validateToolArguments(toolName, args);
    if (!validation.valid) {
      const errorResult: ToolExecutionResult = {
        success: false,
        content: '',
        error: validation.errors!.error,
        metadata: { validationIssues: validation.errors!.issues },
      };
      this.logger.warn({ errors: validation.errors }, `Tool parameter validation failed: ${toolName}`);
      return errorResult;
    }

    try {
      const result = await tool.execute(validation.parsedArgs, context);
      const executionTime = Date.now() - startTime;

      this.logger.info({ executionTime, success: result.success }, `Tool execution completed: ${toolName}`);

      return result;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorResult: ToolExecutionResult = {
        success: false,
        content: '',
        error: error instanceof Error ? error.message : String(error),
        metadata: { executionTime },
      };

      this.logger.error({ executionTime, error: String(error) }, `Tool execution error: ${toolName}`);

      return errorResult;
    }
  }

  async executeTools(
    requests: ToolCallRequest[],
    context: ToolExecuteContext
  ): Promise<ToolCallResult[]> {
    const results: ToolCallResult[] = [];

    this.logger.info({ chatId: context.chatId }, `Batch executing tools: ${requests.length}`);

    for (const request of requests) {
      const result = await this.executeTool(request.name, request.arguments, context);

      const toolCallResult: ToolCallResult = {
        toolCallId: request.id,
        toolName: request.name,
        success: result.success,
        content: result.content,
        error: result.error,
        executionTime: result.metadata?.executionTime as number,
      };

      results.push(toolCallResult);
      this.toolCallHistory.push(toolCallResult);

      if (this.toolCallHistory.length > ToolRegistry.MAX_HISTORY_SIZE) {
        this.toolCallHistory.shift();
      }

      this.pruneOldRecords();
    }

    const successCount = results.filter(r => r.success).length;
    this.logger.info({ total: requests.length, success: successCount }, `Batch tool execution completed`);

    return results;
  }

  getToolCallHistory(): ToolCallResult[] {
    return [...this.toolCallHistory];
  }

  private pruneOldRecords(): void {
    if (this.toolCallHistory.length > ToolRegistry.MAX_HISTORY_SIZE) {
      const excess = this.toolCallHistory.length - ToolRegistry.MAX_HISTORY_SIZE;
      this.toolCallHistory.splice(0, excess);
    }
  }

}
