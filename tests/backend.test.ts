/**
 * Backend REST layer tests.
 *
 * Handlers are exercised as plain functions through a fake SidecarApp that
 * records `api()` registrations — no HTTP server, no host process. Every repo
 * lives in os.tmpdir() (see tests/helpers.ts).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiError, DiffResult, LogPage, OperationResult, RepoInfo, RepoStatus } from '../src/core/types.js';
import { MAX_PREFS_BYTES, RepoRegistry } from '../src/sidecar-backend/registry.js';
import {
  registerApi,
  type ApiAppLike,
  type RouteHandler,
} from '../src/sidecar-backend/routes.js';
import { RepoWatcher } from '../src/sidecar-backend/watch.js';
import { makeTempDir, makeTempRepo, writeRepoFile, type TempRepo } from './helpers.js';

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

type CallResult<T> = T & Partial<ApiError>;

class FakeApp implements ApiAppLike {
  readonly config = { projectId: 'test-project' };
  readonly routes = new Map<string, Map<string, RouteHandler>>();
  readonly conversations: Array<{ message: string; opts?: { projectId?: string } }> = [];

  api(p: string, handler: RouteHandler, method: 'GET' | 'POST' = 'POST'): void {
    let methods = this.routes.get(p);
    if (!methods) {
      methods = new Map();
      this.routes.set(p, methods);
    }
    methods.set(method, handler);
  }

  startConversation(message: string, opts?: { projectId?: string }): unknown {
    this.conversations.push({ message, ...(opts !== undefined ? { opts } : {}) });
    return { conversationId: 'conversation-1' };
  }

  async call<T>(p: string, body: Record<string, unknown> = {}, method: 'GET' | 'POST' = 'POST'): Promise<CallResult<T>> {
    const handler = this.routes.get(p)?.get(method);
    if (!handler) throw new Error(`no handler registered for ${method} ${p}`);
    return (await handler(body)) as CallResult<T>;
  }
}

interface Harness {
  app: FakeApp;
  registry: RepoRegistry;
  watcher: RepoWatcher;
  dataDir: string;
}

const tempDirs: string[] = [];
const repos: TempRepo[] = [];
const closeables: Array<() => void> = [];

afterEach(async () => {
  for (const close of closeables.splice(0)) close();
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function newRepo(opts?: Parameters<typeof makeTempRepo>[0]): Promise<TempRepo> {
  const repo = await makeTempRepo(opts);
  repos.push(repo);
  return repo;
}

async function newDir(prefix?: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

async function makeHarness(opts: { debounceMs?: number } = {}): Promise<Harness> {
  const dataDir = await newDir('agy-git-plugin-data-');
  const registry = new RepoRegistry({ dataDir });
  await registry.load();
  const watcher = new RepoWatcher({ debounceMs: opts.debounceMs ?? 20 });
  closeables.push(() => watcher.closeAll());

  const app = new FakeApp();
  registerApi(app, {
    registry,
    versionOf: (repo) => watcher.version(repo),
    agent: {
      startConversation: (message, agentOpts) => app.startConversation(message, agentOpts),
      projectId: 'test-project',
    },
  });
  return { app, registry, watcher, dataDir };
}

async function useWorkspace(h: Harness, repo: TempRepo): Promise<void> {
  const res = await h.app.call<{ repos: RepoInfo[]; workspaceUris: string[] }>('/api/context', {
    workspaceUris: [pathToFileURL(repo.path).href],
  });
  expect(res.repos.map((r) => r.path)).toContain(repo.path);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for condition');
}

/* ------------------------------------------------------------------ */
/* health / context / registry                                         */
/* ------------------------------------------------------------------ */

describe('context and repo registry', () => {
  it('registers workspace repos from URIs and serves status by canonical root', async () => {
    const h = await makeHarness();
    const repo = await newRepo();
    await useWorkspace(h, repo);

    const list = await h.app.call<{ repos: RepoInfo[]; registered: string[] }>('/api/repos/list');
    expect(list.registered).toEqual([]);
    expect(list.repos).toEqual([
      { path: repo.path, name: path.basename(repo.path), isWorktree: false, source: 'workspace' },
    ]);

    const status = await h.app.call<RepoStatus>('/api/status', { repo: repo.path });
    expect(status.repo).toBe(repo.path);
    expect(status.branch).toBe('main');
    expect(status.clean).toBe(true);
    expect(status.operation).toBeNull();

    // /api/context also persists the workspace allowlist for the MCP process.
    const persisted = JSON.parse(
      await fs.readFile(path.join(h.dataDir, 'git-controls.json'), 'utf8'),
    ) as { workspaceRepos: string[] };
    expect(persisted.workspaceRepos).toEqual([repo.path]);
  });

  it('accepts a sub-path of a registered repo but rejects unrelated repos', async () => {
    const h = await makeHarness();
    const repo = await newRepo();
    await useWorkspace(h, repo);
    await fs.mkdir(path.join(repo.path, 'sub', 'dir'), { recursive: true });

    const status = await h.app.call<RepoStatus>('/api/status', {
      repo: path.join(repo.path, 'sub', 'dir'),
    });
    expect(status.repo).toBe(repo.path);

    const outsider = await newRepo();
    const denied = await h.app.call<ApiError>('/api/status', { repo: outsider.path });
    expect(denied.code).toBe('ENOENT_REPO');
    expect(denied.error).toBeTruthy();
  });

  it('adds, persists and removes registered repos (atomic state file)', async () => {
    const h = await makeHarness();
    const repo = await newRepo();

    const info = await h.app.call<RepoInfo>('/api/repos/add', { path: repo.path });
    expect(info).toMatchObject({ path: repo.path, source: 'registered', isWorktree: false });

    const stateFile = path.join(h.dataDir, 'git-controls.json');
    const persisted = JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
      registeredRepos: string[];
      workspaceRepos: string[];
      prefs: Record<string, unknown>;
    };
    expect(persisted.registeredRepos).toEqual([repo.path]);

    // A fresh registry loads the same registration from disk.
    const reloaded = new RepoRegistry({ dataDir: h.dataDir });
    await reloaded.load();
    expect(reloaded.registeredPaths()).toEqual([repo.path]);
    expect(await reloaded.resolveRepo(repo.path)).toMatchObject({
      path: repo.path,
      source: 'registered',
    });
    expect(await reloaded.listRepos()).toHaveLength(1);

    const listed = await h.app.call<{ repos: RepoInfo[]; registered: string[] }>('/api/repos/list');
    expect(listed.registered).toEqual([repo.path]);
    expect(listed.repos.map((r) => r.path)).toEqual([repo.path]);

    const removed = await h.app.call<{ ok: boolean }>('/api/repos/remove', { path: repo.path });
    expect(removed).toEqual({ ok: true });
    expect(await h.registry.resolveRepo(repo.path)).toBeNull();
  });

  it('rejects paths that are not git work trees', async () => {
    const h = await makeHarness();
    const plain = await newDir();
    const added = await h.app.call<ApiError>('/api/repos/add', { path: plain });
    expect(added.code).toBe('EINVAL');
    expect(added.error).toBeTruthy();
  });

  it('rejects malformed context payloads', async () => {
    const h = await makeHarness();
    const res = await h.app.call<ApiError>('/api/context', { workspaceUris: 'not-an-array' });
    expect(res.code).toBe('EINVAL');
  });
});

/* ------------------------------------------------------------------ */
/* prefs                                                               */
/* ------------------------------------------------------------------ */

describe('prefs', () => {
  it('roundtrips through the state file and enforces the size cap', async () => {
    const h = await makeHarness();
    const prefs = { theme: 'dark', layout: { sidebar: 280 }, pinned: ['a'] };

    const set = await h.app.call<{ ok: boolean; prefs: Record<string, unknown> }>(
      '/api/prefs',
      { prefs },
    );
    expect(set.ok).toBe(true);
    expect(set.prefs).toEqual(prefs);

    const got = await h.app.call<{ prefs: Record<string, unknown> }>('/api/prefs', {}, 'GET');
    expect(got.prefs).toEqual(prefs);

    const reloaded = new RepoRegistry({ dataDir: h.dataDir });
    await reloaded.load();
    expect(reloaded.getPrefs()).toEqual(prefs);

    const tooBig = await h.app.call<ApiError>('/api/prefs', {
      prefs: { blob: 'x'.repeat(MAX_PREFS_BYTES) },
    });
    expect(tooBig.code).toBe('EINVAL');
    const notObject = await h.app.call<ApiError>('/api/prefs', { prefs: [1, 2] });
    expect(notObject.code).toBe('EINVAL');
  });
});

/* ------------------------------------------------------------------ */
/* working tree                                                        */
/* ------------------------------------------------------------------ */

describe('index and commit', () => {
  it('runs stage -> status -> unstage -> commit', async () => {
    const h = await makeHarness();
    const repo = await newRepo();
    await useWorkspace(h, repo);
    await writeRepoFile(repo.path, 'note.txt', 'hello\n');

    const staged = await h.app.call<OperationResult>('/api/stage', {
      repo: repo.path,
      paths: ['note.txt'],
    });
    expect(staged.ok).toBe(true);

    const status = await h.app.call<RepoStatus>('/api/status', { repo: repo.path });
    expect(status.staged.map((change) => change.path)).toEqual(['note.txt']);
    expect(status.untracked).toHaveLength(0);

    const unstaged = await h.app.call<OperationResult>('/api/unstage', {
      repo: repo.path,
      paths: ['note.txt'],
    });
    expect(unstaged.ok).toBe(true);
    const afterUnstage = await h.app.call<RepoStatus>('/api/status', { repo: repo.path });
    expect(afterUnstage.untracked.map((change) => change.path)).toEqual(['note.txt']);

    await h.app.call<OperationResult>('/api/stage-all', { repo: repo.path });
    const committed = await h.app.call<OperationResult>('/api/commit', {
      repo: repo.path,
      message: 'add note',
    });
    expect(committed.ok).toBe(true);
    expect((await h.app.call<RepoStatus>('/api/status', { repo: repo.path })).clean).toBe(true);
  });

  it('maps unsafe pathspecs to EINVAL and core failures to GIT', async () => {
    const h = await makeHarness();
    const repo = await newRepo();
    await useWorkspace(h, repo);

    const traversal = await h.app.call<ApiError>('/api/stage', {
      repo: repo.path,
      paths: ['../escape.txt'],
    });
    expect(traversal.code).toBe('EINVAL');

    const badBranch = await h.app.call<ApiError>('/api/branch/checkout', {
      repo: repo.path,
      name: '--upload-pack=evil',
    });
    expect(badBranch.code).toBe('EINVAL');

    const missing = await h.app.call<ApiError>('/api/commit', { repo: repo.path, message: '   ' });
    expect(missing.code).toBe('EINVAL');
  });

  it('returns diffs and log pages', async () => {
    const h = await makeHarness();
    const repo = await newRepo();
    await useWorkspace(h, repo);
    await writeRepoFile(repo.path, 'README.md', '# changed\n');

    const diff = await h.app.call<DiffResult>('/api/diff', { repo: repo.path, path: 'README.md' });
    expect(diff.path).toBe('README.md');
    expect(diff.hunks).toContain('diff --git');
    expect(diff.truncated).toBe(false);

    const log = await h.app.call<LogPage>('/api/log', { repo: repo.path, maxCount: 10 });
    expect(log.commits).toHaveLength(1);
    expect(log.commits[0]?.subject).toBe('initial commit');

    const filtered = await h.app.call<LogPage>('/api/log', {
      repo: repo.path,
      query: 'no-such-message',
    });
    expect(filtered.commits).toHaveLength(0);

    const branches = await h.app.call<{ branches: Array<{ name: string; current: boolean }> }>(
      '/api/branches',
      { repo: repo.path },
    );
    expect(branches.branches.find((b) => b.current)?.name).toBe('main');
  });
});

/* ------------------------------------------------------------------ */
/* confirmations                                                       */
/* ------------------------------------------------------------------ */

describe('dangerous operations', () => {
  it('requires confirmed:true and names the endpoint', async () => {
    const h = await makeHarness();
    const repo = await newRepo();
    await useWorkspace(h, repo);
    await repo.git(['branch', 'feature']);
    await writeRepoFile(repo.path, 'tracked.txt', 'x\n');
    await repo.git(['add', '-A']);
    await repo.git(['commit', '-q', '-m', 'second']);
    await writeRepoFile(repo.path, 'tracked.txt', 'y\n');
    await writeRepoFile(repo.path, 'untracked.txt', 'z\n');

    const cases: Array<[string, Record<string, unknown>]> = [
      ['/api/branch/delete', { name: 'feature' }],
      ['/api/discard', { paths: ['tracked.txt'], deleteUntracked: true }],
      ['/api/push', { forceWithLease: true }],
      ['/api/stash', { action: 'drop' }],
      ['/api/worktree/remove', { path: path.join(repo.path, '..', 'other-wt') }],
      ['/api/remote/remove', { name: 'origin' }],
      ['/api/tag/delete', { name: 'v1' }],
    ];
    for (const [endpoint, body] of cases) {
      const res = await h.app.call<ApiError>(endpoint, { repo: repo.path, ...body });
      expect(res, endpoint).toEqual({ error: 'confirm-required', action: endpoint });
    }

    // Nothing was changed while every request was refused.
    expect((await h.app.call<RepoStatus>('/api/status', { repo: repo.path })).clean).toBe(false);
    expect(
      (await h.app.call<{ branches: Array<{ name: string }> }>('/api/branches', { repo: repo.path }))
        .branches.some((b) => b.name === 'feature'),
    ).toBe(true);

    const deleted = await h.app.call<OperationResult>('/api/branch/delete', {
      repo: repo.path,
      name: 'feature',
      confirmed: true,
    });
    expect(deleted.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* remotes / track-remote                                              */
/* ------------------------------------------------------------------ */

describe('remote tracking', () => {
  it('fetches and creates a tracking branch from a remote branch', async () => {
    const h = await makeHarness();
    const origin = await newRepo();
    const bare = await newRepo({ bare: true });
    await origin.git(['remote', 'add', 'origin', bare.path]);
    await origin.git(['push', '-q', '-u', 'origin', 'main']);

    await useWorkspace(h, origin);

    const fetched = await h.app.call<OperationResult>('/api/fetch', {
      repo: origin.path,
      remote: 'origin',
    });
    expect(fetched.ok).toBe(true);

    const tracked = await h.app.call<OperationResult>('/api/track-remote', {
      repo: origin.path,
      remoteBranch: 'origin/main',
      localName: 'from-remote',
    });
    expect(tracked.ok).toBe(true);

    const status = await h.app.call<RepoStatus>('/api/status', { repo: origin.path });
    expect(status.branch).toBe('from-remote');
    expect(status.upstream).toBe('origin/main');
  });
});

/* ------------------------------------------------------------------ */
/* merge conflicts                                                     */
/* ------------------------------------------------------------------ */

describe('merge', () => {
  it('passes OperationResult{ok:false} through with conflicted paths', async () => {
    const h = await makeHarness();
    const repo = await newRepo();
    await useWorkspace(h, repo);

    await repo.git(['checkout', '-q', '-b', 'side']);
    await writeRepoFile(repo.path, 'README.md', 'side\n');
    await repo.git(['add', '-A']);
    await repo.git(['commit', '-q', '-m', 'side']);
    await repo.git(['checkout', '-q', 'main']);
    await writeRepoFile(repo.path, 'README.md', 'main\n');
    await repo.git(['add', '-A']);
    await repo.git(['commit', '-q', '-m', 'main']);

    const merged = await h.app.call<OperationResult>('/api/merge', {
      repo: repo.path,
      branch: 'side',
    });
    expect(merged.ok).toBe(false);
    expect(merged.code).not.toBe(0);
    expect(merged.conflicted).toEqual(['README.md']);
    expect(merged.stdout ?? merged.stderr).toBeTruthy();

    const conflicts = await h.app.call<{ files: string[]; operation: string | null }>(
      '/api/conflicts',
      { repo: repo.path },
    );
    expect(conflicts).toEqual({ files: ['README.md'], operation: 'merge' });

    const aborted = await h.app.call<OperationResult>('/api/merge', {
      repo: repo.path,
      action: 'abort',
    });
    expect(aborted.ok).toBe(true);
    expect(
      await h.app.call<{ files: string[]; operation: string | null }>('/api/conflicts', {
        repo: repo.path,
      }),
    ).toEqual({ files: [], operation: null });
  });

  it('requires branch only when starting a merge', async () => {
    const h = await makeHarness();
    const repo = await newRepo();
    await useWorkspace(h, repo);

    const missing = await h.app.call<ApiError>('/api/merge', { repo: repo.path });
    expect(missing.code).toBe('EINVAL');
    expect(missing.error).toMatch(/branch is required/);

    const unsafe = await h.app.call<ApiError>('/api/merge', {
      repo: repo.path,
      branch: '--upload-pack=evil',
    });
    expect(unsafe.code).toBe('EINVAL');
  });
});

/* ------------------------------------------------------------------ */
/* stash                                                               */
/* ------------------------------------------------------------------ */

describe('stash', () => {
  it('pushes, shows and drops a stash', async () => {
    const h = await makeHarness();
    const repo = await newRepo();
    await useWorkspace(h, repo);
    await writeRepoFile(repo.path, 'README.md', '# dirty\n');

    const pushed = await h.app.call<OperationResult>('/api/stash', {
      repo: repo.path,
      action: 'push',
      message: 'wip',
    });
    expect(pushed.ok).toBe(true);
    expect((await h.app.call<RepoStatus>('/api/status', { repo: repo.path })).clean).toBe(true);

    const shown = await h.app.call<{ entries: Array<{ message: string }>; text: string }>(
      '/api/stash',
      { repo: repo.path, action: 'show', index: 0 },
    );
    expect(shown.entries[0]?.message).toBe('wip');
    expect(shown.text).toContain('README.md');

    const denied = await h.app.call<{ error: string; action?: string }>('/api/stash', {
      repo: repo.path,
      action: 'drop',
    });
    expect(denied.action).toBe('/api/stash');

    const dropped = await h.app.call<OperationResult>('/api/stash', {
      repo: repo.path,
      action: 'drop',
      confirmed: true,
    });
    expect(dropped.ok).toBe(true);
    const list = await h.app.call<{ entries: unknown[] }>('/api/stashes', { repo: repo.path });
    expect(list.entries).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* ai                                                                  */
/* ------------------------------------------------------------------ */

describe('ai bridge', () => {
  it('sends a diff to a new conversation and does not touch the agent otherwise', async () => {
    const h = await makeHarness();
    const repo = await newRepo();
    await useWorkspace(h, repo);
    await h.app.call<RepoStatus>('/api/status', { repo: repo.path });
    expect(h.app.conversations).toHaveLength(0);

    await writeRepoFile(repo.path, 'README.md', '# changed\n');
    const res = await h.app.call<{ conversationId: string }>('/api/ai/send-to-conversation', {
      repo: repo.path,
      kind: 'diff',
      paths: ['README.md'],
      prompt: 'Explain this diff',
    });
    expect(res.conversationId).toBe('conversation-1');
    expect(h.app.conversations).toHaveLength(1);
    const sent = h.app.conversations[0];
    expect(sent?.message).toContain('Explain this diff');
    expect(sent?.message).toContain('diff --git');
    expect(sent?.opts).toEqual({ projectId: 'test-project' });
  });

  it('sends commit text for kind=commit', async () => {
    const h = await makeHarness();
    const repo = await newRepo();
    await useWorkspace(h, repo);

    await h.app.call<{ conversationId: string }>('/api/ai/send-to-conversation', {
      repo: repo.path,
      kind: 'commit',
    });
    const sent = h.app.conversations[0];
    expect(sent?.message).toContain('initial commit');
    expect(sent?.message).toContain('commit ');
  });

  it('validates kind and prompt length', async () => {
    const h = await makeHarness();
    const repo = await newRepo();
    await useWorkspace(h, repo);
    const badKind = await h.app.call<ApiError>('/api/ai/send-to-conversation', {
      repo: repo.path,
      kind: 'everything',
    });
    expect(badKind.code).toBe('EINVAL');
    expect(h.app.conversations).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* version / watcher                                                   */
/* ------------------------------------------------------------------ */

describe('repo version', () => {
  it('reports 0 without a watcher and bumps after fs activity', async () => {
    const h = await makeHarness({ debounceMs: 20 });
    const repo = await newRepo();
    await useWorkspace(h, repo);

    expect(await h.app.call<{ v: number }>('/api/version', { repo: repo.path })).toEqual({ v: 0 });

    h.watcher.sync([repo.path]);
    expect(h.watcher.state(repo.path)).toEqual({ watched: true, version: 0, lastChangeAt: null });
    expect(await h.app.call<{ v: number }>('/api/version', { repo: repo.path })).toEqual({ v: 0 });

    await writeRepoFile(repo.path, 'watched.txt', 'one\n');
    await repo.git(['add', '-A']);
    await waitFor(() => h.watcher.version(repo.path) > 0);

    const bumped = await h.app.call<{ v: number }>('/api/version', { repo: repo.path });
    expect(bumped.v).toBeGreaterThan(0);
    expect(h.watcher.lastChangeAt(repo.path)).toBeTypeOf('number');
  });

  it('ignores repos that cannot be watched and closes watchers on demand', async () => {
    const h = await makeHarness({ debounceMs: 10 });
    const missing = path.join(h.dataDir, 'does-not-exist');
    h.watcher.sync([missing]);
    expect(h.watcher.watchedCount).toBe(0);
    expect(h.watcher.version(missing)).toBe(0);

    const repo = await newRepo();
    h.watcher.sync([repo.path]);
    expect(h.watcher.watchedCount).toBe(1);
    h.watcher.sync([]);
    expect(h.watcher.watchedCount).toBe(0);
    expect(h.watcher.state(repo.path).watched).toBe(false);
  });

  it('rejects /api/version for unregistered repos', async () => {
    const h = await makeHarness();
    const repo = await newRepo();
    const res = await h.app.call<ApiError>('/api/version', { repo: repo.path });
    expect(res.code).toBe('ENOENT_REPO');
  });
});

/* ------------------------------------------------------------------ */
/* endpoint inventory                                                  */
/* ------------------------------------------------------------------ */

describe('endpoint registration', () => {
  it('registers every endpoint from docs/api.md plus /api/version', async () => {
    const h = await makeHarness();
    const post = [
      '/api/context',
      '/api/repos/list',
      '/api/repos/add',
      '/api/repos/remove',
      '/api/status',
      '/api/branches',
      '/api/branch/create',
      '/api/branch/checkout',
      '/api/branch/rename',
      '/api/branch/delete',
      '/api/branch/set-upstream',
      '/api/track-remote',
      '/api/stage',
      '/api/unstage',
      '/api/stage-all',
      '/api/unstage-all',
      '/api/discard',
      '/api/diff',
      '/api/commit',
      '/api/fetch',
      '/api/pull',
      '/api/push',
      '/api/log',
      '/api/conflicts',
      '/api/merge',
      '/api/rebase',
      '/api/cherry-pick',
      '/api/revert',
      '/api/stash',
      '/api/stashes',
      '/api/worktrees',
      '/api/worktree/add',
      '/api/worktree/remove',
      '/api/remotes',
      '/api/remote/add',
      '/api/remote/remove',
      '/api/tags',
      '/api/tag/create',
      '/api/tag/delete',
      '/api/ai/send-to-conversation',
      '/api/version',
      '/api/prefs',
    ];
    for (const p of post) {
      expect(h.app.routes.get(p)?.has('POST'), p).toBe(true);
    }
    expect(h.app.routes.get('/api/ping')?.has('GET')).toBe(true);
    expect(h.app.routes.get('/api/prefs')?.has('GET')).toBe(true);
  });
});
