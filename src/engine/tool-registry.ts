import type { Tool } from '../types/index.js';
import { isZodSchema } from '../tool/schema.js';

export class ToolRegistry {
  private globalTools = new Map<string, Tool>();
  private mcpTools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (tool.parameters && !isZodSchema(tool.parameters)) {
      console.warn(
        `[aesyiu] tool "${tool.name}" uses a JSON schema; arguments pass through unvalidated. ` +
        'Provide a Zod schema to enable runtime validation.',
      );
    }
    this.globalTools.set(tool.name, tool);
  }

  registerMCP(tools: Tool[]): void {
    for (const tool of tools) {
      this.globalTools.set(tool.name, tool);
      this.mcpTools.set(tool.name, tool);
    }
  }

  unregisterMCPTools(toolNames: string[]): string[] {
    const removed: string[] = [];
    for (const toolName of toolNames) {
      const recorded = this.mcpTools.get(toolName);
      this.mcpTools.delete(toolName);
      if (recorded && this.globalTools.get(toolName) === recorded) {
        this.globalTools.delete(toolName);
        removed.push(toolName);
      }
    }
    return removed;
  }

  getTools(): Tool[] {
    return Array.from(this.globalTools.values());
  }

  getAll(): ReadonlyMap<string, Tool> {
    return this.globalTools;
  }

  resolve(names: string[]): Map<string, Tool> {
    const result = new Map<string, Tool>();
    for (const name of names) {
      const tool = this.globalTools.get(name);
      if (!tool) {
        throw new Error(`Tool "${name}" is not registered`);
      }
      result.set(name, tool);
    }
    return result;
  }

  delete(name: string): boolean {
    return this.globalTools.delete(name);
  }

  has(name: string): boolean {
    return this.globalTools.has(name);
  }

  clear(): void {
    this.globalTools.clear();
    this.mcpTools.clear();
  }
}
