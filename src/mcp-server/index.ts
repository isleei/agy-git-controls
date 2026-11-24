/**
 * MCP server exposing git tools to the agent (stdio).
 *
 * Runs as its own process, so it re-reads the PLUGIN_DATA registry written by
 * the sidecar backend before touching a repo: agent-supplied paths are only
 * accepted when the panel has registered them.
 *
 * Read-only by design: write operations stay in the panel where the user can
 * see and confirm them. An agent that needs a commit/push should ask the user
 * or use send-to-conversation instead.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { isAllowedRepo } from '../core/allowlist.js';
import { getStatus } from '../core/repo.js';
import { getDiff, getLog, listBranches, listStashes } from '../core/query.js';

const server = new McpServer({ name: 'agy-git-controls', version: '0.1.0' });

const repoParam = {
  repo: z.string().describe('Absolute path inside the git work tree'),
};

async function assertAllowed(repo: string): Promise<void> {
  if (!(await isAllowedRepo(repo))) {
    throw new Error(
      `repository is not registered with agy-git-controls: ${repo}. ` +
        'Open the Git Controls panel in Antigravity and add the repository first.',
    );
  }
}

function json(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

server.registerTool(
  'git_status',
  {
    title: 'Git status',
    description: 'Return branch, ahead/behind and working-tree changes for a repository path.',
    inputSchema: repoParam,
  },
  async ({ repo }) => {
    await assertAllowed(repo);
    return json(await getStatus(repo));
  },
);

server.registerTool(
  'git_branches',
  {
    title: 'Git branches',
    description: 'List local and remote branches with upstream, ahead/behind and last-commit time.',
    inputSchema: repoParam,
  },
  async ({ repo }) => {
    await assertAllowed(repo);
    return json({ branches: await listBranches(repo) });
  },
);

server.registerTool(
  'git_log',
  {
    title: 'Git log',
    description:
      'List commits (sha, parents, author, date, refs, subject) with optional paging, path filter and message search.',
    inputSchema: {
      ...repoParam,
      maxCount: z.number().int().min(1).max(500).optional().describe('Page size, default 200'),
      skip: z.number().int().min(0).optional().describe('Commits to skip for paging'),
      path: z.string().optional().describe('Restrict history to a repository-relative path'),
      ref: z.string().optional().describe('Start from this revision instead of HEAD'),
      query: z.string().optional().describe('Regex matched against commit messages'),
    },
  },
  async ({ repo, maxCount, skip, path, ref, query }) => {
    await assertAllowed(repo);
    return json(
      await getLog(repo, {
        ...(maxCount !== undefined ? { maxCount } : {}),
        ...(skip !== undefined ? { skip } : {}),
        ...(path !== undefined ? { path } : {}),
        ...(ref !== undefined ? { ref } : {}),
        ...(query !== undefined ? { query } : {}),
      }),
    );
  },
);

server.registerTool(
  'git_diff',
  {
    title: 'Git diff',
    description:
      'Return a unified diff for the work tree, the index, or between two revisions. Capped at maxBytes.',
    inputSchema: {
      ...repoParam,
      path: z.string().optional().describe('Restrict to a repository-relative path'),
      staged: z.boolean().optional().describe('Diff the index against HEAD'),
      ref: z.string().optional().describe('Compare this revision against the work tree'),
      ref2: z.string().optional().describe('Compare ref..ref2 instead'),
      context: z.number().int().min(0).max(50).optional().describe('Context lines, default 3'),
      maxBytes: z.number().int().min(1024).optional().describe('Patch byte cap, default 512 KiB'),
    },
  },
  async ({ repo, path, staged, ref, ref2, context, maxBytes }) => {
    await assertAllowed(repo);
    return json(
      await getDiff(repo, {
        ...(path !== undefined ? { path } : {}),
        ...(staged !== undefined ? { staged } : {}),
        ...(ref !== undefined ? { ref } : {}),
        ...(ref2 !== undefined ? { ref2 } : {}),
        ...(context !== undefined ? { context } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      }),
    );
  },
);

server.registerTool(
  'git_stashes',
  {
    title: 'Git stashes',
    description: 'List stash entries with index, message and creation time.',
    inputSchema: repoParam,
  },
  async ({ repo }) => {
    await assertAllowed(repo);
    return json({ entries: await listStashes(repo) });
  },
);

await server.connect(new StdioServerTransport());
