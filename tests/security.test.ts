/**
 * Security regression tests: the concrete exploits and fragile inputs found
 * in the read-only review (B1/B2, M1-M5, selected minors).
 *
 * Every repository is created under os.tmpdir() by tests/helpers.ts.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REGISTRY_FILE, isAllowedRepo } from '../src/core/allowlist.js';
import { git } from '../src/core/git.js';
import * as ops from '../src/core/ops.js';
import { getDiff, listRemotes } from '../src/core/query.js';
import { getStatus } from '../src/core/repo.js';
import {
  gitExec,
  makeTempDir,
  makeTempRepo,
  pathExists,
  readRepoFile,
  writeRepoFile,
  type TempRepo,
} from './helpers.js';

const repos: TempRepo[] = [];
const extraDirs: string[] = [];

async function temp(opts?: Parameters<typeof makeTempRepo>[0]): Promise<TempRepo> {
  const repo = await makeTempRepo(opts);
  repos.push(repo);
  return repo;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  extraDirs.push(dir);
  return dir;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
  for (const dir of extraDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* B1 — discard must never follow a symlink out of the repository      */
/* ------------------------------------------------------------------ */

describe('discard symlink containment (B1)', () => {
  it('refuses to delete through a directory symlink and leaves the victim intact', async () => {
    const repo = await temp({ files: { 'README.md': '# repo\n' } });
    const outside = await tempDir('agy-git-outside-');
    await fs.writeFile(path.join(outside, 'victim.txt'), 'external data\n');
    await fs.symlink(outside, path.join(repo.path, 'docs'), 'dir');

    const res = await ops.discard(repo.path, ['docs/victim.txt'], { deleteUntracked: true });
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/symlink/);
    expect(await readRepoFile(outside, 'victim.txt')).toBe('external data\n');
    expect(await pathExists(path.join(repo.path, 'docs'))).toBe(true);
  });

  it('refuses to delete an untracked symlink itself', async () => {
    const repo = await temp({ files: { 'README.md': '# repo\n' } });
    const outside = await tempDir('agy-git-outside-');
    await fs.writeFile(path.join(outside, 'victim.txt'), 'external data\n');
    await fs.symlink(path.join(outside, 'victim.txt'), path.join(repo.path, 'link.txt'));

    const res = await ops.discard(repo.path, ['link.txt'], { deleteUntracked: true });
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/symlink/);
    expect(await pathExists(path.join(repo.path, 'link.txt'))).toBe(true);
    expect(await readRepoFile(outside, 'victim.txt')).toBe('external data\n');
  });

  it('still deletes a normal untracked directory', async () => {
    const repo = await temp();
    await writeRepoFile(repo.path, 'dir/nested/file.txt', 'x\n');

    expect(await ops.discard(repo.path, ['dir'], { deleteUntracked: true })).toMatchObject({
      ok: true,
    });
    expect(await pathExists(path.join(repo.path, 'dir'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* B2 — pathspec magic must not widen the operation scope              */
/* ------------------------------------------------------------------ */

describe('pathspec magic (B2)', () => {
  it('rejects :(glob) and :! paths and keeps unrelated files dirty', async () => {
    const repo = await temp({ files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
    await writeRepoFile(repo.path, 'a.txt', 'a dirty\n');
    await writeRepoFile(repo.path, 'b.txt', 'b dirty\n');

    await expect(ops.discard(repo.path, [':(glob)**'])).rejects.toThrow(
      /pathspec magic|unsafe path/,
    );
    await expect(ops.stage(repo.path, [':!a.txt'])).rejects.toThrow(/pathspec magic|unsafe path/);
    await expect(getDiff(repo.path, { path: ':(glob)**' })).rejects.toThrow(
      /pathspec magic|unsafe path/,
    );

    const status = await getStatus(repo.path);
    expect(status.unstaged.map((c) => c.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(await readRepoFile(repo.path, 'a.txt')).toBe('a dirty\n');
    expect(await readRepoFile(repo.path, 'b.txt')).toBe('b dirty\n');
  });
});

/* ------------------------------------------------------------------ */
/* M1 — status/stage/discard roundtrip for awkward file names          */
/* ------------------------------------------------------------------ */

describe('special filenames with core.quotePath=true (M1)', () => {
  const names = ['测试.txt', 'q"uote.txt', 'tab\tname.txt'];

  it('roundtrips status -> stage -> unstage -> discard without quoting/escaping', async () => {
    const repo = await temp();
    for (const name of names) await writeRepoFile(repo.path, name, `${name}\n`);

    const untracked = await getStatus(repo.path);
    expect(untracked.untracked.map((c) => c.path).sort()).toEqual([...names].sort());

    expect(await ops.stage(repo.path, names)).toMatchObject({ ok: true });
    const staged = await getStatus(repo.path);
    expect(staged.staged.map((c) => c.path).sort()).toEqual([...names].sort());
    expect(staged.untracked).toHaveLength(0);

    expect(await ops.unstageAll(repo.path)).toMatchObject({ ok: true });
    expect((await getStatus(repo.path)).staged).toHaveLength(0);

    expect(await ops.discard(repo.path, names, { deleteUntracked: true })).toMatchObject({
      ok: true,
    });
    for (const name of names) {
      expect(await pathExists(path.join(repo.path, name)), name).toBe(false);
    }
  });

  it('reports raw paths for renames of non-ASCII names', async () => {
    const repo = await temp({ files: { '测试.txt': 'content\n' } });
    await repo.git(['mv', '测试.txt', '测试2.txt']);

    const status = await getStatus(repo.path);
    expect(status.staged[0]).toMatchObject({
      path: '测试2.txt',
      origPath: '测试.txt',
      kind: 'R',
    });
  });
});

/* ------------------------------------------------------------------ */
/* M2 — worktree targets stay beside the repo, never inside/outside    */
/* ------------------------------------------------------------------ */

describe('worktree path containment (M2)', () => {
  async function nestedRepo(): Promise<{ container: string; repoPath: string }> {
    const container = await tempDir('agy-git-wt-parent-');
    const repoPath = path.join(container, 'repo');
    await fs.mkdir(repoPath);
    await gitExec(repoPath, ['init', '-q', '-b', 'main']);
    await gitExec(repoPath, ['config', 'user.name', 'Test User']);
    await gitExec(repoPath, ['config', 'user.email', 'test@example.com']);
    await writeRepoFile(repoPath, 'README.md', '# repo\n');
    await gitExec(repoPath, ['add', '-A']);
    await gitExec(repoPath, ['commit', '-q', '-m', 'initial']);
    return { container, repoPath };
  }

  it('rejects traversal, .git targets and the repo itself', async () => {
    const { repoPath } = await nestedRepo();

    await expect(
      ops.worktreeAdd(repoPath, { path: '../../x', newBranch: 'wt-a' }),
    ).rejects.toThrow(/worktree path/);
    await expect(
      ops.worktreeAdd(repoPath, { path: '.git/evil', newBranch: 'wt-b' }),
    ).rejects.toThrow(/outside the repository/);
    await expect(ops.worktreeAdd(repoPath, { path: repoPath, newBranch: 'wt-c' })).rejects.toThrow(
      /outside the repository/,
    );
    await expect(ops.worktreeRemove(repoPath, { path: '../../x' })).rejects.toThrow(
      /worktree path/,
    );
  });

  it('refuses a target that escapes the parent directory through a symlink', async () => {
    const { container, repoPath } = await nestedRepo();
    const outside = await tempDir('agy-git-wt-outside-');
    const link = path.join(container, 'escape');
    await fs.symlink(outside, link, 'dir');

    await expect(
      ops.worktreeAdd(repoPath, { path: '../escape/wt', newBranch: 'wt-escape' }),
    ).rejects.toThrow(/symlink/);
    expect(await pathExists(path.join(outside, 'wt'))).toBe(false);
  });

  it('still allows a sibling worktree under the parent directory', async () => {
    const { container, repoPath } = await nestedRepo();
    const target = path.join(container, 'linked');

    expect(
      await ops.worktreeAdd(repoPath, { path: target, newBranch: 'wt-ok' }),
    ).toMatchObject({ ok: true });
    expect(await pathExists(path.join(target, 'README.md'))).toBe(true);
    expect(await ops.worktreeRemove(repoPath, { path: target, force: true })).toMatchObject({
      ok: true,
    });
  });
});

/* ------------------------------------------------------------------ */
/* M3 — no file:// or bare local paths as remotes                      */
/* ------------------------------------------------------------------ */

describe('remote URL policy (M3)', () => {
  it('rejects file:// and local paths, leaving the remote list untouched', async () => {
    const repo = await temp();
    const bare = await temp({ bare: true, commits: 0 });

    await expect(
      ops.remoteAdd(repo.path, { name: 'local', url: `file://${bare.path}` }),
    ).rejects.toThrow(/file:/);
    await expect(ops.remoteAdd(repo.path, { name: 'local', url: bare.path })).rejects.toThrow(
      /local path/,
    );
    await expect(
      ops.setRemoteUrl(repo.path, 'origin', `file://${bare.path}`),
    ).rejects.toThrow(/file:/);
    expect(await listRemotes(repo.path)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* M4 — shared allowlist for the MCP process                           */
/* ------------------------------------------------------------------ */

describe('isAllowedRepo (M4)', () => {
  async function registryWith(roots: { registered?: string[]; workspace?: string[] }): Promise<string> {
    const dataDir = await tempDir('agy-git-plugin-data-');
    await fs.writeFile(
      path.join(dataDir, REGISTRY_FILE),
      JSON.stringify({
        registeredRepos: roots.registered ?? [],
        workspaceRepos: roots.workspace ?? [],
        prefs: {},
      }),
      'utf8',
    );
    return dataDir;
  }

  it('accepts registered and workspace roots plus sub-paths, nothing else', async () => {
    const allowed = await tempDir('agy-git-allowed-');
    const workspace = await tempDir('agy-git-workspace-');
    const outside = await tempDir('agy-git-forbidden-');
    const sub = path.join(allowed, 'sub');
    await fs.mkdir(sub);

    const dataDir = await registryWith({ registered: [allowed], workspace: [workspace] });
    expect(await isAllowedRepo(allowed, { dataDir })).toBe(true);
    expect(await isAllowedRepo(sub, { dataDir })).toBe(true);
    expect(await isAllowedRepo(workspace, { dataDir })).toBe(true);
    expect(await isAllowedRepo(outside, { dataDir })).toBe(false);
    // String-prefix sibling is not inside the allowed root.
    const sibling = `${allowed}-evil`;
    await fs.mkdir(sibling);
    extraDirs.push(sibling);
    expect(await isAllowedRepo(sibling, { dataDir })).toBe(false);
  });

  it('fails closed for a missing registry, missing target or malformed file', async () => {
    const allowed = await tempDir('agy-git-allowed-');
    const emptyDir = await tempDir('agy-git-empty-data-');
    expect(await isAllowedRepo(allowed, { dataDir: emptyDir })).toBe(false);
    expect(await isAllowedRepo(path.join(allowed, 'missing'), { dataDir: emptyDir })).toBe(false);

    const broken = await tempDir('agy-git-broken-data-');
    await fs.writeFile(path.join(broken, REGISTRY_FILE), '{not json', 'utf8');
    expect(await isAllowedRepo(allowed, { dataDir: broken })).toBe(false);
  });

  it('honours extraAllowed for internal callers', async () => {
    const allowed = await tempDir('agy-git-allowed-');
    const emptyDir = await tempDir('agy-git-empty-data-');
    expect(await isAllowedRepo(allowed, { dataDir: emptyDir, extraAllowed: [allowed] })).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* env pollution — GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_CONFIG_*   */
/* ------------------------------------------------------------------ */

describe('git environment isolation (BASE_ENV)', () => {
  const KEYS = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_PARAMETERS',
  ] as const;

  it('ignores repository/config redirection from the inherited environment', async () => {
    const repoA = await temp({ files: { 'README.md': '# a\n' } });
    const repoB = await temp({ files: { 'README.md': '# b\n' } });
    await writeRepoFile(repoA.path, 'dirty.txt', 'dirty\n');

    const saved = new Map<string, string | undefined>();
    for (const key of KEYS) saved.set(key, process.env[key]);
    const poisonedIndex = path.join(repoB.path, '.git', 'poisoned-index');
    try {
      process.env.GIT_DIR = path.join(repoB.path, '.git');
      process.env.GIT_WORK_TREE = repoB.path;
      process.env.GIT_INDEX_FILE = poisonedIndex;
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'core.bare';
      process.env.GIT_CONFIG_VALUE_0 = 'true';
      process.env.GIT_CONFIG_PARAMETERS = "'core.bare'='true'";

      const status = await getStatus(repoA.path);
      expect(status.untracked.map((c) => c.path)).toContain('dirty.txt');
      expect(status.repo).toBe(repoA.path);

      expect(await ops.stage(repoA.path, ['dirty.txt'])).toMatchObject({ ok: true });
      expect(await pathExists(poisonedIndex)).toBe(false);
      expect((await getStatus(repoB.path)).clean).toBe(true);
    } finally {
      for (const key of KEYS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* timeout / abort — no orphaned children, result carries the reason    */
/* ------------------------------------------------------------------ */

describe('timeout and abort handling', () => {
  async function fakeSsh(): Promise<{ script: string; pidFile: string }> {
    const dir = await tempDir('agy-git-ssh-');
    const script = path.join(dir, 'fake-ssh.sh');
    const pidFile = path.join(dir, 'pid');
    await fs.writeFile(
      script,
      '#!/bin/sh\necho $$ > "$GIT_SSH_TEST_PIDFILE"\nexec sleep 30\n',
      { encoding: 'utf8', mode: 0o755 },
    );
    return { script, pidFile };
  }

  async function waitForExit(pid: number, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await delay(50);
    }
    return false;
  }

  it.skipIf(process.platform === 'win32')(
    'marks timedOut and kills the process group (no orphaned ssh)',
    async () => {
      const repo = await temp();
      const { script, pidFile } = await fakeSsh();

      // Generous enough that git has certainly spawned the fake ssh before
      // the timeout fires, even when the suite runs under load.
      const res = await git(['ls-remote', 'ssh://example.invalid/repo'], {
        cwd: repo.path,
        timeoutMs: 2000,
        allowFail: true,
        env: { GIT_SSH: script, GIT_SSH_TEST_PIDFILE: pidFile },
      });
      expect(res.code).not.toBe(0);
      expect(res.timedOut).toBe(true);
      expect(res.signal).toBe('SIGTERM');

      const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
      expect(pid).toBeGreaterThan(0);
      expect(await waitForExit(pid), `fake ssh pid ${pid} still alive`).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'propagates abort details through runWrite',
    async () => {
      const repo = await temp();
      const { script, pidFile } = await fakeSsh();
      await repo.git(['remote', 'add', 'origin', 'ssh://example.invalid/repo']);

      const saved = new Map<string, string | undefined>([
        ['GIT_SSH', process.env.GIT_SSH],
        ['GIT_SSH_TEST_PIDFILE', process.env.GIT_SSH_TEST_PIDFILE],
      ]);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 400);
      try {
        process.env.GIT_SSH = script;
        process.env.GIT_SSH_TEST_PIDFILE = pidFile;
        const res = await ops.fetch(repo.path, {
          remote: 'origin',
          signal: controller.signal,
        });
        expect(res.ok).toBe(false);
        expect(res.signal).toBe('SIGTERM');
        expect(res.timedOut).toBeUndefined();
      } finally {
        clearTimeout(timer);
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );
});

/* ------------------------------------------------------------------ */
/* revision positions (16) — --end-of-options backstop                 */
/* ------------------------------------------------------------------ */

describe('revision positions reject option injection', () => {
  it('rejects option-like revisions before git runs', async () => {
    const repo = await temp();

    await expect(
      ops.createBranch(repo.path, { name: 'wt-rev', startPoint: '--upload-pack=x' }),
    ).rejects.toThrow(/unsafe start point/);
    await expect(ops.merge(repo.path, '--upload-pack=x')).rejects.toThrow(/unsafe branch/);
    await expect(ops.rebase(repo.path, '-c')).rejects.toThrow(/unsafe revision/);
    await expect(ops.cherryPick(repo.path, ['--upload-pack=x'])).rejects.toThrow(
      /invalid object id/,
    );
    await expect(ops.setUpstream(repo.path, 'main', '--upload-pack=x')).rejects.toThrow(
      /unsafe upstream/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* no shell — metacharacters stay literal                              */
/* ------------------------------------------------------------------ */

describe('shell metacharacters are inert', () => {
  it('commits ;, $() and backticks as literal message text', async () => {
    const repo = await temp({ files: { 'a.txt': 'one\n' } });
    await writeRepoFile(repo.path, 'a.txt', 'two\n');

    const message = 'fix $(touch pwned) `id`; rm -rf /';
    expect(await ops.stage(repo.path, ['a.txt'])).toMatchObject({ ok: true });
    expect(await ops.commit(repo.path, { message })).toMatchObject({ ok: true });
    expect((await gitExec(repo.path, ['log', '-1', '--format=%s'])).trim()).toBe(message);
    expect(await pathExists(path.join(repo.path, 'pwned'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* selected minors                                                     */
/* ------------------------------------------------------------------ */

describe('sync and discard edge cases', () => {
  it('refuses push(branch) without a remote instead of treating it as one', async () => {
    const repo = await temp();
    await expect(ops.push(repo.path, { branch: 'main' })).rejects.toThrow(
      /push branch requires a remote/,
    );
  });

  it('discards staged files in a repo without HEAD (unborn fallback)', async () => {
    const repo = await temp({ commits: 0, files: { 'x.txt': 'x\n' } });
    expect(await ops.stage(repo.path, ['x.txt'])).toMatchObject({ ok: true });

    expect(await ops.discard(repo.path, ['x.txt'], { staged: true })).toMatchObject({ ok: true });
    const status = await getStatus(repo.path);
    expect(status.staged).toHaveLength(0);
    expect(status.untracked.map((c) => c.path)).toEqual(['x.txt']);
    expect(await pathExists(path.join(repo.path, 'x.txt'))).toBe(true);
  });
});
