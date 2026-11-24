/**
 * MCP server exposing git tools to the agent (stdio).
 *
 * Runs as its own process, so it re-reads the PLUGIN_DATA registry written by
 * the sidecar backend before touching a repo: agent-supplied paths are only
 * accepted when the panel has registered them.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { isAllowedRepo } from '../core/allowlist.js';
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
    if (!(await isAllowedRepo(repo))) {
      throw new Error(
        `repository is not registered with agy-git-controls: ${repo}. ` +
          'Open the Git Controls panel in Antigravity and add the repository first.',
      );
    }
    const status = await getStatus(repo);
    return {
      content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
      structuredContent: status as unknown as Record<string, unknown>,
    };
  },
);

await server.connect(new StdioServerTransport());
