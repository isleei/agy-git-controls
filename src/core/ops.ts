/**
 * Write operations. Every function:
 *   - validates arguments (throws for invalid input),
 *   - runs under the per-repo mutex,
 *   - returns OperationResult for git-level failures instead of throwing.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from './git.js';
import { withRepoLock } from './locks.js';
import { listConflicted } from './query.js';
import {
  assertMessage,
  assertSafeRef,
  assertSafeRemoteUrl,
  assertSafeSha,
  assertValidBranchName,
  assertValidTagName,
  redactUrl,
  sanitizePathspecs,
} from './refs.js';
import { getStatus } from './repo.js';
import type { OperationResult } from './types.js';

const LONG_TIMEOUT = 120_000;
const SHORT_TIMEOUT = 30_000;

interface WriteRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** Attach the current unmerged-path list when git fails. */
  conflicts?: boolean;
}

async function runWrite(
  repo: string,
  args: string[],
  opts: WriteRunOptions = {},
): Promise<OperationResult> {
  const res = await git(args, {
    cwd: repo,
    allowFail: true,
    timeoutMs: opts.timeoutMs ?? SHORT_TIMEOUT,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  const result: OperationResult = { ok: res.code === 0, code: res.code };
  const stdout = res.stdout.trim();
  const stderr = res.stderr.trim();
  if (stdout) result.stdout = stdout;
  if (stderr) result.stderr = stderr;
  if (res.timedOut) result.timedOut = true;
  if (res.signal !== undefined) result.signal = res.signal;
  if (!result.ok && opts.conflicts) {
    const conflicted = await listConflicted(repo).catch(() => []);
    if (conflicted.length > 0) result.conflicted = conflicted;
  }
  return result;
}

async function assertRepo(repo: string): Promise<void> {
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new Error('repo path is required');
  }
  const res = await git(['rev-parse', '--git-dir'], {
    cwd: repo,
    allowFail: true,
    timeoutMs: 10_000,
  });
  if (res.code !== 0) throw new Error(`not a git repository: ${repo}`);
}

/** Serialize + prove the repo still exists before touching it. */
async function repoWrite(
  repo: string,
  fn: () => Promise<OperationResult>,
): Promise<OperationResult> {
  return withRepoLock(repo, async () => {
    await assertRepo(repo);
    return fn();
  });
}

async function hasHead(repo: string): Promise<boolean> {
  const res = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], {
    cwd: repo,
    allowFail: true,
    timeoutMs: 10_000,
  });
  return res.code === 0;
}

/* ------------------------------------------------------------------ */
/* index                                                               */
/* ------------------------------------------------------------------ */

export async function stage(repo: string, paths: string[]): Promise<OperationResult> {
  const safe = sanitizePathspecs(paths);
  return repoWrite(repo, () => runWrite(repo, ['add', '-A', '--', ...safe]));
}

export async function unstage(repo: string, paths: string[]): Promise<OperationResult> {
  const safe = sanitizePathspecs(paths);
  return repoWrite(repo, async () => {
    if (await hasHead(repo)) {
      return runWrite(repo, ['restore', '--staged', '--', ...safe]);
    }
    // Unborn HEAD: restore --staged cannot resolve HEAD; drop from the index.
    return runWrite(repo, ['rm', '--cached', '-r', '--', ...safe]);
  });
}

export async function stageAll(repo: string): Promise<OperationResult> {
  return repoWrite(repo, () => runWrite(repo, ['add', '-A', '--', '.']));
}

export async function unstageAll(repo: string): Promise<OperationResult> {
  return repoWrite(repo, async () => {
    if (await hasHead(repo)) {
      return runWrite(repo, ['restore', '--staged', '--', '.']);
    }
    return runWrite(repo, ['rm', '--cached', '-r', '--', '.']);
  });
}

export interface DiscardOptions {
  /** Restore both index and work tree to HEAD. */
  staged?: boolean;
  /** Required to delete untracked paths (never uses `git clean`). */
  deleteUntracked?: boolean;
}

function isUntracked(statusPaths: string[], requested: string): boolean {
  return statusPaths.some((p) => {
    const base = p.endsWith('/') ? p.slice(0, -1) : p;
    return requested === base || requested.startsWith(`${base}/`);
  });
}

/** True when `target` is `root` itself or a descendant of it. */
function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Resolve an untracked path for deletion, refusing anything that leaves the
 * repository through a symlink (B1). Every component is `lstat`ed: a symlink
 * anywhere — including the target itself — aborts instead of following it.
 * Returns null when the target is already gone (deleting it is a no-op).
 */
async function resolveUntrackedTarget(repo: string, rel: string): Promise<string | null> {
  const repoReal = await fs.realpath(repo);
  const abs = path.resolve(repoReal, rel);
  const relPath = path.relative(repoReal, abs);
  if (relPath !== '' && !isWithin(repoReal, abs)) {
    throw new Error(`refusing to delete outside the repository: ${rel}`);
  }
  let current = repoReal;
  for (const segment of relPath.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to delete a path through a symlink: ${rel}`);
    }
  }
  // Defence in depth: the resolved parent must still live under the repo.
  const parentReal = await fs.realpath(path.dirname(abs));
  if (parentReal !== repoReal && !isWithin(repoReal, parentReal)) {
    throw new Error(`refusing to delete outside the repository: ${rel}`);
  }
  return abs;
}

export async function discard(
  repo: string,
  paths: string[],
  opts: DiscardOptions = {},
): Promise<OperationResult> {
  const safe = sanitizePathspecs(paths);
  return repoWrite(repo, async () => {
    const status = await getStatus(repo);
    const untrackedPaths = status.untracked.map((u) => u.path);
    const untracked = safe.filter((p) => isUntracked(untrackedPaths, p));
    if (untracked.length > 0 && opts.deleteUntracked !== true) {
      throw new Error(
        `refusing to delete untracked path(s) without deleteUntracked: ${untracked.join(', ')}`,
      );
    }
    const tracked = safe.filter((p) => !untracked.includes(p));

    let result: OperationResult = { ok: true, code: 0 };
    if (tracked.length > 0) {
      if (opts.staged && !(await hasHead(repo))) {
        // Unborn HEAD: `restore` cannot resolve HEAD; drop the entries from
        // the index instead (the work-tree files stay on disk).
        result = await runWrite(repo, ['rm', '--cached', '-r', '--', ...tracked]);
      } else {
        const args = ['restore'];
        if (opts.staged) args.push('--staged');
        args.push('--worktree', '--', ...tracked);
        result = await runWrite(repo, args);
      }
      if (!result.ok) return result;
    }

    if (untracked.length > 0) {
      try {
        for (const p of untracked) {
          const target = await resolveUntrackedTarget(repo, p);
          if (target === null) continue;
          try {
            await fs.rm(target, { recursive: true, force: false });
          } catch (err) {
            // A concurrent removal between lstat and rm is success, not failure.
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw err;
          }
        }
      } catch (err) {
        return {
          ok: false,
          code: 1,
          stderr: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return result;
  });
}

/* ------------------------------------------------------------------ */
/* commits                                                             */
/* ------------------------------------------------------------------ */

export interface CommitOptions {
  message: string;
  amend?: boolean;
  signoff?: boolean;
}

export async function commit(repo: string, opts: CommitOptions): Promise<OperationResult> {
  assertMessage(opts.message);
  return repoWrite(repo, () => {
    const args = ['commit', '-m', opts.message];
    if (opts.amend) args.push('--amend');
    if (opts.signoff) args.push('--signoff');
    return runWrite(repo, args, { conflicts: true });
  });
}

/* ------------------------------------------------------------------ */
/* branches                                                            */
/* ------------------------------------------------------------------ */

export interface CreateBranchOptions {
  name: string;
  startPoint?: string;
  checkout?: boolean;
}

export async function createBranch(
  repo: string,
  opts: CreateBranchOptions,
): Promise<OperationResult> {
  return repoWrite(repo, async () => {
    await assertValidBranchName(opts.name);
    if (opts.startPoint !== undefined) assertSafeRef(opts.startPoint, 'start point');
    const args = opts.checkout ? ['checkout', '-b', opts.name] : ['branch', opts.name];
    if (opts.startPoint !== undefined) args.push('--end-of-options', opts.startPoint);
    return runWrite(repo, args);
  });
}

export async function checkoutBranch(repo: string, name: string): Promise<OperationResult> {
  return repoWrite(repo, async () => {
    await assertValidBranchName(name);
    return runWrite(repo, ['checkout', name]);
  });
}

export async function renameBranch(
  repo: string,
  oldName: string,
  newName: string,
): Promise<OperationResult> {
  return repoWrite(repo, async () => {
    await assertValidBranchName(oldName);
    await assertValidBranchName(newName);
    return runWrite(repo, ['branch', '-m', oldName, newName]);
  });
}

export interface DeleteBranchOptions {
  /** -D instead of -d (git still refuses the current branch). */
  force?: boolean;
}

export async function deleteBranch(
  repo: string,
  name: string,
  opts: DeleteBranchOptions = {},
): Promise<OperationResult> {
  return repoWrite(repo, async () => {
    await assertValidBranchName(name);
    return runWrite(repo, ['branch', opts.force ? '-D' : '-d', name]);
  });
}

export interface TrackRemoteOptions {
  /** Local branch name; defaults to the remote branch without its remote prefix. */
  localName?: string;
}

/** Create a local branch tracking `remoteBranch` (e.g. `origin/feature`) and check it out. */
export async function trackRemote(
  repo: string,
  remoteBranch: string,
  opts: TrackRemoteOptions = {},
): Promise<OperationResult> {
  return repoWrite(repo, async () => {
    assertSafeRef(remoteBranch, 'remote branch');
    const slash = remoteBranch.indexOf('/');
    if (slash <= 0 || slash === remoteBranch.length - 1) {
      throw new Error(`invalid remote branch (expected <remote>/<branch>): ${remoteBranch}`);
    }
    const local = opts.localName ?? remoteBranch.slice(slash + 1);
    await assertValidBranchName(local);
    return runWrite(repo, ['checkout', '--track', '-b', local, '--end-of-options', remoteBranch]);
  });
}

export async function setUpstream(
  repo: string,
  branch: string,
  upstream: string | null,
): Promise<OperationResult> {
  return repoWrite(repo, async () => {
    await assertValidBranchName(branch);
    if (upstream === null) {
      return runWrite(repo, ['branch', '--unset-upstream', '--end-of-options', branch]);
    }
    assertSafeRef(upstream, 'upstream');
    return runWrite(repo, [
      'branch',
      `--set-upstream-to=${upstream}`,
      '--end-of-options',
      branch,
    ]);
  });
}

/* ------------------------------------------------------------------ */
/* sync                                                                */
/* ------------------------------------------------------------------ */

export interface FetchOptions {
  remote?: string;
  /** Prune deleted remote-tracking refs (default true). */
  prune?: boolean;
  all?: boolean;
  signal?: AbortSignal;
}

export async function fetch(repo: string, opts: FetchOptions = {}): Promise<OperationResult> {
  return repoWrite(repo, () => {
    if (opts.all && opts.remote !== undefined) {
      throw new Error('remote cannot be combined with all');
    }
    const args = ['fetch'];
    if (opts.prune !== false) args.push('--prune');
    if (opts.all) {
      args.push('--all');
    } else if (opts.remote !== undefined) {
      assertSafeRef(opts.remote, 'remote');
      args.push(opts.remote);
    }
    return runWrite(repo, args, {
      timeoutMs: LONG_TIMEOUT,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  });
}

export type PullMode = 'ff' | 'merge' | 'rebase';

export interface PullOptions {
  /** ff = --ff-only (default), merge = --no-rebase, rebase = --rebase. */
  mode?: PullMode;
  remote?: string;
  branch?: string;
  signal?: AbortSignal;
}

export async function pull(repo: string, opts: PullOptions = {}): Promise<OperationResult> {
  return repoWrite(repo, () => {
    const mode = opts.mode ?? 'ff';
    if (mode !== 'ff' && mode !== 'merge' && mode !== 'rebase') {
      throw new Error(`invalid pull mode: ${String(mode)}`);
    }
    if (opts.branch !== undefined && opts.remote === undefined) {
      throw new Error('pull branch requires a remote');
    }
    const args = ['pull'];
    if (mode === 'ff') args.push('--ff-only');
    else if (mode === 'merge') args.push('--no-rebase');
    else args.push('--rebase');
    if (opts.remote !== undefined) {
      assertSafeRef(opts.remote, 'remote');
      args.push(opts.remote);
      if (opts.branch !== undefined) {
        assertSafeRef(opts.branch, 'branch');
        args.push(opts.branch);
      }
    }
    return runWrite(repo, args, {
      timeoutMs: LONG_TIMEOUT,
      env: { GIT_EDITOR: 'true' },
      conflicts: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  });
}

export interface PushOptions {
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
  /** Only --force-with-lease is supported; bare --force is never emitted. */
  forceWithLease?: boolean;
  tags?: boolean;
  signal?: AbortSignal;
}

export async function push(repo: string, opts: PushOptions = {}): Promise<OperationResult> {
  return repoWrite(repo, () => {
    if (opts.branch !== undefined && opts.remote === undefined) {
      // `git push origin` would treat the branch as the remote name.
      throw new Error('push branch requires a remote');
    }
    const args = ['push'];
    if (opts.setUpstream) args.push('--set-upstream');
    if (opts.forceWithLease) args.push('--force-with-lease');
    if (opts.tags) args.push('--tags');
    if (opts.remote !== undefined) {
      assertSafeRef(opts.remote, 'remote');
      args.push(opts.remote);
    }
    if (opts.branch !== undefined) {
      assertSafeRef(opts.branch, 'branch');
      args.push(opts.branch);
    }
    return runWrite(repo, args, {
      timeoutMs: LONG_TIMEOUT,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  });
}

/* ------------------------------------------------------------------ */
/* merge / rebase / cherry-pick / revert                               */
/* ------------------------------------------------------------------ */

export interface MergeOptions {
  noFf?: boolean;
  squash?: boolean;
  abort?: boolean;
}

export async function merge(
  repo: string,
  branch: string,
  opts: MergeOptions = {},
): Promise<OperationResult> {
  return repoWrite(repo, () => {
    if (opts.abort) return runWrite(repo, ['merge', '--abort'], { conflicts: true });
    assertSafeRef(branch, 'branch');
    const args = ['merge'];
    if (opts.noFf) args.push('--no-ff');
    if (opts.squash) args.push('--squash');
    args.push('--end-of-options', branch);
    return runWrite(repo, args, {
      env: { GIT_EDITOR: 'true' },
      conflicts: true,
    });
  });
}

export interface RebaseOptions {
  abort?: boolean;
  continue?: boolean;
  skip?: boolean;
}

export async function rebase(
  repo: string,
  onto: string,
  opts: RebaseOptions = {},
): Promise<OperationResult> {
  return repoWrite(repo, () => {
    const actions = [opts.abort, opts.continue, opts.skip].filter(Boolean).length;
    if (actions > 1) throw new Error('choose only one of abort/continue/skip');
    if (opts.abort) return runWrite(repo, ['rebase', '--abort'], { conflicts: true });
    if (opts.continue) {
      return runWrite(repo, ['rebase', '--continue'], {
        env: { GIT_EDITOR: 'true' },
        conflicts: true,
      });
    }
    if (opts.skip) return runWrite(repo, ['rebase', '--skip'], { conflicts: true });
    assertSafeRef(onto, 'revision');
    return runWrite(repo, ['rebase', '--end-of-options', onto], {
      env: { GIT_EDITOR: 'true' },
      conflicts: true,
    });
  });
}

export interface CherryPickOptions {
  abort?: boolean;
  continue?: boolean;
}

export async function cherryPick(
  repo: string,
  shas: string[],
  opts: CherryPickOptions = {},
): Promise<OperationResult> {
  return repoWrite(repo, () => {
    if (opts.abort && opts.continue) throw new Error('choose only one of abort/continue');
    if (opts.abort) return runWrite(repo, ['cherry-pick', '--abort'], { conflicts: true });
    if (opts.continue) {
      return runWrite(repo, ['cherry-pick', '--continue'], {
        env: { GIT_EDITOR: 'true' },
        conflicts: true,
      });
    }
    if (!Array.isArray(shas) || shas.length === 0) {
      throw new Error('at least one commit is required');
    }
    for (const sha of shas) assertSafeSha(sha);
    return runWrite(repo, ['cherry-pick', '--end-of-options', ...shas], { conflicts: true });
  });
}

export interface RevertOptions {
  noCommit?: boolean;
}

export async function revert(
  repo: string,
  shas: string[],
  opts: RevertOptions = {},
): Promise<OperationResult> {
  return repoWrite(repo, () => {
    if (!Array.isArray(shas) || shas.length === 0) {
      throw new Error('at least one commit is required');
    }
    for (const sha of shas) assertSafeSha(sha);
    const args = ['revert', '--no-edit'];
    if (opts.noCommit) args.push('--no-commit');
    args.push('--end-of-options', ...shas);
    return runWrite(repo, args, { conflicts: true });
  });
}

/* ------------------------------------------------------------------ */
/* stash                                                               */
/* ------------------------------------------------------------------ */

export type StashOptions =
  | {
      action: 'push';
      message?: string;
      includeUntracked?: boolean;
      paths?: string[];
    }
  | { action: 'apply' | 'pop' | 'drop'; index?: number }
  | { action: 'show'; index?: number };

function stashIndex(index: number | undefined): number {
  const value = index ?? 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid stash index: ${String(index)}`);
  }
  return value;
}

export async function stash(repo: string, opts: StashOptions): Promise<OperationResult> {
  return repoWrite(repo, () => {
    switch (opts.action) {
      case 'push': {
        const args = ['stash', 'push'];
        if (opts.message !== undefined) {
          assertMessage(opts.message);
          args.push('-m', opts.message);
        }
        if (opts.includeUntracked) args.push('-u');
        if (opts.paths !== undefined && opts.paths.length > 0) {
          args.push('--', ...sanitizePathspecs(opts.paths));
        } else if (opts.includeUntracked) {
          // `stash -u` cleans untracked files through an internal magic
          // pathspec, which GIT_LITERAL_PATHSPECS neutralises: without an
          // explicit `.` the files would be stashed but stay on disk.
          args.push('--', '.');
        }
        return runWrite(repo, args);
      }
      case 'apply':
      case 'pop':
        return runWrite(repo, ['stash', opts.action, `stash@{${stashIndex(opts.index)}}`], {
          conflicts: true,
        });
      case 'drop':
        return runWrite(repo, ['stash', 'drop', `stash@{${stashIndex(opts.index)}}`]);
      case 'show':
        return runWrite(repo, ['stash', 'show', '-p', `stash@{${stashIndex(opts.index)}}`]);
      default:
        throw new Error(`unsupported stash action: ${String((opts as { action?: string }).action)}`);
    }
  });
}

/* ------------------------------------------------------------------ */
/* worktrees                                                           */
/* ------------------------------------------------------------------ */

export interface WorktreeAddOptions {
  path: string;
  branch?: string;
  newBranch?: string;
  detached?: boolean;
}

/**
 * Worktrees may only be created/removed under `path.dirname(repo)` and never
 * inside the repository itself (which includes `.git`). The parent chain is
 * realpath'ed so a symlink inside the allowed root cannot redirect the write
 * elsewhere (M2).
 */
async function resolveWorktreePath(repo: string, input: string): Promise<string> {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new Error('worktree path is required');
  }
  const repoReal = await fs.realpath(repo);
  const parent = path.dirname(repoReal);
  const target = path.resolve(repoReal, input);
  const relToParent = path.relative(parent, target);
  if (relToParent === '' || !isWithin(parent, target)) {
    throw new Error(`worktree path must be a directory under ${parent}: ${input}`);
  }
  if (isWithin(repoReal, target)) {
    throw new Error(`worktree path must be outside the repository: ${input}`);
  }
  if (relToParent.split(path.sep).includes('.git')) {
    throw new Error(`worktree path must not point into a .git directory: ${input}`);
  }

  // Resolve the nearest existing ancestor; the rest of the path does not
  // exist yet and is appended to its real form.
  let probe = target;
  const missing: string[] = [];
  for (;;) {
    try {
      const realProbe = await fs.realpath(probe);
      const realTarget =
        missing.length === 0 ? realProbe : path.join(realProbe, ...missing);
      if (realTarget === parent || !isWithin(parent, realTarget)) {
        throw new Error(`worktree path escapes ${parent} through a symlink: ${input}`);
      }
      if (isWithin(repoReal, realTarget)) {
        throw new Error(`worktree path resolves inside the repository: ${input}`);
      }
      return realTarget;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const up = path.dirname(probe);
      if (up === probe) {
        throw new Error(`cannot resolve worktree path: ${input}`);
      }
      missing.unshift(path.basename(probe));
      probe = up;
    }
  }
}

export async function worktreeAdd(
  repo: string,
  opts: WorktreeAddOptions,
): Promise<OperationResult> {
  return repoWrite(repo, async () => {
    if (typeof opts.path !== 'string' || opts.path.length === 0 || opts.path.includes('\0')) {
      throw new Error('worktree path is required');
    }
    if (opts.detached && opts.newBranch !== undefined) {
      throw new Error('detached worktree cannot create a new branch');
    }
    if (opts.newBranch !== undefined) await assertValidBranchName(opts.newBranch);
    if (opts.branch !== undefined) assertSafeRef(opts.branch, 'branch');

    const target = await resolveWorktreePath(repo, opts.path);
    const args = ['worktree', 'add'];
    if (opts.detached) args.push('--detach');
    if (opts.newBranch !== undefined) args.push('-b', opts.newBranch);
    args.push(target);
    if (opts.branch !== undefined) args.push(opts.branch);
    return runWrite(repo, args);
  });
}

export interface WorktreeRemoveOptions {
  path: string;
  force?: boolean;
}

export async function worktreeRemove(
  repo: string,
  opts: WorktreeRemoveOptions,
): Promise<OperationResult> {
  return repoWrite(repo, async () => {
    const target = await resolveWorktreePath(repo, opts.path);
    const args = ['worktree', 'remove'];
    if (opts.force) args.push('--force');
    args.push(target);
    return runWrite(repo, args);
  });
}

/* ------------------------------------------------------------------ */
/* tags                                                                */
/* ------------------------------------------------------------------ */

export interface CreateTagOptions {
  name: string;
  message?: string;
  ref?: string;
  annotated?: boolean;
}

export async function createTag(repo: string, opts: CreateTagOptions): Promise<OperationResult> {
  return repoWrite(repo, async () => {
    await assertValidTagName(opts.name);
    if (opts.message !== undefined) assertMessage(opts.message);
    if (opts.ref !== undefined) assertSafeRef(opts.ref, 'revision');
    const annotated = opts.annotated === true || opts.message !== undefined;
    if (annotated && opts.message === undefined) {
      throw new Error('annotated tag requires a message');
    }
    const args = ['tag'];
    if (annotated) args.push('-a');
    if (opts.message !== undefined) args.push('-m', opts.message);
    args.push(opts.name);
    if (opts.ref !== undefined) args.push('--end-of-options', opts.ref);
    return runWrite(repo, args);
  });
}

export async function deleteTag(repo: string, name: string): Promise<OperationResult> {
  return repoWrite(repo, async () => {
    await assertValidTagName(name);
    return runWrite(repo, ['tag', '-d', name]);
  });
}

export interface PushTagOptions {
  remote?: string;
  signal?: AbortSignal;
}

export async function pushTag(
  repo: string,
  name: string,
  opts: PushTagOptions = {},
): Promise<OperationResult> {
  return repoWrite(repo, async () => {
    await assertValidTagName(name);
    const args = ['push'];
    if (opts.remote !== undefined) {
      assertSafeRef(opts.remote, 'remote');
      args.push(opts.remote);
    }
    args.push('tag', name);
    return runWrite(repo, args, {
      timeoutMs: LONG_TIMEOUT,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  });
}

/* ------------------------------------------------------------------ */
/* remotes                                                             */
/* ------------------------------------------------------------------ */

/** Remote commands echo their URL argument; never return credentials. */
function redactResult(result: OperationResult): OperationResult {
  if (result.stdout) result.stdout = redactUrl(result.stdout);
  if (result.stderr) result.stderr = redactUrl(result.stderr);
  return result;
}

export interface RemoteAddOptions {
  name: string;
  url: string;
}

export async function remoteAdd(repo: string, opts: RemoteAddOptions): Promise<OperationResult> {
  return repoWrite(repo, async () => {
    assertSafeRef(opts.name, 'remote');
    assertSafeRemoteUrl(opts.url);
    return redactResult(await runWrite(repo, ['remote', 'add', opts.name, opts.url]));
  });
}

export async function remoteRemove(repo: string, name: string): Promise<OperationResult> {
  return repoWrite(repo, () => {
    assertSafeRef(name, 'remote');
    return runWrite(repo, ['remote', 'remove', name]);
  });
}

export interface SetRemoteUrlOptions {
  /** Update the push URL instead of the fetch URL. */
  push?: boolean;
}

export async function setRemoteUrl(
  repo: string,
  name: string,
  url: string,
  opts: SetRemoteUrlOptions = {},
): Promise<OperationResult> {
  return repoWrite(repo, async () => {
    assertSafeRef(name, 'remote');
    assertSafeRemoteUrl(url);
    const args = ['remote', 'set-url'];
    if (opts.push) args.push('--push');
    args.push(name, url);
    return redactResult(await runWrite(repo, args));
  });
}
