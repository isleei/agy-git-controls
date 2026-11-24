/**
 * MCP server exposing git tools to the agent (stdio).
 * Shares src/core with the sidecar backend. Filled out in Phase: MCP.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getStatus } from '../core/repo.js';

const server = new McpServer({ name: 'agy-git-controls', version: '0.1.0' });

server.registerTool(
  'git_status',
  {
    title: 'Git status',
    description: 'Return branch, ahead/behind and working-tree changes for a repository path.',
    inputSchema: { repo: z.string().describe('Absolute path inside the git work tree') },
  },
  async ({ repo }) => {
    const status = await getStatus(repo);
    return {
      content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
      structuredContent: status as unknown as Record<string, unknown>,
    };
  },
);

await server.connect(new StdioServerTransport());
