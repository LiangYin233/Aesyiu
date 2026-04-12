import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const server = new McpServer({
  name: 'test-mcp-server',
  version: '1.0.0',
});

server.registerTool('echo', {
  description: 'Echo a string value',
  inputSchema: {
    value: z.string(),
  },
}, async ({ value }) => ({
  content: [{ type: 'text', text: `echo:${value}` }],
  structuredContent: { echoed: value },
}));

server.registerTool('sum', {
  description: 'Add two numbers together',
  inputSchema: {
    a: z.number(),
    b: z.number(),
  },
}, async ({ a, b }) => ({
  content: [{ type: 'text', text: String(a + b) }],
  structuredContent: { total: a + b },
}));

server.registerTool('explode', {
  description: 'Throw an error for failure-path tests',
  inputSchema: {
    message: z.string().optional(),
  },
}, async ({ message }) => {
  throw new Error(message ?? 'kaboom');
});

const transport = new StdioServerTransport();

server.connect(transport).catch((error) => {
  console.error('Failed to start MCP fixture server:', error);
  process.exit(1);
});
