/**
 * Git Controls sidecar backend.
 * Serves the single-file UI and /api/* routes backed by src/core.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, fileURLToPath as toPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import { getStatus, repoInfoFor, canonicalPath } from '../core/repo.js';
import { git } from '../core/git.js';
import type { RepoInfo, WorkspaceContext } from '../core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(__dirname, 'ui', 'index.html');

const app = new SidecarApp();

/** Workspace folder paths reported by the UI (from window.sidecar.getWorkspaceUris). */
let workspacePaths: string[] = [];
const workspaceRepos = new Map<string, RepoInfo>();
const registeredRepos = new Map<string, RepoInfo>();

function uriToPath(uri: string): string | null {
  try {
    if (uri.startsWith('file://')) return toPath(uri);
    if (path.isAbsolute(uri)) return uri;
    return null;
  } catch {
    return null;
  }
}

async function resolveWorkspaceRepos(): Promise<RepoInfo[]> {
  workspaceRepos.clear();
  for (const p of workspacePaths) {
    const info = await repoInfoFor(p, 'workspace');
    if (info) workspaceRepos.set(info.path, info);
  }
  return [...workspaceRepos.values(), ...registeredRepos.values()];
}

function findRepo(repoPath: string): string | null {
  if (workspaceRepos.has(repoPath)) return repoPath;
  if (registeredRepos.has(repoPath)) return repoPath;
  return null;
}

// ---------- pages ----------
app.page('/', () => {
  if (!fs.existsSync(UI_FILE)) {
    return new Response('UI not built — run pnpm build', { status: 500 });
  }
  return new Response(fs.readFileSync(UI_FILE, 'utf-8'), { contentType: 'text/html' });
});

// ---------- api ----------
app.api('/api/ping', () => ({ ok: true, ts: Date.now(), projectId: app.config.projectId }), 'GET');

app.api('/api/context', async (data) => {
  const uris = Array.isArray(data?.workspaceUris) ? (data.workspaceUris as string[]) : [];
  workspacePaths = uris.map(uriToPath).filter((p): p is string => p !== null);
  const repos = await resolveWorkspaceRepos();
  const ctx: WorkspaceContext = { workspaceUris: workspacePaths, repos };
  return ctx;
});

app.api('/api/status', async (data) => {
  const repo = typeof data?.repo === 'string' ? await canonicalPath(data.repo) : null;
  if (!repo || !findRepo(repo)) return { error: 'repo not registered', code: 'ENOENT_REPO' };
  return getStatus(repo);
});

app.api('/api/repos/add', async (data) => {
  const p = typeof data?.path === 'string' ? data.path : null;
  if (!p) return { error: 'path required' };
  const info = await repoInfoFor(await canonicalPath(p), 'registered');
  if (!info) return { error: 'not a git work tree' };
  registeredRepos.set(info.path, info);
  return info;
});

app.api('/api/branches', async (data) => {
  const repo = typeof data?.repo === 'string' ? await canonicalPath(data.repo) : null;
  if (!repo || !findRepo(repo)) return { error: 'repo not registered', code: 'ENOENT_REPO' };
  const res = await git(
    ['for-each-ref', '--format=%(refname)%09%(refname:short)%09%(committerdate:iso8601)%09%(upstream:short)%09%(HEAD)', 'refs/heads', 'refs/remotes'],
    { cwd: repo },
  );
  const branches = res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref = '', short = '', date = '', upstream = '', head = ''] = line.split('\t');
      return { ref, name: short, remote: ref.startsWith('refs/remotes/'), lastCommitAt: date, upstream: upstream || null, current: head === '*' };
    });
  return { branches };
});

app.run().then(() => {
  console.log('[git-controls] sidecar ready');
});
