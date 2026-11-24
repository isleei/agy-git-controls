/** Repo discovery and status parsing (porcelain v2 + branch headers). */
import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from './git.js';
import type { FileChange, RepoInfo, RepoStatus } from './types.js';

/** Canonicalize a path (resolve symlinks, normalize). */
export async function canonicalPath(p: string): Promise<string> {
  const resolved = path.resolve(p);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Resolve the working-tree root for a path inside a repo.
 * Returns null when the path is not inside a git work tree.
 */
export async function findRepoRoot(p: string): Promise<string | null> {
  const res = await git(['-C', p, 'rev-parse', '--show-toplevel'], { cwd: p, allowFail: true });
  if (res.code !== 0) return null;
  const top = res.stdout.trim();
  return top ? canonicalPath(top) : null;
}

/** True when `dir` is a linked worktree rather than the main checkout. */
export async function isLinkedWorktree(root: string): Promise<boolean> {
  const res = await git(['rev-parse', '--git-dir'], { cwd: root, allowFail: true });
  if (res.code !== 0) return false;
  return res.stdout.trim().includes(`${path.sep}worktrees${path.sep}`) || res.stdout.trim().includes('/worktrees/');
}

export async function repoInfoFor(root: string, source: RepoInfo['source']): Promise<RepoInfo | null> {
  const repoRoot = await findRepoRoot(root);
  if (!repoRoot) return null;
  return {
    path: repoRoot,
    name: path.basename(repoRoot),
    isWorktree: await isLinkedWorktree(repoRoot),
    source,
  };
}

/** Parse `git status --porcelain=v2 --branch` output. */
export function parsePorcelainV2(out: string, repo: string): RepoStatus {
  const status: RepoStatus = {
    repo,
    branch: null,
    detachedAt: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    clean: true,
    operation: null,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };

  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const v = line.slice('# branch.head '.length).trim();
      if (v === '(detached)') status.detachedAt = '';
      else status.branch = v;
    } else if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      if (status.detachedAt === '') status.detachedAt = oid === '(initial)' ? '(no commits)' : oid.slice(0, 10);
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
    } else if (line[0] === '1' || line[0] === '2') {
      // ordinary (1) or rename/copy (2): `1 <XY> ... <path>` / `2 <XY> ... <path>\t<orig>`
      const parts = line.split('\t');
      const fields = parts[0]!.split(' ');
      const xy = fields[1] ?? '..';
      const filePath = line[0] === '2' ? parts[parts.length - 2]! : parts[parts.length - 1]!;
      const origPath = line[0] === '2' ? parts[parts.length - 1]! : undefined;
      const x = xy[0]!;
      const y = xy[1]!;
      const change: FileChange = {
        path: filePath,
        ...(origPath !== undefined ? { origPath } : {}),
        staged: x !== '.' && x !== '?',
        unstaged: y !== '.',
        kind: x !== '.' ? x : y,
        conflicted: false,
      };
      if (change.staged) status.staged.push(change);
      if (change.unstaged) status.unstaged.push(change);
    } else if (line[0] === 'u') {
      // unmerged: `u <XY> ... <path>`
      const fields = line.split('\t')[0]!.split(' ');
      const filePath = line.split('\t').pop()!;
      const change: FileChange = {
        path: filePath,
        staged: false,
        unstaged: false,
        kind: 'U',
        conflicted: true,
      };
      void fields;
      status.conflicted.push(change);
    } else if (line[0] === '?') {
      status.untracked.push({
        path: line.slice(2),
        staged: false,
        unstaged: false,
        kind: '?',
        conflicted: false,
      });
    }
  }

  status.clean =
    status.staged.length === 0 &&
    status.unstaged.length === 0 &&
    status.untracked.length === 0 &&
    status.conflicted.length === 0;
  return status;
}

/** Detect in-progress operations from .git metadata files. */
export async function detectOperation(root: string): Promise<string | null> {
  const res = await git(['rev-parse', '--git-dir'], { cwd: root, allowFail: true });
  if (res.code !== 0) return null;
  const gitDir = path.resolve(root, res.stdout.trim());
  const checks: Array<[string, string]> = [
    ['MERGE_HEAD', 'merge'],
    ['REBASE_HEAD', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect'],
  ];
  for (const [file, op] of checks) {
    try {
      await fs.access(path.join(gitDir, file));
      return op;
    } catch {
      /* not present */
    }
  }
  // rebase-apply / rebase-merge dirs
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      await fs.access(path.join(gitDir, dir));
      return 'rebase';
    } catch {
      /* not present */
    }
  }
  return null;
}

export async function getStatus(repo: string): Promise<RepoStatus> {
  const res = await git(['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], {
    cwd: repo,
    timeoutMs: 20_000,
  });
  const status = parsePorcelainV2(res.stdout, repo);
  status.operation = await detectOperation(repo);
  return status;
}
