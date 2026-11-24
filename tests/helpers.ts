/**
 * Test helpers. Every repo lives under os.tmpdir() and is created here —
 * tests never touch a real user repository.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git as runGit } from '../src/core/git.js';

export interface GitExecOptions {
  allowFail?: boolean;
}

/** Run git through the core execFile runner, for test setup. */
export async function gitExec(
  cwd: string,
  args: string[],
  opts: GitExecOptions = {},
): Promise<string> {
  const res = await runGit(args, {
    cwd,
    timeoutMs: 60_000,
    maxBuffer: 32 * 1024 * 1024,
    allowFail: true,
  });
  if (res.code !== 0 && !opts.allowFail) {
    throw new Error(
      `git ${args.join(' ')} failed: ${String(res.stderr || res.stdout).trim()}`,
    );
  }
  return res.stdout;
}

export interface TempRepoOptions {
  /** Files created before the first commit (path -> content). */
  files?: Record<string, string>;
  /** Number of commits; 0 creates an unborn repo. Default 1. */
  commits?: number;
  /** Create a bare repository (for local remotes). */
  bare?: boolean;
}

export interface TempRepo {
  path: string;
  git: (args: string[], opts?: GitExecOptions) => Promise<string>;
  cleanup: () => Promise<void>;
}

export async function makeTempDir(prefix = 'agy-git-test-'): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function writeRepoFile(repo: string, rel: string, content: string): Promise<void> {
  const full = path.join(repo, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

export async function readRepoFile(repo: string, rel: string): Promise<string> {
  return fs.readFile(path.join(repo, rel), 'utf8');
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function commitAll(repo: TempRepo | string, message: string): Promise<string> {
  const cwd = typeof repo === 'string' ? repo : repo.path;
  await gitExec(cwd, ['add', '-A']);
  await gitExec(cwd, ['commit', '-q', '-m', message]);
  return (await gitExec(cwd, ['rev-parse', 'HEAD'])).trim();
}

export async function makeTempRepo(opts: TempRepoOptions = {}): Promise<TempRepo> {
  const dir = await makeTempDir();
  if (opts.bare) {
    await gitExec(dir, ['init', '-q', '--bare', '-b', 'main']);
    return {
      path: dir,
      git: (args, gitOpts) => gitExec(dir, args, gitOpts),
      cleanup: () => fs.rm(dir, { recursive: true, force: true }),
    };
  }

  await gitExec(dir, ['init', '-q', '-b', 'main']);
  await gitExec(dir, ['config', 'user.name', 'Test User']);
  await gitExec(dir, ['config', 'user.email', 'test@example.com']);
  await gitExec(dir, ['config', 'commit.gpgsign', 'false']);
  await gitExec(dir, ['config', 'tag.gpgsign', 'false']);

  const files = opts.files ?? { 'README.md': '# test\n' };
  for (const [rel, content] of Object.entries(files)) {
    await writeRepoFile(dir, rel, content);
  }

  const commits = opts.commits ?? 1;
  if (commits > 0) {
    await gitExec(dir, ['add', '-A']);
    await gitExec(dir, ['commit', '-q', '-m', 'initial commit']);
    for (let i = 1; i < commits; i++) {
      await writeRepoFile(dir, `file-${i}.txt`, `commit ${i}\n`);
      await gitExec(dir, ['add', '-A']);
      await gitExec(dir, ['commit', '-q', '-m', `commit ${i}`]);
    }
  }

  return {
    path: dir,
    git: (args, gitOpts) => gitExec(dir, args, gitOpts),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}
