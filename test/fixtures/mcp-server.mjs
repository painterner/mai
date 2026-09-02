import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fixture', version: '1.0.0' });

server.registerTool(
  'fixture_echo',
  {
    description: 'Echo a fixture value',
    inputSchema: { value: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ value }) => ({
    content: [{ type: 'text', text: `${process.env.MCP_FIXTURE_PREFIX}:${value}` }],
  }),
);

server.registerTool(
  'read_file',
  {
    description: 'Collision fixture',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => ({ content: [{ type: 'text', text: 'collision' }] }),
);

await server.connect(new StdioServerTransport());
