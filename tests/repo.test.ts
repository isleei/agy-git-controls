import { afterEach, describe, expect, it } from 'vitest';
import { getStatus, parsePorcelainV2 } from '../src/core/repo.js';
import {
  commitAll,
  makeTempRepo,
  pathExists,
  writeRepoFile,
  type TempRepo,
} from './helpers.js';

const repos: TempRepo[] = [];

async function temp(opts?: Parameters<typeof makeTempRepo>[0]): Promise<TempRepo> {
  const repo = await makeTempRepo(opts);
  repos.push(repo);
  return repo;
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
});

describe('parsePorcelainV2', () => {
  it('parses branch headers, staged/unstaged XY, renames, untracked and conflicts', () => {
    const out = [
      '# branch.oid 0123456789abcdef0123456789abcdef01234567',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -3',
      '1 M. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb staged.txt',
      '1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb unstaged.txt',
      '1 MM N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb both.txt',
      '2 R. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R100 renamed.txt\told.txt',
      'u UU N... 100644 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc conflict.txt',
      '? untracked.txt',
    ].join('\n');

    const status = parsePorcelainV2(out, '/repo');

    expect(status.branch).toBe('main');
    expect(status.detachedAt).toBeNull();
    expect(status.upstream).toBe('origin/main');
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(3);
    expect(status.clean).toBe(false);

    expect(status.staged.map((c) => c.path)).toEqual(['staged.txt', 'both.txt', 'renamed.txt']);
    expect(status.unstaged.map((c) => c.path)).toEqual(['unstaged.txt', 'both.txt']);

    const rename = status.staged.find((c) => c.path === 'renamed.txt');
    expect(rename?.origPath).toBe('old.txt');
    expect(rename?.kind).toBe('R');
    expect(rename?.staged).toBe(true);
    expect(rename?.unstaged).toBe(false);

    const both = status.unstaged.find((c) => c.path === 'both.txt');
    expect(both?.staged).toBe(true);
    expect(both?.unstaged).toBe(true);

    expect(status.conflicted).toHaveLength(1);
    expect(status.conflicted[0]).toMatchObject({ path: 'conflict.txt', conflicted: true });
    expect(status.untracked.map((c) => c.path)).toEqual(['untracked.txt']);
  });

  it('handles detached HEAD and unborn HEAD headers', () => {
    const detached = parsePorcelainV2(
      ['# branch.oid deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', '# branch.head (detached)'].join('\n'),
      '/repo',
    );
    expect(detached.branch).toBeNull();
    expect(detached.detachedAt).toBe('deadbeefde');

    const initial = parsePorcelainV2(['# branch.oid (initial)', '# branch.head main'].join('\n'), '/repo');
    expect(initial.branch).toBe('main');
    expect(initial.detachedAt).toBeNull();
    expect(initial.clean).toBe(true);
  });

  it('keeps paths containing spaces intact', () => {
    const status = parsePorcelainV2(
      '1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb dir/my file.txt',
      '/repo',
    );
    expect(status.unstaged[0]?.path).toBe('dir/my file.txt');
  });
});

describe('getStatus integration', () => {
  it('reports staged, unstaged and untracked files', async () => {
    const repo = await temp({ files: { 'a.txt': 'one\n' } });
    await writeRepoFile(repo.path, 'a.txt', 'one\ntwo\n');
    await writeRepoFile(repo.path, 'b.txt', 'new\n');
    await repo.git(['add', 'b.txt']);

    const status = await getStatus(repo.path);
    expect(status.branch).toBe('main');
    expect(status.staged.map((c) => c.path)).toEqual(['b.txt']);
    expect(status.unstaged.map((c) => c.path)).toEqual(['a.txt']);
    expect(status.untracked).toHaveLength(0);

    await writeRepoFile(repo.path, 'c.txt', 'c\n');
    const again = await getStatus(repo.path);
    expect(again.untracked.map((c) => c.path)).toEqual(['c.txt']);
  });

  it('reports detached HEAD with the short sha', async () => {
    const repo = await temp();
    const sha = (await repo.git(['rev-parse', 'HEAD'])).trim();
    await repo.git(['checkout', '-q', '--detach']);

    const status = await getStatus(repo.path);
    expect(status.branch).toBeNull();
    expect(status.detachedAt).toBe(sha.slice(0, 10));
  });

  it('parses staged renames from real porcelain output', async () => {
    const repo = await temp({ files: { 'old.txt': 'content\n' } });
    await repo.git(['mv', 'old.txt', 'new.txt']);

    const status = await getStatus(repo.path);
    const rename = status.staged.find((c) => c.path === 'new.txt');
    expect(rename).toMatchObject({ origPath: 'old.txt', staged: true, kind: 'R' });
    expect(status.unstaged).toHaveLength(0);
  });

  it('works in a fresh repo without commits', async () => {
    const repo = await temp({ commits: 0, files: {} });
    const status = await getStatus(repo.path);
    expect(status.branch).toBe('main');
    expect(status.detachedAt).toBeNull();
    expect(status.clean).toBe(true);
    expect(await pathExists(repo.path)).toBe(true);
  });

  it('detects merge conflict state and operation', async () => {
    const repo = await temp({ files: { 'a.txt': 'base\n' } });
    await repo.git(['checkout', '-q', '-b', 'other']);
    await writeRepoFile(repo.path, 'a.txt', 'other\n');
    await commitAll(repo, 'other change');
    await repo.git(['checkout', '-q', 'main']);
    await writeRepoFile(repo.path, 'a.txt', 'main\n');
    await commitAll(repo, 'main change');
    await repo.git(['merge', 'other'], { allowFail: true });

    const status = await getStatus(repo.path);
    expect(status.operation).toBe('merge');
    expect(status.conflicted.map((c) => c.path)).toEqual(['a.txt']);
    expect(status.clean).toBe(false);

    await repo.git(['merge', '--abort']);
    const aborted = await getStatus(repo.path);
    expect(aborted.operation).toBeNull();
    expect(aborted.clean).toBe(true);
  });
});
