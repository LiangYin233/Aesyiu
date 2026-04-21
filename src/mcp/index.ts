import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool as MCPTool } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../types/index.js';

const AESYIU_CLIENT_INFO = {
  name: 'aesyiu',
  version: '0.2.0',
};

type RegisteredMCPServer = {
  client: Client;
  tools: string[];
};

export interface MCPServerConfig extends Pick<StdioServerParameters, 'args' | 'command' | 'cwd' | 'env' | 'stderr'> {
  name: string;
}

export interface MCPServerStatus {
  name: string;
  /** True if this server is currently registered with the manager. The child process could still be dead; connection health is not actively probed. */
  registered: boolean;
  toolNames: string[];
}

export function namespaceMCPToolName(serverName: string, toolName: string): string {
  return `${serverName}.${toolName}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function ensureObjectArguments(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) {
    return {};
  }

  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('MCP tool arguments must be a JSON object');
  }

  return args as Record<string, unknown>;
}

function extractTextContent(content: CallToolResult['content']): string | undefined {
  const textParts = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text);

  if (textParts.length === 0) {
    return undefined;
  }

  return textParts.join('\n');
}

function extractToolError(result: CallToolResult): string {
  const textContent = extractTextContent(result.content);
  if (textContent) {
    return textContent;
  }

  return 'MCP tool execution failed';
}

function normalizeToolResult(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  if ('toolResult' in result) {
    return result.toolResult;
  }

  if (result.isError) {
    throw new Error(extractToolError(result));
  }

  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  const textContent = extractTextContent(result.content);
  if (textContent !== undefined) {
    return textContent;
  }

  return result.content;
}

export class MCPManager {
  private servers: Map<string, RegisteredMCPServer> = new Map();

  public async registerServer(config: MCPServerConfig): Promise<Tool[]> {
    if (this.servers.has(config.name)) {
      throw new Error(`MCP server "${config.name}" is already registered`);
    }

    const client = new Client(AESYIU_CLIENT_INFO);

    try {
      await client.connect(new StdioClientTransport({
        command: config.command,
        ...(config.args ? { args: config.args } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        ...(config.env ? { env: config.env } : {}),
        ...(config.stderr ? { stderr: config.stderr } : {}),
      }));

      const { tools } = await client.listTools();
      const wrappedTools = tools.map((tool) => this.wrapTool(config.name, tool, client));

      this.servers.set(config.name, {
        client,
        tools: wrappedTools.map((tool) => tool.name),
      });

      return wrappedTools;
    } catch (error) {
      await this.safeClose(client);
      throw new Error(`Failed to register MCP server "${config.name}": ${getErrorMessage(error)}`);
    }
  }

  public async registerServers(configs: MCPServerConfig[]): Promise<Tool[]> {
    const tools: Tool[] = [];

    for (const config of configs) {
      tools.push(...await this.registerServer(config));
    }

    return tools;
  }

  public async unregisterServer(name: string): Promise<string[]> {
    const server = this.servers.get(name);
    if (!server) {
      return [];
    }

    this.servers.delete(name);
    await this.safeClose(server.client);
    return [...server.tools];
  }

  public isRegistered(name: string): boolean {
    return this.servers.has(name);
  }

  public getServer(name: string): MCPServerStatus | undefined {
    const server = this.servers.get(name);
    if (!server) return undefined;
    return { name, registered: true, toolNames: [...server.tools] };
  }

  public listServers(): MCPServerStatus[] {
    return this.servers.entries().map(([name, server]) => ({
      name,
      registered: true,
      toolNames: [...server.tools],
    })).toArray();
  }

  public async dispose(): Promise<void> {
    const servers = this.servers.values().toArray();
    this.servers.clear();

    await Promise.all(servers.map(async (server) => {
      await this.safeClose(server.client);
    }));
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  private wrapTool(serverName: string, tool: MCPTool, client: Client): Tool {
    return {
      name: namespaceMCPToolName(serverName, tool.name),
      description: tool.description ?? `MCP tool ${tool.name}`,
      parameters: tool.inputSchema,
      execute: async (args, _ctx, options) => {
        const result = await client.callTool(
          {
            name: tool.name,
            arguments: ensureObjectArguments(args),
          },
          undefined,
          options?.signal ? { signal: options.signal } : undefined,
        );

        return normalizeToolResult(result);
      },
    };
  }

  private async safeClose(client: Client): Promise<void> {
    try {
      await client.close();
    } catch {
      // Best-effort cleanup for partially initialized clients.
    }
  }
}
