/**
 * Read-only git queries used by the REST layer and the MCP server.
 * None of these take the repo write lock.
 */
import { GitError, git } from './git.js';
import { assertSafeRef, redactUrl, sanitizePathspec } from './refs.js';
import type {
  BranchInfo,
  CommitInfo,
  CommitRef,
  CommitRefType,
  DiffResult,
  LogPage,
  RemoteInfo,
  StashEntry,
  TagInfo,
  WorktreeInfo,
} from './types.js';

const MAX_DIFF_BYTES = 512 * 1024;
const DIFF_MAX_BUFFER = 64 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* branches                                                            */
/* ------------------------------------------------------------------ */

const BRANCH_FORMAT = [
  '%(refname)',
  '%(refname:short)',
  '%(HEAD)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(committerdate:iso-strict)',
  '%(objectname)',
  '%(symref)',
].join('%00');

function trackedCount(track: string, label: 'ahead' | 'behind'): number {
  const m = new RegExp(`${label} (\\d+)`).exec(track);
  return m ? Number(m[1]) : 0;
}

export async function listBranches(repo: string): Promise<BranchInfo[]> {
  const res = await git(
    ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'],
    { cwd: repo, timeoutMs: 20_000 },
  );
  const branches: BranchInfo[] = [];
  for (const line of res.stdout.split('\n')) {
    if (!line) continue;
    const [ref = '', name = '', head = '', upstream = '', track = '', date = '', sha = '', symref = ''] =
      line.split('\x00');
    // refs/remotes/<remote>/HEAD is a symbolic alias, not a branch.
    if (symref || name.includes(' -> ')) continue;
    branches.push({
      name,
      ref,
      remote: ref.startsWith('refs/remotes/'),
      current: head === '*',
      upstream: upstream || null,
      ahead: trackedCount(track, 'ahead'),
      behind: trackedCount(track, 'behind'),
      lastCommitAt: date,
      lastCommitSha: sha,
    });
  }

  // Unborn HEAD (fresh repo): surface the branch git would create on commit.
  if (!branches.some((b) => b.current)) {
    const sym = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: repo,
      allowFail: true,
      timeoutMs: 10_000,
    });
    const name = sym.stdout.trim();
    if (sym.code === 0 && name) {
      branches.unshift({
        name,
        ref: `refs/heads/${name}`,
        remote: false,
        current: true,
        upstream: null,
        ahead: 0,
        behind: 0,
        lastCommitAt: '',
        lastCommitSha: '',
      });
    }
  }
  return branches;
}

/* ------------------------------------------------------------------ */
/* worktrees                                                           */
/* ------------------------------------------------------------------ */

export async function listWorktrees(repo: string): Promise<WorktreeInfo[]> {
  const res = await git(['worktree', 'list', '--porcelain'], { cwd: repo, timeoutMs: 20_000 });
  const out: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;
  const flush = (): void => {
    if (current) {
      out.push(current);
      current = null;
    }
  };

  for (const raw of res.stdout.split('\n')) {
    const line = raw.trimEnd();
    if (!line) {
      flush();
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      flush();
      current = {
        path: value,
        branch: null,
        head: '',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    switch (key) {
      case 'HEAD':
        current.head = value;
        break;
      case 'branch':
        current.branch = value.replace(/^refs\/heads\//, '');
        break;
      case 'detached':
        current.detached = true;
        break;
      case 'bare':
        current.bare = true;
        break;
      case 'locked':
        current.locked = true;
        break;
      case 'prunable':
        current.prunable = true;
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ */
/* remotes                                                             */
/* ------------------------------------------------------------------ */

export async function listRemotes(repo: string): Promise<RemoteInfo[]> {
  const res = await git(['remote'], { cwd: repo, timeoutMs: 20_000 });
  const names = res.stdout
    .split('\n')
    .map((n) => n.trim())
    .filter(Boolean);
  return Promise.all(
    names.map(async (name) => {
      const fetchRes = await git(['remote', 'get-url', name], {
        cwd: repo,
        allowFail: true,
        timeoutMs: 10_000,
      });
      const pushRes = await git(['remote', 'get-url', '--push', name], {
        cwd: repo,
        allowFail: true,
        timeoutMs: 10_000,
      });
      const fetchUrl = fetchRes.code === 0 ? redactUrl(fetchRes.stdout.trim()) : '';
      const pushUrl = pushRes.code === 0 ? redactUrl(pushRes.stdout.trim()) : fetchUrl;
      return { name, fetchUrl, pushUrl };
    }),
  );
}

/* ------------------------------------------------------------------ */
/* tags                                                                */
/* ------------------------------------------------------------------ */

const TAG_FORMAT = [
  '%(refname:short)',
  '%(objecttype)',
  '%(objectname)',
  '%(*objectname)',
  '%(creatordate:iso-strict)',
  '%(subject)',
].join('%00');

export async function listTags(repo: string): Promise<TagInfo[]> {
  const res = await git(
    ['for-each-ref', '--sort=-creatordate', `--format=${TAG_FORMAT}`, 'refs/tags'],
    { cwd: repo, timeoutMs: 20_000 },
  );
  const tags: TagInfo[] = [];
  for (const line of res.stdout.split('\n')) {
    if (!line) continue;
    const [name = '', type = '', objectSha = '', peeledSha = '', date = '', subject = ''] =
      line.split('\x00');
    const annotated = type === 'tag';
    const tag: TagInfo = {
      name,
      annotated,
      sha: annotated ? peeledSha || objectSha : objectSha,
    };
    if (date) tag.date = date;
    if (annotated && subject) tag.message = subject;
    tags.push(tag);
  }
  return tags;
}

/* ------------------------------------------------------------------ */
/* stashes                                                             */
/* ------------------------------------------------------------------ */

/**
 * Parse `git stash list --format=%gs%x00%ct` (one record per line).
 * NUL-separated so a subject containing a tab cannot shift the date, and a
 * subject containing the separator itself is still impossible for git to
 * write (reflog messages are whitespace-sanitised).
 * Exported for tests, which need a tab-bearing subject git cannot create.
 */
export function parseStashList(out: string): StashEntry[] {
  const entries: StashEntry[] = [];
  out
    .split('\n')
    .filter(Boolean)
    .forEach((line, index) => {
      const nul = line.indexOf('\x00');
      const subject = nul === -1 ? line : line.slice(0, nul);
      const epoch = nul === -1 ? '' : line.slice(nul + 1);
      const m = /^(?:WIP on|On) ([^:]+):\s?(.*)$/.exec(subject);
      const seconds = Number(epoch);
      const entry: StashEntry = {
        index,
        name: `stash@{${index}}`,
        message: m ? m[2]! : subject,
        date: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : '',
      };
      if (m) entry.branch = m[1]!;
      entries.push(entry);
    });
  return entries;
}

export async function listStashes(repo: string): Promise<StashEntry[]> {
  const res = await git(['stash', 'list', '--format=%gs%x00%ct'], {
    cwd: repo,
    timeoutMs: 20_000,
  });
  return parseStashList(res.stdout);
}

/* ------------------------------------------------------------------ */
/* log                                                                 */
/* ------------------------------------------------------------------ */

export interface LogOptions {
  /** Page size, default 200. */
  maxCount?: number;
  skip?: number;
  /** Include every ref (default true); false limits to HEAD. */
  all?: boolean;
  /** Restrict history to a repository-relative path. */
  path?: string;
  /** Start from this revision instead of HEAD (implies that revision only). */
  ref?: string;
  /** Case-sensitive regex matched against commit messages (`--grep`). */
  query?: string;
}

const LOG_FORMAT =
  '%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%D%x00%s%x00%b%x1e';

function shortRefName(ref: string, type: CommitRefType): string {
  switch (type) {
    case 'branch':
      return ref.replace(/^refs\/heads\//, '');
    case 'tag':
      return ref.replace(/^refs\/tags\//, '');
    case 'remote':
      return ref.replace(/^refs\/remotes\//, '');
    default:
      return ref;
  }
}

/** Parse `%D` decoration (`--decorate=full` gives fully qualified refs). */
export function parseCommitRefs(decoration: string): CommitRef[] {
  const refs: CommitRef[] = [];
  for (const raw of decoration.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    if (part === 'HEAD') {
      refs.push({ name: 'HEAD', type: 'head' });
      continue;
    }
    if (part.startsWith('HEAD -> ')) {
      const target = part.slice('HEAD -> '.length).trim();
      refs.push({ name: 'HEAD', type: 'head' });
      refs.push({ name: shortRefName(target, 'branch'), type: 'branch' });
      continue;
    }
    if (part.includes(' -> ')) {
      // e.g. `refs/remotes/origin/HEAD -> refs/remotes/origin/main`: a symref
      // alias, never a branch called `origin/HEAD -> ...`.
      continue;
    }
    if (part.startsWith('tag: ')) {
      const target = part.slice('tag: '.length).trim();
      refs.push({ name: shortRefName(target, 'tag'), type: 'tag' });
      continue;
    }
    if (part.startsWith('refs/heads/')) {
      refs.push({ name: shortRefName(part, 'branch'), type: 'branch' });
      continue;
    }
    if (part.startsWith('refs/remotes/')) {
      refs.push({ name: shortRefName(part, 'remote'), type: 'remote' });
      continue;
    }
    if (part.startsWith('refs/tags/')) {
      refs.push({ name: shortRefName(part, 'tag'), type: 'tag' });
      continue;
    }
    if (part === 'refs/stash' || part === 'stash') {
      refs.push({ name: 'stash', type: 'stash' });
      continue;
    }
    // Unexpected/legacy short decoration: treat as a local branch.
    refs.push({ name: part, type: 'branch' });
  }
  return refs;
}

export async function getLog(repo: string, opts: LogOptions = {}): Promise<LogPage> {
  const maxCount = opts.maxCount ?? 200;
  const skip = opts.skip ?? 0;
  if (!Number.isInteger(maxCount) || maxCount <= 0) {
    throw new Error(`invalid maxCount: ${maxCount}`);
  }
  if (!Number.isInteger(skip) || skip < 0) {
    throw new Error(`invalid skip: ${skip}`);
  }

  const args = [
    'log',
    '--no-color',
    '--no-show-signature',
    '--decorate=full',
    `--max-count=${maxCount + 1}`,
    `--skip=${skip}`,
    `--format=${LOG_FORMAT}`,
  ];
  if (opts.all !== false && opts.ref === undefined) args.push('--all');
  if (opts.query !== undefined) {
    if (opts.query.length === 0 || opts.query.includes('\0')) {
      throw new Error('invalid log query');
    }
    args.push(`--grep=${opts.query}`);
  }
  if (opts.ref !== undefined) {
    assertSafeRef(opts.ref, 'revision');
    args.push('--end-of-options', opts.ref);
  }
  if (opts.path !== undefined) args.push('--', sanitizePathspec(opts.path));

  const res = await git(args, {
    cwd: repo,
    timeoutMs: 30_000,
    allowFail: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.code !== 0) {
    // Fresh repo: HEAD exists logically but has no commits yet.
    if (/does not have any commits yet|bad revision|unknown revision|ambiguous argument/i.test(res.stderr)) {
      return { commits: [], hasMore: false };
    }
    throw new GitError(args, res);
  }

  const commits: CommitInfo[] = [];
  for (const chunk of res.stdout.split('\x1e')) {
    const record = chunk.startsWith('\n') ? chunk.slice(1) : chunk;
    if (!record.trim()) continue;
    const fields = record.split('\x00');
    if (fields.length < 8) continue;
    const [sha = '', shortSha = '', parentList = '', author = '', authorEmail = '', date = '', decoration = '', subject = '', bodyRaw = ''] =
      fields;
    const commit: CommitInfo = {
      sha,
      shortSha,
      parents: parentList ? parentList.split(' ').filter(Boolean) : [],
      author,
      authorEmail,
      date,
      subject,
      refs: parseCommitRefs(decoration),
    };
    const body = bodyRaw.replace(/\s+$/, '');
    if (body) commit.body = body;
    commits.push(commit);
  }

  const hasMore = commits.length > maxCount;
  return {
    commits: hasMore ? commits.slice(0, maxCount) : commits,
    hasMore,
  };
}

/* ------------------------------------------------------------------ */
/* diff                                                                */
/* ------------------------------------------------------------------ */

export interface DiffOptions {
  /** Restrict to a repository-relative path. */
  path?: string;
  /** Compare the index against HEAD instead of the work tree against the index. */
  staged?: boolean;
  /** Single revision: compare it against the work tree. */
  ref?: string;
  /** Second revision: compare ref..ref2. */
  ref2?: string;
  /** Unified context lines, default 3. */
  context?: number;
  /** Byte cap for the patch text, default 512 KiB. */
  maxBytes?: number;
}

export interface FileDiffOptions extends Omit<DiffOptions, 'path'> {
  path: string;
}

/** Truncate to a byte cap without splitting a UTF-8 code point. */
export function byteSlice(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= maxBytes) return { text, truncated: false };
  const buf = Buffer.from(text, 'utf8');
  // Never cut inside a UTF-8 sequence: back up over continuation bytes
  // (10xxxxxx) until the cut lands on a code-point boundary.
  let end = Math.min(maxBytes, buf.length);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return {
    text: `${buf.subarray(0, end).toString('utf8')}\n… [truncated]`,
    truncated: true,
  };
}

function assertDiffOptions(opts: DiffOptions): { context: number; maxBytes: number } {
  const context = opts.context ?? 3;
  if (!Number.isInteger(context) || context < 0 || context > 10_000) {
    throw new Error(`invalid diff context: ${context}`);
  }
  const maxBytes = opts.maxBytes ?? MAX_DIFF_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`invalid maxBytes: ${maxBytes}`);
  }
  if (opts.staged && (opts.ref !== undefined || opts.ref2 !== undefined)) {
    throw new Error('staged diffs cannot be combined with ref/ref2');
  }
  if (opts.ref2 !== undefined && opts.ref === undefined) {
    throw new Error('ref2 requires ref');
  }
  return { context, maxBytes };
}

/** Append `--cached` / revisions to a diff argument list. */
function appendDiffTarget(args: string[], opts: DiffOptions): void {
  if (opts.staged) {
    args.push('--cached');
  } else if (opts.ref !== undefined) {
    assertSafeRef(opts.ref, 'revision');
    args.push('--end-of-options', opts.ref);
    if (opts.ref2 !== undefined) {
      assertSafeRef(opts.ref2, 'revision');
      args.push(opts.ref2);
    }
  }
}

async function runDiff(
  repo: string,
  opts: DiffOptions,
  paths: string[],
  maxBytes: number,
): Promise<DiffResult> {
  const { context } = assertDiffOptions(opts);
  const args = [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
    `--unified=${context}`,
  ];
  appendDiffTarget(args, opts);
  if (paths.length > 0) args.push('--', ...paths);

  const res = await git(args, {
    cwd: repo,
    timeoutMs: 30_000,
    maxBuffer: DIFF_MAX_BUFFER,
  });
  const binary = /^Binary files .+ differ$/m.test(res.stdout) || res.stdout.includes('GIT binary patch');
  const sliced = byteSlice(res.stdout, maxBytes);
  return {
    path: '',
    hunks: sliced.text,
    binary,
    truncated: sliced.truncated,
  };
}

export async function getDiff(repo: string, opts: DiffOptions = {}): Promise<DiffResult> {
  const { maxBytes } = assertDiffOptions(opts);
  const paths = opts.path !== undefined ? [sanitizePathspec(opts.path)] : [];
  const result = await runDiff(repo, opts, paths, maxBytes);
  result.path = opts.path ?? '';
  return result;
}

/** Multi-path diff in one git invocation (`path` in the result is ''). */
export async function getDiffForPaths(
  repo: string,
  paths: string[],
  opts: DiffOptions = {},
): Promise<DiffResult> {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('at least one path is required');
  }
  const safe = paths.map(sanitizePathspec);
  const { maxBytes } = assertDiffOptions(opts);
  const result = await runDiff(repo, opts, safe, maxBytes);
  result.path = '';
  return result;
}

/**
 * Resolve the source side of a rename. A path-limited `git diff -- newpath`
 * disables rename detection (the deletion side is filtered out), so the cheap
 * `--name-status -z` listing is consulted first and both sides are then passed
 * to the patch-producing diff.
 */
async function findRenameSource(
  repo: string,
  opts: FileDiffOptions,
  filePath: string,
): Promise<string | undefined> {
  const args = ['diff', '--name-status', '-z', '--find-renames', '--no-ext-diff', '--no-textconv'];
  appendDiffTarget(args, opts);
  const res = await git(args, {
    cwd: repo,
    timeoutMs: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const tokens = res.stdout.split('\x00');
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      i += 2;
      if (newPath === filePath && oldPath && oldPath !== filePath) return oldPath;
    } else {
      i += 1;
    }
  }
  return undefined;
}

/** Single-file diff with rename detection (`oldPath` when git reports one). */
export async function getFileDiff(repo: string, opts: FileDiffOptions): Promise<DiffResult> {
  const { path: rawPath, ...rest } = opts;
  const filePath = sanitizePathspec(rawPath);
  const { maxBytes } = assertDiffOptions(opts);
  const canRename = opts.staged === true || opts.ref !== undefined;
  const oldPath = canRename ? await findRenameSource(repo, opts, filePath) : undefined;
  const paths =
    oldPath !== undefined
      ? [sanitizePathspec(oldPath), filePath]
      : [filePath];
  const result = await runDiff(repo, rest, paths, maxBytes);
  result.path = filePath;
  if (oldPath !== undefined) result.oldPath = oldPath;
  return result;
}

/* ------------------------------------------------------------------ */
/* conflicts                                                           */
/* ------------------------------------------------------------------ */

/** Unmerged paths reported by the index (empty when no conflict exists). */
export async function listConflicted(repo: string): Promise<string[]> {
  const res = await git(['diff', '--name-only', '--diff-filter=U', '-z'], {
    cwd: repo,
    timeoutMs: 20_000,
  });
  return res.stdout.split('\x00').filter(Boolean);
}
