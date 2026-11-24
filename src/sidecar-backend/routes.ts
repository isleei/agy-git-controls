/**
 * Sidecar REST layer.
 *
 * Every handler is: validate input -> resolve the repo against the registry
 * allowlist -> call `src/core` -> map the result. No git invocation lives here.
 *
 * Error shapes follow docs/api.md:
 *   - bad input          -> { error, code: 'EINVAL' }
 *   - unknown repo       -> { error, code: 'ENOENT_REPO' }
 *   - missing confirmed   -> { error: 'confirm-required', action }
 *   - core threw         -> { error, code: 'GIT' }
 *   - OperationResult{ok:false} is returned untouched.
 */
import * as ops from '../core/ops.js';
import * as query from '../core/query.js';
import * as refs from '../core/refs.js';
import { detectOperation, getStatus } from '../core/repo.js';
import type { CommitInfo } from '../core/types.js';
import { MAX_PREFS_BYTES, type RepoRegistry } from './registry.js';

export type RouteHandler = (data: Record<string, unknown>) => unknown | Promise<unknown>;

/** Minimal SidecarApp surface used by registerApi (fake-able in tests). */
export interface ApiAppLike {
  readonly config?: { projectId?: string };
  api(path: string, handler: RouteHandler, method?: 'GET' | 'POST'): void;
}

/** The only bridge to the host Agent API; reachable from one endpoint only. */
export interface AgentBridge {
  startConversation(message: string, opts?: { projectId?: string }): unknown;
  projectId?: string;
}

export interface RouteDeps {
  registry: RepoRegistry;
  /** In-memory fs-watcher version counter for `/api/version` (0 when absent). */
  versionOf?: (repo: string) => number;
  /** Injected host bridge for `/api/ai/send-to-conversation`. */
  agent?: AgentBridge;
}

type Body = Record<string, unknown>;

const MAX_PATH_LEN = 4096;
const MAX_PATHS = 10_000;
const MAX_MESSAGE_LEN = 100_000;
const MAX_PROMPT_LEN = 20_000;

class RouteError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'RouteError';
    this.code = code;
  }
}

class ConfirmRequired extends Error {
  readonly action: string;
  constructor(action: string) {
    super('confirm-required');
    this.name = 'ConfirmRequired';
    this.action = action;
  }
}

function invalid(message: string): never {
  throw new RouteError(message, 'EINVAL');
}

/* ------------------------------------------------------------------ */
/* input validation                                                    */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Body {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reqString(data: Body, key: string, maxLen = MAX_PATH_LEN): string {
  const value = data[key];
  if (typeof value !== 'string' || value.length === 0) {
    invalid(`${key} must be a non-empty string`);
  }
  if (value.includes('\0')) invalid(`${key} contains a NUL byte`);
  if (value.length > maxLen) invalid(`${key} is too long`);
  return value;
}

function optString(data: Body, key: string, maxLen = MAX_PATH_LEN): string | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') invalid(`${key} must be a string`);
  if (value.includes('\0')) invalid(`${key} contains a NUL byte`);
  if (value.length > maxLen) invalid(`${key} is too long`);
  return value;
}

function reqNullableString(data: Body, key: string): string | null {
  const value = data[key];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    invalid(`${key} must be a string or null`);
  }
  if (value.includes('\0') || value.length > MAX_PATH_LEN) invalid(`${key} is not a valid ref`);
  return value;
}

function optBool(data: Body, key: string): boolean | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') invalid(`${key} must be a boolean`);
  return value;
}

function optInt(data: Body, key: string, min: number, max: number): number | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function reqStringArray(
  data: Body,
  key: string,
  opts: { allowEmpty?: boolean } = {},
): string[] {
  const value = data[key];
  if (!Array.isArray(value)) invalid(`${key} must be an array of strings`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) {
      invalid(`${key} must contain non-empty strings`);
    }
    if (item.includes('\0')) invalid(`${key} contains a NUL byte`);
    if (item.length > MAX_PATH_LEN) invalid(`${key} entry is too long`);
    out.push(item);
  }
  if (out.length === 0 && opts.allowEmpty !== true) invalid(`${key} must not be empty`);
  if (out.length > MAX_PATHS) invalid(`${key} has too many entries`);
  return out;
}

function optStringArray(data: Body, key: string): string[] | undefined {
  if (data[key] === undefined || data[key] === null) return undefined;
  return reqStringArray(data, key);
}

function reqEnum<const T extends readonly string[]>(
  data: Body,
  key: string,
  allowed: T,
): T[number] {
  const value = data[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    invalid(`${key} must be one of: ${allowed.join(', ')}`);
  }
  return value as T[number];
}

function optEnum<const T extends readonly string[]>(
  data: Body,
  key: string,
  allowed: T,
): T[number] | undefined {
  if (data[key] === undefined || data[key] === null) return undefined;
  return reqEnum(data, key, allowed);
}

function requireConfirmed(data: Body, action: string): void {
  if (data.confirmed !== true) throw new ConfirmRequired(action);
}

/** Re-label a core syntax guard failure as EINVAL (injection-shaped input). */
function coreCheck(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    invalid(err instanceof Error ? err.message : String(err));
  }
}

function checkRef(value: string | undefined, label: string): void {
  if (value !== undefined) coreCheck(() => refs.assertSafeRef(value, label));
}

/* ------------------------------------------------------------------ */
/* handler plumbing                                                    */
/* ------------------------------------------------------------------ */

function guarded(fn: (body: Body) => Promise<unknown>): RouteHandler {
  return async (raw) => {
    const body: Body = isPlainObject(raw) ? raw : {};
    try {
      return await fn(body);
    } catch (err) {
      if (err instanceof ConfirmRequired) {
        return { error: 'confirm-required', action: err.action };
      }
      if (err instanceof RouteError) {
        return { error: err.message, code: err.code };
      }
      return { error: err instanceof Error ? err.message : String(err), code: 'GIT' };
    }
  };
}

/** Validate `repo` then return its canonical path after allowlist resolution. */
async function requireRepo(registry: RepoRegistry, body: Body): Promise<string> {
  const input = reqString(body, 'repo', MAX_PATH_LEN);
  const info = await registry.resolveRepo(input);
  if (!info) throw new RouteError('repo is not registered', 'ENOENT_REPO');
  return info.path;
}

function extractConversationId(result: unknown): string | undefined {
  if (!isPlainObject(result)) return undefined;
  for (const key of ['conversationId', 'conversation_id', 'id'] as const) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Human/agent-readable commit block (message + identity), no patch. */
function formatCommit(commit: CommitInfo | undefined): string {
  if (!commit) return '(no commits)';
  const lines = [
    `commit ${commit.sha}`,
    `Author: ${commit.author} <${commit.authorEmail}>`,
    `Date: ${commit.date}`,
    '',
    `    ${commit.subject}`,
  ];
  if (commit.body) {
    lines.push('', ...commit.body.split('\n').map((line) => `    ${line}`));
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

export function registerApi(app: ApiAppLike, deps: RouteDeps): void {
  const { registry } = deps;
  const versionOf = deps.versionOf ?? (() => 0);

  /* health ---------------------------------------------------------- */

  app.api(
    '/api/ping',
    guarded(async () => ({
      ok: true,
      ts: Date.now(),
      projectId: app.config?.projectId ?? null,
    })),
    'GET',
  );

  /* context / repos ------------------------------------------------- */

  app.api(
    '/api/context',
    guarded(async (body) => {
      const uris = reqStringArray(body, 'workspaceUris', { allowEmpty: true });
      return registry.setWorkspace(uris);
    }),
  );

  app.api(
    '/api/repos/list',
    guarded(async () => ({
      repos: await registry.listRepos(),
      registered: registry.registeredPaths(),
    })),
  );

  app.api(
    '/api/repos/add',
    guarded(async (body) => {
      const inputPath = reqString(body, 'path');
      const info = await registry.addRegistered(inputPath);
      if (!info) {
        throw new RouteError('not a git work tree', 'EINVAL');
      }
      return info;
    }),
  );

  app.api(
    '/api/repos/remove',
    guarded(async (body) => {
      const inputPath = reqString(body, 'path');
      const removed = await registry.removeRegistered(inputPath);
      if (!removed) throw new RouteError('repo is not registered', 'ENOENT_REPO');
      return { ok: true };
    }),
  );

  /* status / branches ----------------------------------------------- */

  app.api(
    '/api/status',
    guarded(async (body) => getStatus(await requireRepo(registry, body))),
  );

  app.api(
    '/api/branches',
    guarded(async (body) => ({
      branches: await query.listBranches(await requireRepo(registry, body)),
    })),
  );

  app.api(
    '/api/branch/create',
    guarded(async (body) => {
      const name = reqString(body, 'name', 1024);
      coreCheck(() => refs.assertSafeRef(name, 'branch'));
      const startPoint = optString(body, 'startPoint', 1024);
      checkRef(startPoint, 'start point');
      const checkout = optBool(body, 'checkout');
      const repo = await requireRepo(registry, body);
      return ops.createBranch(repo, {
        name,
        ...(startPoint !== undefined ? { startPoint } : {}),
        ...(checkout !== undefined ? { checkout } : {}),
      });
    }),
  );

  app.api(
    '/api/branch/checkout',
    guarded(async (body) => {
      const name = reqString(body, 'name', 1024);
      coreCheck(() => refs.assertSafeRef(name, 'branch'));
      const repo = await requireRepo(registry, body);
      return ops.checkoutBranch(repo, name);
    }),
  );

  app.api(
    '/api/branch/rename',
    guarded(async (body) => {
      const oldName = reqString(body, 'old', 1024);
      const newName = reqString(body, 'new', 1024);
      coreCheck(() => refs.assertSafeRef(oldName, 'branch'));
      coreCheck(() => refs.assertSafeRef(newName, 'branch'));
      const repo = await requireRepo(registry, body);
      return ops.renameBranch(repo, oldName, newName);
    }),
  );

  app.api(
    '/api/branch/delete',
    guarded(async (body) => {
      const name = reqString(body, 'name', 1024);
      coreCheck(() => refs.assertSafeRef(name, 'branch'));
      const force = optBool(body, 'force');
      requireConfirmed(body, '/api/branch/delete');
      const repo = await requireRepo(registry, body);
      return ops.deleteBranch(repo, name, { ...(force !== undefined ? { force } : {}) });
    }),
  );

  app.api(
    '/api/branch/set-upstream',
    guarded(async (body) => {
      const branch = reqString(body, 'branch', 1024);
      coreCheck(() => refs.assertSafeRef(branch, 'branch'));
      const upstream = reqNullableString(body, 'upstream');
      if (upstream !== null) coreCheck(() => refs.assertSafeRef(upstream, 'upstream'));
      const repo = await requireRepo(registry, body);
      return ops.setUpstream(repo, branch, upstream);
    }),
  );

  app.api(
    '/api/track-remote',
    guarded(async (body) => {
      const remoteBranch = reqString(body, 'remoteBranch', 1024);
      coreCheck(() => refs.assertSafeRef(remoteBranch, 'remote branch'));
      const localName = optString(body, 'localName', 1024);
      checkRef(localName, 'branch');
      const repo = await requireRepo(registry, body);
      return ops.trackRemote(repo, remoteBranch, {
        ...(localName !== undefined ? { localName } : {}),
      });
    }),
  );

  /* index ----------------------------------------------------------- */

  app.api(
    '/api/stage',
    guarded(async (body) => {
      const paths = reqStringArray(body, 'paths');
      coreCheck(() => refs.sanitizePathspecs(paths));
      const repo = await requireRepo(registry, body);
      return ops.stage(repo, paths);
    }),
  );

  app.api(
    '/api/unstage',
    guarded(async (body) => {
      const paths = reqStringArray(body, 'paths');
      coreCheck(() => refs.sanitizePathspecs(paths));
      const repo = await requireRepo(registry, body);
      return ops.unstage(repo, paths);
    }),
  );

  app.api(
    '/api/stage-all',
    guarded(async (body) => ops.stageAll(await requireRepo(registry, body))),
  );

  app.api(
    '/api/unstage-all',
    guarded(async (body) => ops.unstageAll(await requireRepo(registry, body))),
  );

  app.api(
    '/api/discard',
    guarded(async (body) => {
      const paths = reqStringArray(body, 'paths');
      coreCheck(() => refs.sanitizePathspecs(paths));
      const staged = optBool(body, 'staged');
      const deleteUntracked = optBool(body, 'deleteUntracked');
      requireConfirmed(body, '/api/discard');
      const repo = await requireRepo(registry, body);
      return ops.discard(repo, paths, {
        ...(staged !== undefined ? { staged } : {}),
        ...(deleteUntracked !== undefined ? { deleteUntracked } : {}),
      });
    }),
  );

  /* diff / commit --------------------------------------------------- */

  app.api(
    '/api/diff',
    guarded(async (body) => {
      const filePath = optString(body, 'path');
      if (filePath !== undefined) coreCheck(() => refs.sanitizePathspec(filePath));
      const staged = optBool(body, 'staged');
      const ref = optString(body, 'ref', 1024);
      const ref2 = optString(body, 'ref2', 1024);
      checkRef(ref, 'revision');
      checkRef(ref2, 'revision');
      if (ref2 !== undefined && ref === undefined) invalid('ref2 requires ref');
      if (staged === true && (ref !== undefined || ref2 !== undefined)) {
        invalid('staged cannot be combined with ref/ref2');
      }
      const context = optInt(body, 'context', 0, 10_000);
      const maxBytes = optInt(body, 'maxBytes', 1, 64 * 1024 * 1024);
      const repo = await requireRepo(registry, body);
      const opts = {
        ...(staged !== undefined ? { staged } : {}),
        ...(ref !== undefined ? { ref } : {}),
        ...(ref2 !== undefined ? { ref2 } : {}),
        ...(context !== undefined ? { context } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      };
      if (filePath !== undefined) {
        return query.getFileDiff(repo, { ...opts, path: filePath });
      }
      return query.getDiff(repo, opts);
    }),
  );

  app.api(
    '/api/commit',
    guarded(async (body) => {
      const message = reqString(body, 'message', MAX_MESSAGE_LEN);
      coreCheck(() => refs.assertMessage(message));
      const amend = optBool(body, 'amend');
      const signoff = optBool(body, 'signoff');
      const repo = await requireRepo(registry, body);
      return ops.commit(repo, {
        message,
        ...(amend !== undefined ? { amend } : {}),
        ...(signoff !== undefined ? { signoff } : {}),
      });
    }),
  );

  /* sync ------------------------------------------------------------ */

  app.api(
    '/api/fetch',
    guarded(async (body) => {
      const remote = optString(body, 'remote', 1024);
      checkRef(remote, 'remote');
      const all = optBool(body, 'all');
      const prune = optBool(body, 'prune');
      if (all === true && remote !== undefined) invalid('remote cannot be combined with all');
      const repo = await requireRepo(registry, body);
      return ops.fetch(repo, {
        ...(remote !== undefined ? { remote } : {}),
        ...(all !== undefined ? { all } : {}),
        ...(prune !== undefined ? { prune } : {}),
      });
    }),
  );

  app.api(
    '/api/pull',
    guarded(async (body) => {
      const mode = optEnum(body, 'mode', ['ff', 'merge', 'rebase'] as const) ?? 'ff';
      const repo = await requireRepo(registry, body);
      return ops.pull(repo, { mode });
    }),
  );

  app.api(
    '/api/push',
    guarded(async (body) => {
      const remote = optString(body, 'remote', 1024);
      const branch = optString(body, 'branch', 1024);
      checkRef(remote, 'remote');
      checkRef(branch, 'branch');
      const setUpstream = optBool(body, 'setUpstream');
      const forceWithLease = optBool(body, 'forceWithLease');
      if (forceWithLease === true) requireConfirmed(body, '/api/push');
      const repo = await requireRepo(registry, body);
      return ops.push(repo, {
        ...(remote !== undefined ? { remote } : {}),
        ...(branch !== undefined ? { branch } : {}),
        ...(setUpstream !== undefined ? { setUpstream } : {}),
        ...(forceWithLease !== undefined ? { forceWithLease } : {}),
      });
    }),
  );

  /* log / conflicts ------------------------------------------------- */

  app.api(
    '/api/log',
    guarded(async (body) => {
      const skip = optInt(body, 'skip', 0, 1_000_000_000);
      const maxCount = optInt(body, 'maxCount', 1, 10_000);
      const path = optString(body, 'path');
      if (path !== undefined) coreCheck(() => refs.sanitizePathspec(path));
      const textQuery = optString(body, 'query', 1024);
      if (textQuery !== undefined && textQuery.length === 0) invalid('query must not be empty');
      const repo = await requireRepo(registry, body);
      return query.getLog(repo, {
        ...(skip !== undefined ? { skip } : {}),
        ...(maxCount !== undefined ? { maxCount } : {}),
        ...(path !== undefined ? { path } : {}),
        ...(textQuery !== undefined ? { query: textQuery } : {}),
      });
    }),
  );

  app.api(
    '/api/conflicts',
    guarded(async (body) => {
      const repo = await requireRepo(registry, body);
      const [files, operation] = await Promise.all([
        query.listConflicted(repo),
        detectOperation(repo),
      ]);
      return { files, operation };
    }),
  );

  /* merge family ---------------------------------------------------- */

  app.api(
    '/api/merge',
    guarded(async (body) => {
      const action = optEnum(body, 'action', ['start', 'abort'] as const) ?? 'start';
      const branch = optString(body, 'branch', 1024);
      if (branch !== undefined) coreCheck(() => refs.assertSafeRef(branch, 'branch'));
      const noFf = optBool(body, 'noFf');
      const squash = optBool(body, 'squash');
      const repo = await requireRepo(registry, body);
      if (action === 'abort') return ops.merge(repo, branch ?? '', { abort: true });
      if (branch === undefined) invalid('branch is required to start a merge');
      return ops.merge(repo, branch, {
        ...(noFf !== undefined ? { noFf } : {}),
        ...(squash !== undefined ? { squash } : {}),
      });
    }),
  );

  app.api(
    '/api/rebase',
    guarded(async (body) => {
      const onto = optString(body, 'onto', 1024);
      checkRef(onto, 'revision');
      const action = optEnum(body, 'action', ['start', 'abort', 'continue', 'skip'] as const) ?? 'start';
      if (action === 'start' && onto === undefined) invalid('onto is required to start a rebase');
      const repo = await requireRepo(registry, body);
      const options =
        action === 'abort'
          ? { abort: true }
          : action === 'continue'
            ? { continue: true }
            : action === 'skip'
              ? { skip: true }
              : {};
      return ops.rebase(repo, onto ?? '', options);
    }),
  );

  app.api(
    '/api/cherry-pick',
    guarded(async (body) => {
      const action = optEnum(body, 'action', ['start', 'abort', 'continue'] as const) ?? 'start';
      const shas = optStringArray(body, 'shas') ?? [];
      for (const sha of shas) coreCheck(() => refs.assertSafeSha(sha));
      if (action === 'start' && shas.length === 0) invalid('shas is required to start a cherry-pick');
      const repo = await requireRepo(registry, body);
      const options = action === 'abort' ? { abort: true } : action === 'continue' ? { continue: true } : {};
      return ops.cherryPick(repo, shas, options);
    }),
  );

  app.api(
    '/api/revert',
    guarded(async (body) => {
      const shas = reqStringArray(body, 'shas');
      for (const sha of shas) coreCheck(() => refs.assertSafeSha(sha));
      const noCommit = optBool(body, 'noCommit');
      const repo = await requireRepo(registry, body);
      return ops.revert(repo, shas, { ...(noCommit !== undefined ? { noCommit } : {}) });
    }),
  );

  /* stash ----------------------------------------------------------- */

  app.api(
    '/api/stash',
    guarded(async (body) => {
      const action = reqEnum(body, 'action', ['push', 'apply', 'pop', 'drop', 'show'] as const);
      const message = optString(body, 'message', MAX_MESSAGE_LEN);
      if (message !== undefined) coreCheck(() => refs.assertMessage(message));
      const includeUntracked = optBool(body, 'includeUntracked');
      const index = optInt(body, 'index', 0, 1_000_000);
      if (action === 'drop') requireConfirmed(body, '/api/stash');
      const repo = await requireRepo(registry, body);

      if (action === 'push') {
        return ops.stash(repo, {
          action: 'push',
          ...(message !== undefined ? { message } : {}),
          ...(includeUntracked !== undefined ? { includeUntracked } : {}),
        });
      }
      if (action === 'show') {
        const result = await ops.stash(repo, {
          action: 'show',
          ...(index !== undefined ? { index } : {}),
        });
        if (!result.ok) return result;
        return { entries: await query.listStashes(repo), text: result.stdout ?? '' };
      }
      return ops.stash(repo, {
        action,
        ...(index !== undefined ? { index } : {}),
      });
    }),
  );

  app.api(
    '/api/stashes',
    guarded(async (body) => ({
      entries: await query.listStashes(await requireRepo(registry, body)),
    })),
  );

  /* worktrees ------------------------------------------------------- */

  app.api(
    '/api/worktrees',
    guarded(async (body) => ({
      worktrees: await query.listWorktrees(await requireRepo(registry, body)),
    })),
  );

  app.api(
    '/api/worktree/add',
    guarded(async (body) => {
      const worktreePath = reqString(body, 'path');
      const branch = optString(body, 'branch', 1024);
      const newBranch = optString(body, 'newBranch', 1024);
      checkRef(branch, 'branch');
      checkRef(newBranch, 'branch');
      const detached = optBool(body, 'detached');
      const repo = await requireRepo(registry, body);
      return ops.worktreeAdd(repo, {
        path: worktreePath,
        ...(branch !== undefined ? { branch } : {}),
        ...(newBranch !== undefined ? { newBranch } : {}),
        ...(detached !== undefined ? { detached } : {}),
      });
    }),
  );

  app.api(
    '/api/worktree/remove',
    guarded(async (body) => {
      const worktreePath = reqString(body, 'path');
      const force = optBool(body, 'force');
      requireConfirmed(body, '/api/worktree/remove');
      const repo = await requireRepo(registry, body);
      return ops.worktreeRemove(repo, {
        path: worktreePath,
        ...(force !== undefined ? { force } : {}),
      });
    }),
  );

  /* remotes --------------------------------------------------------- */

  app.api(
    '/api/remotes',
    guarded(async (body) => ({
      remotes: await query.listRemotes(await requireRepo(registry, body)),
    })),
  );

  app.api(
    '/api/remote/add',
    guarded(async (body) => {
      const name = reqString(body, 'name', 1024);
      const url = reqString(body, 'url', 4096);
      coreCheck(() => refs.assertSafeRef(name, 'remote'));
      coreCheck(() => refs.assertSafeRemoteUrl(url));
      const repo = await requireRepo(registry, body);
      return ops.remoteAdd(repo, { name, url });
    }),
  );

  app.api(
    '/api/remote/remove',
    guarded(async (body) => {
      const name = reqString(body, 'name', 1024);
      coreCheck(() => refs.assertSafeRef(name, 'remote'));
      requireConfirmed(body, '/api/remote/remove');
      const repo = await requireRepo(registry, body);
      return ops.remoteRemove(repo, name);
    }),
  );

  /* tags ------------------------------------------------------------ */

  app.api(
    '/api/tags',
    guarded(async (body) => ({
      tags: await query.listTags(await requireRepo(registry, body)),
    })),
  );

  app.api(
    '/api/tag/create',
    guarded(async (body) => {
      const name = reqString(body, 'name', 1024);
      coreCheck(() => refs.assertSafeRef(name, 'tag'));
      const ref = optString(body, 'ref', 1024);
      checkRef(ref, 'revision');
      const message = optString(body, 'message', MAX_MESSAGE_LEN);
      if (message !== undefined) coreCheck(() => refs.assertMessage(message));
      const annotated = optBool(body, 'annotated');
      if (annotated === true && message === undefined) {
        invalid('annotated tag requires a message');
      }
      const repo = await requireRepo(registry, body);
      return ops.createTag(repo, {
        name,
        ...(ref !== undefined ? { ref } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(annotated !== undefined ? { annotated } : {}),
      });
    }),
  );

  app.api(
    '/api/tag/delete',
    guarded(async (body) => {
      const name = reqString(body, 'name', 1024);
      coreCheck(() => refs.assertSafeRef(name, 'tag'));
      requireConfirmed(body, '/api/tag/delete');
      const repo = await requireRepo(registry, body);
      return ops.deleteTag(repo, name);
    }),
  );

  /* ai -------------------------------------------------------------- */

  app.api(
    '/api/ai/send-to-conversation',
    guarded(async (body) => {
      const kind = reqEnum(body, 'kind', ['diff', 'commit'] as const);
      const ref = optString(body, 'ref', 1024);
      checkRef(ref, 'revision');
      const paths = optStringArray(body, 'paths');
      if (paths !== undefined) coreCheck(() => refs.sanitizePathspecs(paths));
      if (kind === 'commit' && paths !== undefined) invalid('paths only applies to kind=diff');
      const staged = optBool(body, 'staged');
      if (kind === 'commit' && staged !== undefined) invalid('staged only applies to kind=diff');
      const prompt = optString(body, 'prompt', MAX_PROMPT_LEN);
      const repo = await requireRepo(registry, body);

      const agent = deps.agent;
      if (!agent) throw new RouteError('agent API is unavailable', 'EAGENT');

      const diffOpts = {
        ...(ref !== undefined ? { ref } : {}),
        ...(staged !== undefined ? { staged } : {}),
      };
      let content: string;
      if (kind === 'diff') {
        const diff = paths
          ? await query.getDiffForPaths(repo, paths, diffOpts)
          : await query.getDiff(repo, diffOpts);
        content = diff.hunks.trim()
          ? `\`\`\`diff\n${diff.hunks.trimEnd()}\n\`\`\``
          : '(no changes)';
      } else {
        const page = await query.getLog(repo, {
          maxCount: 1,
          all: false,
          ...(ref !== undefined ? { ref } : {}),
        });
        content = formatCommit(page.commits[0]);
      }

      const message = prompt !== undefined ? `${prompt.trim()}\n\n${content}` : content;
      let result: unknown;
      try {
        result = await agent.startConversation(message, {
          ...(agent.projectId !== undefined ? { projectId: agent.projectId } : {}),
        });
      } catch (err) {
        throw new RouteError(
          `agent API failed: ${err instanceof Error ? err.message : String(err)}`,
          'EAGENT',
        );
      }
      const conversationId = extractConversationId(result);
      return conversationId !== undefined ? { conversationId } : {};
    }),
  );

  /* version / prefs ------------------------------------------------- */

  app.api(
    '/api/version',
    guarded(async (body) => {
      const repo = await requireRepo(registry, body);
      return { v: versionOf(repo) };
    }),
  );

  app.api(
    '/api/prefs',
    guarded(async () => ({ prefs: registry.getPrefs() })),
    'GET',
  );

  app.api(
    '/api/prefs',
    guarded(async (body) => {
      if (body.prefs !== undefined) {
        if (!isPlainObject(body.prefs)) invalid('prefs must be an object');
        const bytes = Buffer.byteLength(JSON.stringify(body.prefs), 'utf8');
        if (bytes > MAX_PREFS_BYTES) {
          invalid(`prefs exceed the ${MAX_PREFS_BYTES}-byte limit`);
        }
        await registry.setPrefs(body.prefs);
      }
      return { ok: true, prefs: registry.getPrefs() };
    }),
  );
}
