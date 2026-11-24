import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as ops from '../src/core/ops.js';
import {
  getLog,
  listBranches,
  listConflicted,
  listRemotes,
  listStashes,
  listTags,
  listWorktrees,
} from '../src/core/query.js';
import { getStatus } from '../src/core/repo.js';
import {
  commitAll,
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

async function nonexistentTempDir(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  await fs.rm(dir, { recursive: true, force: true });
  extraDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
  for (const dir of extraDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('stage / unstage', () => {
  it('stages and unstages selected paths, including deletions', async () => {
    const repo = await temp({ files: { 'a.txt': 'one\n', 'gone.txt': 'gone\n' } });
    await writeRepoFile(repo.path, 'a.txt', 'one\ntwo\n');
    await writeRepoFile(repo.path, 'new.txt', 'new\n');
    await fs.rm(path.join(repo.path, 'gone.txt'));

    expect(await ops.stage(repo.path, ['a.txt', 'new.txt'])).toMatchObject({ ok: true });
    let status = await getStatus(repo.path);
    expect(status.staged.map((c) => c.path)).toEqual(expect.arrayContaining(['a.txt', 'new.txt']));
    expect(status.unstaged.map((c) => c.path)).toContain('gone.txt');

    expect(await ops.stageAll(repo.path)).toMatchObject({ ok: true });
    status = await getStatus(repo.path);
    expect(status.staged.map((c) => c.path)).toEqual(
      expect.arrayContaining(['a.txt', 'new.txt', 'gone.txt']),
    );
    expect(status.unstaged).toHaveLength(0);

    expect(await ops.unstageAll(repo.path)).toMatchObject({ ok: true });
    status = await getStatus(repo.path);
    expect(status.staged).toHaveLength(0);

    await ops.stage(repo.path, ['a.txt']);
    expect(await ops.unstage(repo.path, ['a.txt'])).toMatchObject({ ok: true });
    expect((await getStatus(repo.path)).staged.map((c) => c.path)).not.toContain('a.txt');
  });

  it('unstages in a repo without commits (unborn HEAD fallback)', async () => {
    const repo = await temp({ commits: 0, files: { 'x.txt': 'x\n' } });
    expect(await ops.stage(repo.path, ['x.txt'])).toMatchObject({ ok: true });
    expect((await getStatus(repo.path)).staged.map((c) => c.path)).toEqual(['x.txt']);

    expect(await ops.unstage(repo.path, ['x.txt'])).toMatchObject({ ok: true });
    expect((await getStatus(repo.path)).staged).toHaveLength(0);
    expect((await getStatus(repo.path)).untracked.map((c) => c.path)).toEqual(['x.txt']);

    await ops.stageAll(repo.path);
    expect(await ops.unstageAll(repo.path)).toMatchObject({ ok: true });
    expect((await getStatus(repo.path)).staged).toHaveLength(0);
  });

  it('returns ok:false when git rejects a pathspec', async () => {
    const repo = await temp();
    const res = await ops.stage(repo.path, ['does-not-exist.txt']);
    expect(res.ok).toBe(false);
    expect(res.stderr).toBeTruthy();
  });
});

describe('discard', () => {
  it('restores tracked changes, staged changes and deletes untracked files on request', async () => {
    const repo = await temp({ files: { 'a.txt': 'one\n' } });

    await writeRepoFile(repo.path, 'a.txt', 'dirty\n');
    expect(await ops.discard(repo.path, ['a.txt'])).toMatchObject({ ok: true });
    expect(await readRepoFile(repo.path, 'a.txt')).toBe('one\n');

    await writeRepoFile(repo.path, 'a.txt', 'staged dirty\n');
    await repo.git(['add', 'a.txt']);
    expect(await ops.discard(repo.path, ['a.txt'], { staged: true })).toMatchObject({ ok: true });
    expect(await readRepoFile(repo.path, 'a.txt')).toBe('one\n');
    expect((await getStatus(repo.path)).staged).toHaveLength(0);

    await writeRepoFile(repo.path, 'staged-new.txt', 'new\n');
    await repo.git(['add', 'staged-new.txt']);
    expect(
      await ops.discard(repo.path, ['staged-new.txt'], { staged: true }),
    ).toMatchObject({ ok: true });
    expect(await pathExists(path.join(repo.path, 'staged-new.txt'))).toBe(false);

    await writeRepoFile(repo.path, 'untracked.txt', 'u\n');
    await expect(ops.discard(repo.path, ['untracked.txt'])).rejects.toThrow(/deleteUntracked/);
    expect(await pathExists(path.join(repo.path, 'untracked.txt'))).toBe(true);

    expect(
      await ops.discard(repo.path, ['untracked.txt'], { deleteUntracked: true }),
    ).toMatchObject({ ok: true });
    expect(await pathExists(path.join(repo.path, 'untracked.txt'))).toBe(false);
  });
});

describe('commit', () => {
  it('creates and amends commits with a new message', async () => {
    const repo = await temp({ files: { 'a.txt': 'one\n' } });
    await writeRepoFile(repo.path, 'a.txt', 'two\n');
    await ops.stageAll(repo.path);

    expect(await ops.commit(repo.path, { message: 'change a' })).toMatchObject({ ok: true });
    expect((await repo.git(['log', '-1', '--format=%s'])).trim()).toBe('change a');
    expect((await repo.git(['rev-list', '--count', 'HEAD'])).trim()).toBe('2');

    expect(
      await ops.commit(repo.path, { message: 'change a amended', amend: true }),
    ).toMatchObject({ ok: true });
    expect((await repo.git(['log', '-1', '--format=%s'])).trim()).toBe('change a amended');
    expect((await repo.git(['rev-list', '--count', 'HEAD'])).trim()).toBe('2');

    await writeRepoFile(repo.path, 'c.txt', 'c\n');
    await ops.stageAll(repo.path);
    expect(await ops.commit(repo.path, { message: 'signed', signoff: true })).toMatchObject({
      ok: true,
    });
    expect((await repo.git(['log', '-1', '--format=%B'])).trim()).toContain(
      'Signed-off-by: Test User <test@example.com>',
    );

    await expect(ops.commit(repo.path, { message: '   ' })).rejects.toThrow(/message/);
  });

  it('returns ok:false when nothing is staged', async () => {
    const repo = await temp();
    const res = await ops.commit(repo.path, { message: 'nothing' });
    expect(res.ok).toBe(false);
    expect(`${res.stdout ?? ''}${res.stderr ?? ''}`).toMatch(/nothing to commit|no changes added/i);
  });
});

describe('branches', () => {
  it('creates, checks out, renames and deletes branches', async () => {
    const repo = await temp();
    const initialSha = (await repo.git(['rev-parse', 'HEAD'])).trim();

    expect(
      await ops.createBranch(repo.path, { name: 'feature/x', checkout: true }),
    ).toMatchObject({ ok: true });
    expect((await getStatus(repo.path)).branch).toBe('feature/x');

    expect(await ops.renameBranch(repo.path, 'feature/x', 'feature/y')).toMatchObject({
      ok: true,
    });
    let branches = await listBranches(repo.path);
    expect(branches.map((b) => b.name)).toContain('feature/y');
    expect(branches.map((b) => b.name)).not.toContain('feature/x');

    expect(
      await ops.createBranch(repo.path, { name: 'from-initial', startPoint: initialSha }),
    ).toMatchObject({ ok: true });
    expect((await repo.git(['rev-parse', 'from-initial'])).trim()).toBe(initialSha);

    await writeRepoFile(repo.path, 'feature.txt', 'f\n');
    await commitAll(repo, 'feature work');
    await ops.checkoutBranch(repo.path, 'main');

    const refused = await ops.deleteBranch(repo.path, 'feature/y');
    expect(refused.ok).toBe(false);
    expect(refused.stderr).toMatch(/not fully merged/i);

    expect(await ops.deleteBranch(repo.path, 'feature/y', { force: true })).toMatchObject({
      ok: true,
    });
    branches = await listBranches(repo.path);
    expect(branches.map((b) => b.name)).not.toContain('feature/y');

    const current = await ops.deleteBranch(repo.path, 'main');
    expect(current.ok).toBe(false);
    expect((await getStatus(repo.path)).branch).toBe('main');
  });

  it('returns git stderr when checkout is blocked by dirty files', async () => {
    const repo = await temp({ files: { 'a.txt': 'base\n' } });
    await repo.git(['checkout', '-q', '-b', 'other']);
    await writeRepoFile(repo.path, 'a.txt', 'other\n');
    await commitAll(repo, 'other change');
    await repo.git(['checkout', '-q', 'main']);
    await writeRepoFile(repo.path, 'a.txt', 'dirty main\n');

    const res = await ops.checkoutBranch(repo.path, 'other');
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/local changes|overwritten/i);
    expect((await getStatus(repo.path)).branch).toBe('main');
  });

  it('sets and unsets upstream', async () => {
    const bare = await temp({ bare: true, commits: 0 });
    const repo = await temp();
    await repo.git(['remote', 'add', 'origin', bare.path]);
    await repo.git(['push', '-q', '-u', 'origin', 'main']);

    expect(await ops.setUpstream(repo.path, 'main', null)).toMatchObject({ ok: true });
    expect((await getStatus(repo.path)).upstream).toBeNull();

    expect(await ops.setUpstream(repo.path, 'main', 'origin/main')).toMatchObject({ ok: true });
    expect((await getStatus(repo.path)).upstream).toBe('origin/main');

    const missing = await ops.setUpstream(repo.path, 'main', 'origin/does-not-exist');
    expect(missing.ok).toBe(false);
  });

  it('rejects option-injection branch names', async () => {
    const repo = await temp();
    await expect(ops.checkoutBranch(repo.path, '-f')).rejects.toThrow(/invalid branch name|unsafe/);
    await expect(ops.createBranch(repo.path, { name: '--orphan' })).rejects.toThrow(
      /invalid branch name|unsafe/,
    );
    await expect(ops.deleteBranch(repo.path, '-D')).rejects.toThrow(/invalid branch name|unsafe/);
  });
});

describe('sync', () => {
  it('pushes to a local bare remote and fetches from it', async () => {
    const bare = await temp({ bare: true, commits: 0 });
    const repo = await temp();
    await repo.git(['remote', 'add', 'origin', bare.path]);
    const head = (await repo.git(['rev-parse', 'HEAD'])).trim();

    const pushed = await ops.push(repo.path, {
      remote: 'origin',
      branch: 'main',
      setUpstream: true,
    });
    expect(pushed.ok).toBe(true);
    expect((await gitExec(bare.path, ['rev-parse', 'refs/heads/main'])).trim()).toBe(head);

    expect(await ops.fetch(repo.path, { remote: 'origin' })).toMatchObject({ ok: true });
  });

  it('pulls fast-forward only by default', async () => {
    const bare = await temp({ bare: true, commits: 0 });
    const repo = await temp();
    await repo.git(['remote', 'add', 'origin', bare.path]);
    await repo.git(['push', '-q', '-u', 'origin', 'main']);

    const cloneDir = await nonexistentTempDir('agy-git-clone-');
    await gitExec(bare.path, ['clone', '-q', bare.path, cloneDir]);
    await gitExec(cloneDir, ['config', 'user.name', 'Other User']);
    await gitExec(cloneDir, ['config', 'user.email', 'other@example.com']);
    await writeRepoFile(cloneDir, 'remote.txt', 'remote\n');
    await gitExec(cloneDir, ['add', '-A']);
    await gitExec(cloneDir, ['commit', '-q', '-m', 'remote work']);
    await gitExec(cloneDir, ['push', '-q']);

    await ops.fetch(repo.path, { remote: 'origin' });
    expect((await getStatus(repo.path)).behind).toBe(1);

    const pulled = await ops.pull(repo.path, { mode: 'ff' });
    expect(pulled.ok).toBe(true);
    expect(await pathExists(path.join(repo.path, 'remote.txt'))).toBe(true);
    expect((await getStatus(repo.path)).behind).toBe(0);
  });
});

describe('stash', () => {
  it('pushes, shows, pops and drops stashes', async () => {
    const repo = await temp({ files: { 'a.txt': 'one\n' } });
    await writeRepoFile(repo.path, 'a.txt', 'two\n');
    await writeRepoFile(repo.path, 'u.txt', 'untracked\n');

    expect(
      await ops.stash(repo.path, {
        action: 'push',
        message: 'wip',
        includeUntracked: true,
      }),
    ).toMatchObject({ ok: true });
    expect(await readRepoFile(repo.path, 'a.txt')).toBe('one\n');
    expect(await pathExists(path.join(repo.path, 'u.txt'))).toBe(false);
    expect((await getStatus(repo.path)).clean).toBe(true);

    const entries = await listStashes(repo.path);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ index: 0, name: 'stash@{0}', message: 'wip', branch: 'main' });

    const shown = await ops.stash(repo.path, { action: 'show', index: 0 });
    expect(shown.ok).toBe(true);
    expect(shown.stdout).toContain('+two');

    expect(await ops.stash(repo.path, { action: 'pop', index: 0 })).toMatchObject({ ok: true });
    expect(await readRepoFile(repo.path, 'a.txt')).toBe('two\n');
    expect(await pathExists(path.join(repo.path, 'u.txt'))).toBe(true);
    expect(await listStashes(repo.path)).toHaveLength(0);

    expect(await ops.stash(repo.path, { action: 'push', message: 'drop me' })).toMatchObject({
      ok: true,
    });
    expect(await ops.stash(repo.path, { action: 'drop', index: 0 })).toMatchObject({ ok: true });
    expect(await listStashes(repo.path)).toHaveLength(0);
    expect(await readRepoFile(repo.path, 'a.txt')).toBe('one\n');
  });

  it('returns ok:false for a missing stash', async () => {
    const repo = await temp();
    const res = await ops.stash(repo.path, { action: 'pop', index: 5 });
    expect(res.ok).toBe(false);
  });
});

describe('worktrees', () => {
  it('adds and removes linked worktrees, refusing dirty trees without force', async () => {
    const repo = await temp();
    const wtPath = await nonexistentTempDir('agy-git-wt-');
    try {
      expect(
        await ops.worktreeAdd(repo.path, { path: wtPath, newBranch: 'wt-branch' }),
      ).toMatchObject({ ok: true });
      expect(await pathExists(wtPath)).toBe(true);

      const worktrees = await listWorktrees(repo.path);
      expect(worktrees).toHaveLength(2);
      const linked = worktrees.find((w) => w.path === wtPath);
      expect(linked).toMatchObject({ branch: 'wt-branch', detached: false });

      await writeRepoFile(wtPath, 'dirty.txt', 'dirty\n');
      const refused = await ops.worktreeRemove(repo.path, { path: wtPath });
      expect(refused.ok).toBe(false);
      expect(refused.stderr).toMatch(/modified or untracked files|use --force/i);

      expect(await ops.worktreeRemove(repo.path, { path: wtPath, force: true })).toMatchObject({
        ok: true,
      });
      expect(await pathExists(wtPath)).toBe(false);
      expect(await listWorktrees(repo.path)).toHaveLength(1);
    } finally {
      await repo.git(['worktree', 'remove', '--force', wtPath], { allowFail: true });
    }
  });

  it('adds a detached worktree', async () => {
    const repo = await temp();
    const wtPath = await nonexistentTempDir('agy-git-wt-detached-');
    try {
      expect(
        await ops.worktreeAdd(repo.path, { path: wtPath, detached: true, branch: 'HEAD' }),
      ).toMatchObject({ ok: true });
      const linked = (await listWorktrees(repo.path)).find((w) => w.path === wtPath);
      expect(linked).toMatchObject({ branch: null, detached: true });
      expect(await ops.worktreeRemove(repo.path, { path: wtPath })).toMatchObject({ ok: true });
    } finally {
      await repo.git(['worktree', 'remove', '--force', wtPath], { allowFail: true });
    }
  });
});

describe('merge / rebase', () => {
  it('fast-forwards and creates merge commits', async () => {
    const repo = await temp({ files: { 'a.txt': 'base\n' } });
    await repo.git(['checkout', '-q', '-b', 'feature']);
    await writeRepoFile(repo.path, 'feature.txt', 'feature\n');
    const featureSha = await commitAll(repo, 'feature work');
    await repo.git(['checkout', '-q', 'main']);

    expect(await ops.merge(repo.path, 'feature')).toMatchObject({ ok: true });
    expect((await repo.git(['rev-parse', 'HEAD'])).trim()).toBe(featureSha);

    await repo.git(['checkout', '-q', '-b', 'feature2']);
    await writeRepoFile(repo.path, 'feature2.txt', 'f2\n');
    await commitAll(repo, 'feature2 work');
    await repo.git(['checkout', '-q', 'main']);

    expect(await ops.merge(repo.path, 'feature2', { noFf: true })).toMatchObject({ ok: true });
    const page = await getLog(repo.path, { all: false, maxCount: 1 });
    expect(page.commits[0]?.parents).toHaveLength(2);
  });

  it('returns conflicts, exposes them and aborts a merge', async () => {
    const repo = await temp({ files: { 'a.txt': 'base\n' } });
    await repo.git(['checkout', '-q', '-b', 'other']);
    await writeRepoFile(repo.path, 'a.txt', 'other\n');
    await commitAll(repo, 'other change');
    await repo.git(['checkout', '-q', 'main']);
    await writeRepoFile(repo.path, 'a.txt', 'main\n');
    await commitAll(repo, 'main change');

    const res = await ops.merge(repo.path, 'other');
    expect(res.ok).toBe(false);
    expect(res.conflicted).toEqual(['a.txt']);
    expect(await listConflicted(repo.path)).toEqual(['a.txt']);
    expect((await getStatus(repo.path)).operation).toBe('merge');

    expect(await ops.merge(repo.path, 'other', { abort: true })).toMatchObject({ ok: true });
    expect(await listConflicted(repo.path)).toEqual([]);
    expect((await getStatus(repo.path)).operation).toBeNull();
    expect(await readRepoFile(repo.path, 'a.txt')).toBe('main\n');

    const missing = await ops.merge(repo.path, 'no-such-branch');
    expect(missing.ok).toBe(false);
  });

  it('aborts a conflicting rebase', async () => {
    const repo = await temp({ files: { 'a.txt': 'base\n' } });
    await repo.git(['checkout', '-q', '-b', 'feature']);
    await writeRepoFile(repo.path, 'a.txt', 'feature\n');
    await commitAll(repo, 'feature change');
    await repo.git(['checkout', '-q', 'main']);
    await writeRepoFile(repo.path, 'a.txt', 'main\n');
    await commitAll(repo, 'main change');
    await repo.git(['checkout', '-q', 'feature']);

    const res = await ops.rebase(repo.path, 'main');
    expect(res.ok).toBe(false);
    expect(res.conflicted).toContain('a.txt');
    expect((await getStatus(repo.path)).operation).toBe('rebase');

    expect(await ops.rebase(repo.path, 'main', { abort: true })).toMatchObject({ ok: true });
    const status = await getStatus(repo.path);
    expect(status.operation).toBeNull();
    expect(status.branch).toBe('feature');
    expect(await readRepoFile(repo.path, 'a.txt')).toBe('feature\n');
  });

  it('rebases cleanly onto an advanced base', async () => {
    const repo = await temp({ files: { 'base.txt': 'base\n' } });
    await repo.git(['checkout', '-q', '-b', 'feature']);
    await writeRepoFile(repo.path, 'feature.txt', 'feature\n');
    await commitAll(repo, 'feature work');
    await repo.git(['checkout', '-q', 'main']);
    await writeRepoFile(repo.path, 'main.txt', 'main\n');
    await commitAll(repo, 'main work');
    await repo.git(['checkout', '-q', 'feature']);

    expect(await ops.rebase(repo.path, 'main')).toMatchObject({ ok: true });
    expect((await getStatus(repo.path)).operation).toBeNull();
    expect(await pathExists(path.join(repo.path, 'main.txt'))).toBe(true);
    expect(await pathExists(path.join(repo.path, 'feature.txt'))).toBe(true);
  });
});

describe('cherry-pick / revert', () => {
  it('cherry-picks a commit and reverts it', async () => {
    const repo = await temp({ files: { 'a.txt': 'base\n' } });
    await repo.git(['checkout', '-q', '-b', 'side']);
    await writeRepoFile(repo.path, 'side.txt', 'side\n');
    const sideSha = await commitAll(repo, 'side work');
    await repo.git(['checkout', '-q', 'main']);

    expect(await ops.cherryPick(repo.path, [sideSha])).toMatchObject({ ok: true });
    expect(await readRepoFile(repo.path, 'side.txt')).toBe('side\n');
    expect((await repo.git(['log', '-1', '--format=%s'])).trim()).toBe('side work');

    const head = (await repo.git(['rev-parse', 'HEAD'])).trim();
    expect(await ops.revert(repo.path, [head])).toMatchObject({ ok: true });
    expect(await pathExists(path.join(repo.path, 'side.txt'))).toBe(false);
    expect((await repo.git(['log', '-1', '--format=%s'])).trim()).toMatch(/^Revert/);
  });

  it('validates commit ids', async () => {
    const repo = await temp();
    await expect(ops.cherryPick(repo.path, ['-n'])).rejects.toThrow(/invalid object id/);
    await expect(ops.cherryPick(repo.path, [])).rejects.toThrow(/at least one/);
    await expect(ops.revert(repo.path, ['HEAD'])).rejects.toThrow(/invalid object id/);
  });
});

describe('tags', () => {
  it('creates lightweight and annotated tags, lists and deletes them', async () => {
    const repo = await temp();
    const head = (await repo.git(['rev-parse', 'HEAD'])).trim();

    expect(await ops.createTag(repo.path, { name: 'v1' })).toMatchObject({ ok: true });
    expect(await ops.createTag(repo.path, { name: 'v2', message: 'release two' })).toMatchObject({
      ok: true,
    });

    const tags = await listTags(repo.path);
    expect(tags.find((t) => t.name === 'v1')).toMatchObject({ annotated: false, sha: head });
    expect(tags.find((t) => t.name === 'v2')).toMatchObject({
      annotated: true,
      sha: head,
      message: 'release two',
    });

    expect(await ops.deleteTag(repo.path, 'v1')).toMatchObject({ ok: true });
    expect((await listTags(repo.path)).map((t) => t.name)).toEqual(['v2']);

    await expect(ops.createTag(repo.path, { name: 'bad..tag' })).rejects.toThrow(/tag/);
    await expect(ops.createTag(repo.path, { name: 'v3', annotated: true })).rejects.toThrow(
      /message/,
    );
    expect((await ops.deleteTag(repo.path, 'missing')).ok).toBe(false);
  });

  it('pushes a tag to a local bare remote', async () => {
    const bare = await temp({ bare: true, commits: 0 });
    const repo = await temp();
    await repo.git(['remote', 'add', 'origin', bare.path]);
    await ops.createTag(repo.path, { name: 'v1' });

    expect(await ops.pushTag(repo.path, 'v1', { remote: 'origin' })).toMatchObject({ ok: true });
    expect((await gitExec(bare.path, ['tag'])).trim()).toBe('v1');
  });
});

describe('remotes', () => {
  it('adds, re-points and removes remotes', async () => {
    const repo = await temp();
    expect(
      await ops.remoteAdd(repo.path, { name: 'origin', url: 'https://example.com/repo.git' }),
    ).toMatchObject({ ok: true });

    expect(await listRemotes(repo.path)).toEqual([
      {
        name: 'origin',
        fetchUrl: 'https://example.com/repo.git',
        pushUrl: 'https://example.com/repo.git',
      },
    ]);

    expect(
      await ops.setRemoteUrl(repo.path, 'origin', 'git@example.com:org/repo.git'),
    ).toMatchObject({ ok: true });
    expect((await listRemotes(repo.path))[0]?.fetchUrl).toBe('git@example.com:org/repo.git');

    expect(
      await ops.setRemoteUrl(repo.path, 'origin', 'ssh://example.com/push.git', { push: true }),
    ).toMatchObject({ ok: true });
    expect((await listRemotes(repo.path))[0]?.pushUrl).toBe('ssh://example.com/push.git');

    expect(await ops.remoteRemove(repo.path, 'origin')).toMatchObject({ ok: true });
    expect(await listRemotes(repo.path)).toEqual([]);
  });

  it('refuses executable transport helpers', async () => {
    const repo = await temp();
    await expect(
      ops.remoteAdd(repo.path, { name: 'evil', url: 'ext::sh -c touch /tmp/pwned' }),
    ).rejects.toThrow(/transport helper/);
    expect(await listRemotes(repo.path)).toEqual([]);
  });
});

describe('option injection', () => {
  it('rejects pathspecs and messages that could be options or empty', async () => {
    const repo = await temp();
    await expect(ops.stage(repo.path, ['--all'])).rejects.toThrow(/unsafe path/);
    await expect(ops.discard(repo.path, ['-f'])).rejects.toThrow(/unsafe path/);
    await expect(ops.commit(repo.path, { message: '\0' })).rejects.toThrow(/message/);
  });
});
