import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getDiff,
  getFileDiff,
  getLog,
  listBranches,
  listRemotes,
  listStashes,
  listTags,
  listWorktrees,
  parseCommitRefs,
} from '../src/core/query.js';
import {
  commitAll,
  gitExec,
  makeTempDir,
  makeTempRepo,
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

describe('listBranches', () => {
  it('lists local and remote branches with upstream and ahead/behind', async () => {
    const bare = await temp({ bare: true, commits: 0 });
    const repo = await temp();
    await repo.git(['remote', 'add', 'origin', bare.path]);
    await repo.git(['push', '-q', '-u', 'origin', 'main']);
    await repo.git(['branch', 'feature/x']);

    let branches = await listBranches(repo.path);
    const main = branches.find((b) => b.name === 'main');
    expect(main).toMatchObject({
      ref: 'refs/heads/main',
      remote: false,
      current: true,
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
    });
    expect(main?.lastCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(main?.lastCommitAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const remoteMain = branches.find((b) => b.name === 'origin/main');
    expect(remoteMain).toMatchObject({ remote: true, current: false, ref: 'refs/remotes/origin/main' });
    expect(branches.find((b) => b.name === 'feature/x')).toMatchObject({ current: false });

    // Local commit ahead of upstream.
    await writeRepoFile(repo.path, 'ahead.txt', 'ahead\n');
    await commitAll(repo, 'local work');

    // Remote commit behind (made in a separate clone).
    const cloneDir = await nonexistentTempDir('agy-git-clone-');
    await gitExec(bare.path, ['clone', '-q', bare.path, cloneDir]);
    await gitExec(cloneDir, ['config', 'user.name', 'Other User']);
    await gitExec(cloneDir, ['config', 'user.email', 'other@example.com']);
    await writeRepoFile(cloneDir, 'remote.txt', 'remote\n');
    await gitExec(cloneDir, ['add', '-A']);
    await gitExec(cloneDir, ['commit', '-q', '-m', 'remote work']);
    await gitExec(cloneDir, ['push', '-q']);
    await repo.git(['fetch', '-q', 'origin']);

    branches = await listBranches(repo.path);
    expect(branches.find((b) => b.name === 'main')).toMatchObject({ ahead: 1, behind: 1 });
  });

  it('reports the unborn current branch in a fresh repo', async () => {
    const repo = await temp({ commits: 0, files: {} });
    const branches = await listBranches(repo.path);
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({
      name: 'main',
      ref: 'refs/heads/main',
      current: true,
      remote: false,
      upstream: null,
      lastCommitSha: '',
    });
  });
});

describe('listWorktrees', () => {
  it('parses main, linked and detached worktrees', async () => {
    const repo = await temp();
    const wtPath = await nonexistentTempDir('agy-git-wt-');
    const detachedPath = await nonexistentTempDir('agy-git-wt-detached-');
    try {
      await repo.git(['worktree', 'add', '-q', '-b', 'wt', wtPath, 'main']);
      await repo.git(['worktree', 'add', '-q', '--detach', detachedPath, 'HEAD']);

      const worktrees = await listWorktrees(repo.path);
      expect(worktrees).toHaveLength(3);

      const main = worktrees.find((w) => w.path === repo.path);
      expect(main).toMatchObject({ branch: 'main', detached: false, bare: false, locked: false });

      const linked = worktrees.find((w) => w.path === wtPath);
      expect(linked).toMatchObject({ branch: 'wt', detached: false });
      expect(linked?.head).toMatch(/^[0-9a-f]{40}$/);

      const detached = worktrees.find((w) => w.path === detachedPath);
      expect(detached).toMatchObject({ branch: null, detached: true });

      await repo.git(['worktree', 'remove', '--force', wtPath]);
      await repo.git(['worktree', 'remove', '--force', detachedPath]);
      expect(await listWorktrees(repo.path)).toHaveLength(1);
    } finally {
      await repo.git(['worktree', 'remove', '--force', wtPath], { allowFail: true });
      await repo.git(['worktree', 'remove', '--force', detachedPath], { allowFail: true });
    }
  });
});

describe('listRemotes / listTags / listStashes', () => {
  it('lists remotes with fetch and push urls', async () => {
    const repo = await temp();
    await repo.git(['remote', 'add', 'origin', 'https://example.com/repo.git']);
    await repo.git(['remote', 'set-url', '--push', 'origin', 'ssh://example.com/push.git']);

    expect(await listRemotes(repo.path)).toEqual([
      {
        name: 'origin',
        fetchUrl: 'https://example.com/repo.git',
        pushUrl: 'ssh://example.com/push.git',
      },
    ]);
  });

  it('distinguishes annotated and lightweight tags', async () => {
    const repo = await temp();
    const head = (await repo.git(['rev-parse', 'HEAD'])).trim();
    await repo.git(['tag', 'v1']);
    await repo.git(['tag', '-a', 'v2', '-m', 'release two']);

    const tags = await listTags(repo.path);
    const v1 = tags.find((t) => t.name === 'v1');
    const v2 = tags.find((t) => t.name === 'v2');
    expect(v1).toMatchObject({ annotated: false, sha: head });
    expect(v1?.message).toBeUndefined();
    expect(v2).toMatchObject({ annotated: true, sha: head, message: 'release two' });
    expect(v2?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('lists stashes with index, message, branch and date', async () => {
    const repo = await temp({ files: { 'a.txt': 'base\n' } });
    await writeRepoFile(repo.path, 'a.txt', 'first\n');
    await repo.git(['stash', 'push', '-q', '-m', 'first stash']);
    await writeRepoFile(repo.path, 'a.txt', 'second\n');
    await repo.git(['stash', 'push', '-q', '-m', 'second stash']);

    const entries = await listStashes(repo.path);
    expect(entries.map((e) => e.name)).toEqual(['stash@{0}', 'stash@{1}']);
    expect(entries[0]).toMatchObject({ index: 0, message: 'second stash', branch: 'main' });
    expect(entries[1]).toMatchObject({ index: 1, message: 'first stash', branch: 'main' });
    expect(entries[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('parseCommitRefs', () => {
  it('classifies fully qualified decorations', () => {
    expect(
      parseCommitRefs(
        'HEAD -> refs/heads/main, tag: refs/tags/v1.0, refs/remotes/origin/main, refs/stash',
      ),
    ).toEqual([
      { name: 'HEAD', type: 'head' },
      { name: 'main', type: 'branch' },
      { name: 'v1.0', type: 'tag' },
      { name: 'origin/main', type: 'remote' },
      { name: 'stash', type: 'stash' },
    ]);
  });

  it('handles detached HEAD and short fallbacks', () => {
    expect(parseCommitRefs('HEAD')).toEqual([{ name: 'HEAD', type: 'head' }]);
    expect(parseCommitRefs('HEAD -> main, tag: v1')).toEqual([
      { name: 'HEAD', type: 'head' },
      { name: 'main', type: 'branch' },
      { name: 'v1', type: 'tag' },
    ]);
  });
});

describe('getLog', () => {
  it('returns commits with parents and refs decorations', async () => {
    const repo = await temp({ files: { 'a.txt': '0\n' }, commits: 3 });
    const headSha = (await repo.git(['rev-parse', 'HEAD'])).trim();
    const firstSha = (await repo.git(['rev-parse', 'HEAD~2'])).trim();
    const secondSha = (await repo.git(['rev-parse', 'HEAD~1'])).trim();
    await repo.git(['tag', 'v1', firstSha]);
    await repo.git(['branch', 'feature/x', secondSha]);

    const page = await getLog(repo.path);
    expect(page.hasMore).toBe(false);
    expect(page.commits).toHaveLength(3);

    const head = page.commits.find((c) => c.sha === headSha)!;
    expect(head.parents).toHaveLength(1);
    expect(head.refs).toEqual(
      expect.arrayContaining([
        { name: 'HEAD', type: 'head' },
        { name: 'main', type: 'branch' },
      ]),
    );
    expect(head.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(head.author).toBe('Test User');
    expect(head.authorEmail).toBe('test@example.com');

    const second = page.commits.find((c) => c.sha === secondSha);
    expect(second?.refs).toEqual(expect.arrayContaining([{ name: 'feature/x', type: 'branch' }]));

    const first = page.commits.find((c) => c.sha === firstSha);
    expect(first?.parents).toEqual([]);
    expect(first?.refs).toEqual(expect.arrayContaining([{ name: 'v1', type: 'tag' }]));
  });

  it('paginates with skip/maxCount and reports hasMore', async () => {
    const repo = await temp({ commits: 4 });
    const firstSha = (await repo.git(['rev-parse', 'HEAD~3'])).trim();

    const page1 = await getLog(repo.path, { maxCount: 2 });
    expect(page1.commits).toHaveLength(2);
    expect(page1.hasMore).toBe(true);

    const page2 = await getLog(repo.path, { maxCount: 2, skip: 2 });
    expect(page2.commits).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
    expect(page2.commits[1]?.sha).toBe(firstSha);

    await expect(getLog(repo.path, { maxCount: 0 })).rejects.toThrow(/maxCount/);
    await expect(getLog(repo.path, { skip: -1 })).rejects.toThrow(/skip/);
  });

  it('supports all:false, path filters and message bodies', async () => {
    const repo = await temp({ files: { 'a.txt': 'a0\n', 'b.txt': 'b0\n' } });
    await writeRepoFile(repo.path, 'a.txt', 'a1\n');
    await commitAll(repo, 'touch a');
    await writeRepoFile(repo.path, 'b.txt', 'b1\n');
    await commitAll(repo, 'touch b');
    await writeRepoFile(repo.path, 'a.txt', 'a2\n');
    await repo.git(['add', '-A']);
    await repo.git(['commit', '-q', '-m', 'touch a again', '-m', 'detailed body']);

    await repo.git(['checkout', '-q', '-b', 'side']);
    await writeRepoFile(repo.path, 'side.txt', 's\n');
    await commitAll(repo, 'side commit');
    await repo.git(['checkout', '-q', 'main']);

    const all = await getLog(repo.path);
    expect(all.commits.some((c) => c.subject === 'side commit')).toBe(true);

    const headOnly = await getLog(repo.path, { all: false });
    expect(headOnly.commits.some((c) => c.subject === 'side commit')).toBe(false);

    const filtered = await getLog(repo.path, { path: 'a.txt' });
    expect(filtered.commits.map((c) => c.subject)).toEqual([
      'touch a again',
      'touch a',
      'initial commit',
    ]);
    expect(filtered.commits[0]?.body).toBe('detailed body');
  });

  it('returns an empty page for a repo without commits', async () => {
    const repo = await temp({ commits: 0, files: {} });
    expect(await getLog(repo.path)).toEqual({ commits: [], hasMore: false });
  });
});

describe('getDiff / getFileDiff', () => {
  it('diffs unstaged, staged and arbitrary revisions', async () => {
    const repo = await temp({ files: { 'a.txt': 'line1\n' } });
    const firstSha = (await repo.git(['rev-parse', 'HEAD'])).trim();

    await writeRepoFile(repo.path, 'a.txt', 'line1\nline2\n');
    const unstaged = await getDiff(repo.path, { path: 'a.txt' });
    expect(unstaged.path).toBe('a.txt');
    expect(unstaged.binary).toBe(false);
    expect(unstaged.truncated).toBe(false);
    expect(unstaged.hunks).toContain('@@');
    expect(unstaged.hunks).toContain('+line2');

    expect((await getDiff(repo.path, { path: 'a.txt', staged: true })).hunks).toBe('');

    await repo.git(['add', 'a.txt']);
    const staged = await getDiff(repo.path, { path: 'a.txt', staged: true });
    expect(staged.hunks).toContain('+line2');
    expect((await getDiff(repo.path, { path: 'a.txt' })).hunks).toBe('');

    await repo.git(['commit', '-q', '-m', 'change a']);
    const betweenRefs = await getDiff(repo.path, { ref: firstSha, ref2: 'HEAD', path: 'a.txt' });
    expect(betweenRefs.hunks).toContain('+line2');

    await writeRepoFile(repo.path, 'a.txt', 'line1\nline2\nline3\n');
    const againstHead = await getDiff(repo.path, { ref: 'HEAD', path: 'a.txt' });
    expect(againstHead.hunks).toContain('+line3');
  });

  it('flags binary diffs and truncates oversized patches', async () => {
    const repo = await temp({ files: { 'a.txt': 'line1\n' } });
    await writeRepoFile(repo.path, 'a.txt', 'line1\nline2\nline3\n');
    const truncated = await getDiff(repo.path, { path: 'a.txt', maxBytes: 10 });
    expect(truncated.truncated).toBe(true);
    expect(Buffer.byteLength(truncated.hunks, 'utf8')).toBeLessThanOrEqual(10);

    await fs.writeFile(path.join(repo.path, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0]));
    await repo.git(['add', 'bin.dat']);
    const binary = await getDiff(repo.path, { path: 'bin.dat', staged: true });
    expect(binary.binary).toBe(true);
  });

  it('follows renames in a single-file diff', async () => {
    const repo = await temp({ files: { 'old.txt': 'same content\n' } });
    await repo.git(['mv', 'old.txt', 'new.txt']);
    const renamed = await getFileDiff(repo.path, { path: 'new.txt', staged: true });
    expect(renamed.path).toBe('new.txt');
    expect(renamed.oldPath).toBe('old.txt');

    const repo2 = await temp({ files: { 'a.txt': 'one\n' } });
    await writeRepoFile(repo2.path, 'a.txt', 'two\n');
    const modified = await getFileDiff(repo2.path, { path: 'a.txt' });
    expect(modified.oldPath).toBeUndefined();
    expect(modified.hunks).toContain('+two');
  });

  it('rejects unsafe paths and invalid option combinations', async () => {
    const repo = await temp();
    await expect(getDiff(repo.path, { path: '-R' })).rejects.toThrow(/unsafe path/);
    await expect(getDiff(repo.path, { staged: true, ref: 'HEAD' })).rejects.toThrow(/staged/);
    await expect(getDiff(repo.path, { ref2: 'HEAD' })).rejects.toThrow(/ref2/);
    await expect(getDiff(repo.path, { context: -1 })).rejects.toThrow(/context/);
  });
});
