import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool as MCPTool } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../types/index.js';
import { getErrorMessage } from '../engine/utils.js';

const { version: packageVersion } = JSON.parse(
  readFileSync(join(__dirname, '../../package.json'), 'utf8'),
) as { version: string };

const AESYIU_CLIENT_INFO = {
  name: 'aesyiu',
  version: packageVersion,
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
  registered: boolean;
  toolNames: string[];
}

export function namespaceMCPToolName(serverName: string, toolName: string): string {
  return `${serverName}.${toolName}`;
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

function normalizeToolResult(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  if ('toolResult' in result) {
    return result.toolResult;
  }

  if (result.isError) {
    const text = result.content.map((c) => c.type === 'text' ? c.text : '').join('\n');
    throw new Error(text || 'MCP tool execution failed');
  }

  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  const text = result.content.map((c) => c.type === 'text' ? c.text : '').join('\n');
  if (text) {
    return text;
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
    if (!server) {return undefined;}
    return this.toServerStatus(name, server);
  }

  public listServers(): MCPServerStatus[] {
    return Array.from(this.servers.entries(), ([name, server]) => this.toServerStatus(name, server));
  }

  public async dispose(): Promise<void> {
    const servers = Array.from(this.servers.values());
    this.servers.clear();

    await Promise.all(servers.map((server) => this.safeClose(server.client)));
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

  private toServerStatus(name: string, server: RegisteredMCPServer): MCPServerStatus {
    return { name, registered: true, toolNames: [...server.tools] };
  }

  private async safeClose(client: Client): Promise<void> {
    try {
      await client.close();
    } catch {
    }
  }
}
