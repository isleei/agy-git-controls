/**
 * Typed client for every `/api/*` endpoint in docs/api.md.
 *
 * The UI never spawns git: it only calls these functions. Errors follow the
 * backend contract: `{ error, code? }` becomes `ApiError`, and
 * `{ error: 'confirm-required', action }` becomes `ConfirmRequiredError` so the
 * caller can show a ConfirmationDialog and retry with `confirmed: true`.
 */
import type {
  BranchInfo,
  CommitInfo,
  DiffResult,
  LogPage,
  OperationResult,
  RemoteInfo,
  RepoInfo,
  RepoStatus,
  StashEntry,
  TagInfo,
  WorktreeInfo,
  WorkspaceContext,
} from '../core/types.js';

export type Op = OperationResult;

export interface VersionInfo {
  v: number;
  lastChangeAt?: number;
}

export interface PrefsResponse {
  ok?: boolean;
  prefs?: Record<string, unknown>;
}

export interface StashShowResult {
  entries: StashEntry[];
  text: string;
}

export class ApiError extends Error {
  readonly code: string | undefined;
  readonly status: number;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export class ConfirmRequiredError extends ApiError {
  readonly action: string;

  constructor(action: string, status: number) {
    super('confirm-required', status, 'CONFIRM_REQUIRED');
    this.name = 'ConfirmRequiredError';
    this.action = action;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Wrap a failed OperationResult as a human-readable message + full detail. */
export function operationFailure(result: OperationResult): { summary: string; detail: string } {
  const stderr = (result.stderr ?? '').trim();
  const stdout = (result.stdout ?? '').trim();
  const summary = stderr.split('\n').find((line) => line.trim().length > 0) ?? 'git command failed';
  const detail = [stderr, stdout].filter(Boolean).join('\n\n');
  return { summary, detail: detail || summary };
}

async function call<T>(url: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const bridge = typeof window !== 'undefined' ? window.sidecar : undefined;
  const doFetch = bridge ? bridge.fetch.bind(bridge) : fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new ApiError(`network error: ${errorMessage(err)}`, 0);
  }

  let data: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
      throw new ApiError('invalid JSON from sidecar', res.status);
    }
  }

  if (isRecord(data) && typeof data.error === 'string') {
    const action = typeof data.action === 'string' ? data.action : '';
    if (data.error === 'confirm-required') throw new ConfirmRequiredError(action, res.status);
    throw new ApiError(
      data.error,
      res.status,
      typeof data.code === 'string' ? data.code : undefined,
    );
  }
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  return data as T;
}

/* ------------------------------------------------------------------ */
/* request shapes                                                      */
/* ------------------------------------------------------------------ */

export interface DiffRequest {
  path?: string;
  staged?: boolean;
  ref?: string;
  ref2?: string;
  context?: number;
  maxBytes?: number;
}

export interface CreateBranchRequest {
  name: string;
  startPoint?: string;
  checkout?: boolean;
}

export interface DeleteBranchRequest {
  force?: boolean;
  confirmed?: boolean;
}

export interface DiscardRequest {
  staged?: boolean;
  deleteUntracked?: boolean;
  confirmed?: boolean;
}

export interface CommitRequest {
  message: string;
  amend?: boolean;
  signoff?: boolean;
}

export interface FetchRequest {
  remote?: string;
  all?: boolean;
  prune?: boolean;
}

export interface PushRequest {
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
  forceWithLease?: boolean;
  confirmed?: boolean;
}

export interface LogRequest {
  skip?: number;
  maxCount?: number;
  path?: string;
  query?: string;
}

export interface MergeRequest {
  branch?: string;
  noFf?: boolean;
  squash?: boolean;
  action?: 'start' | 'abort';
}

export interface RebaseRequest {
  onto?: string;
  action?: 'start' | 'abort' | 'continue' | 'skip';
}

export interface CherryPickRequest {
  shas?: string[];
  action?: 'start' | 'abort' | 'continue';
}

export interface StashPushRequest {
  message?: string;
  includeUntracked?: boolean;
}

export interface StashActionRequest {
  index?: number;
  confirmed?: boolean;
}

export interface WorktreeAddRequest {
  path: string;
  branch?: string;
  newBranch?: string;
  detached?: boolean;
}

export interface WorktreeRemoveRequest {
  force?: boolean;
  confirmed?: boolean;
}

export interface TagCreateRequest {
  name: string;
  ref?: string;
  message?: string;
  annotated?: boolean;
}

export interface SendToConversationRequest {
  kind: 'diff' | 'commit';
  ref?: string;
  paths?: string[];
  staged?: boolean;
  prompt?: string;
}

/* ------------------------------------------------------------------ */
/* endpoints                                                           */
/* ------------------------------------------------------------------ */

export const api = {
  /* health / context */
  ping: () => call<{ ok: boolean; ts: number; projectId?: string | null }>('/api/ping', 'GET'),
  pushContext: (workspaceUris: string[]) =>
    call<WorkspaceContext>('/api/context', 'POST', { workspaceUris }),
  reposList: () =>
    call<{ repos: RepoInfo[]; registered: string[] }>('/api/repos/list', 'POST', {}),
  addRepo: (path: string) => call<RepoInfo>('/api/repos/add', 'POST', { path }),
  removeRepo: (path: string) => call<{ ok: boolean }>('/api/repos/remove', 'POST', { path }),

  /* status */
  status: (repo: string) => call<RepoStatus>('/api/status', 'POST', { repo }),

  /* branches */
  branches: (repo: string) => call<{ branches: BranchInfo[] }>('/api/branches', 'POST', { repo }),
  createBranch: (repo: string, req: CreateBranchRequest) =>
    call<Op>('/api/branch/create', 'POST', { repo, ...req }),
  checkoutBranch: (repo: string, name: string) =>
    call<Op>('/api/branch/checkout', 'POST', { repo, name }),
  renameBranch: (repo: string, oldName: string, newName: string) =>
    call<Op>('/api/branch/rename', 'POST', { repo, old: oldName, new: newName }),
  deleteBranch: (repo: string, name: string, req: DeleteBranchRequest = {}) =>
    call<Op>('/api/branch/delete', 'POST', { repo, name, ...req }),
  setUpstream: (repo: string, branch: string, upstream: string | null) =>
    call<Op>('/api/branch/set-upstream', 'POST', { repo, branch, upstream }),
  trackRemote: (repo: string, remoteBranch: string, localName?: string) =>
    call<Op>('/api/track-remote', 'POST', {
      repo,
      remoteBranch,
      ...(localName !== undefined ? { localName } : {}),
    }),

  /* index */
  stage: (repo: string, paths: string[]) => call<Op>('/api/stage', 'POST', { repo, paths }),
  unstage: (repo: string, paths: string[]) => call<Op>('/api/unstage', 'POST', { repo, paths }),
  stageAll: (repo: string) => call<Op>('/api/stage-all', 'POST', { repo }),
  unstageAll: (repo: string) => call<Op>('/api/unstage-all', 'POST', { repo }),
  discard: (repo: string, paths: string[], req: DiscardRequest = {}) =>
    call<Op>('/api/discard', 'POST', { repo, paths, ...req }),

  /* diff */
  diff: (repo: string, req: DiffRequest = {}) => call<DiffResult>('/api/diff', 'POST', { repo, ...req }),

  /* commit */
  commit: (repo: string, req: CommitRequest) => call<Op>('/api/commit', 'POST', { repo, ...req }),

  /* sync */
  fetch: (repo: string, req: FetchRequest = {}) =>
    call<Op>('/api/fetch', 'POST', { repo, ...req }),
  pull: (repo: string, mode: 'ff' | 'merge' | 'rebase') =>
    call<Op>('/api/pull', 'POST', { repo, mode }),
  push: (repo: string, req: PushRequest = {}) => call<Op>('/api/push', 'POST', { repo, ...req }),

  /* history */
  log: (repo: string, req: LogRequest = {}) => call<LogPage>('/api/log', 'POST', { repo, ...req }),
  conflicts: (repo: string) =>
    call<{ files: string[]; operation: string | null }>('/api/conflicts', 'POST', { repo }),

  /* merge family */
  merge: (repo: string, req: MergeRequest = {}) => call<Op>('/api/merge', 'POST', { repo, ...req }),
  rebase: (repo: string, req: RebaseRequest = {}) => call<Op>('/api/rebase', 'POST', { repo, ...req }),
  cherryPick: (repo: string, req: CherryPickRequest = {}) =>
    call<Op>('/api/cherry-pick', 'POST', { repo, ...req }),
  revert: (repo: string, shas: string[], noCommit?: boolean) =>
    call<Op>('/api/revert', 'POST', {
      repo,
      shas,
      ...(noCommit !== undefined ? { noCommit } : {}),
    }),

  /* stash */
  stashPush: (repo: string, req: StashPushRequest = {}) =>
    call<Op>('/api/stash', 'POST', { repo, action: 'push', ...req }),
  stashApply: (repo: string, index: number) =>
    call<Op>('/api/stash', 'POST', { repo, action: 'apply', index }),
  stashPop: (repo: string, index: number) =>
    call<Op>('/api/stash', 'POST', { repo, action: 'pop', index }),
  stashDrop: (repo: string, index: number, confirmed: boolean) =>
    call<Op>('/api/stash', 'POST', { repo, action: 'drop', index, confirmed }),
  stashShow: (repo: string, index: number) =>
    call<StashShowResult>('/api/stash', 'POST', { repo, action: 'show', index }),
  stashes: (repo: string) => call<{ entries: StashEntry[] }>('/api/stashes', 'POST', { repo }),

  /* worktrees */
  worktrees: (repo: string) =>
    call<{ worktrees: WorktreeInfo[] }>('/api/worktrees', 'POST', { repo }),
  worktreeAdd: (repo: string, req: WorktreeAddRequest) =>
    call<Op>('/api/worktree/add', 'POST', { repo, ...req }),
  worktreeRemove: (repo: string, path: string, req: WorktreeRemoveRequest = {}) =>
    call<Op>('/api/worktree/remove', 'POST', { repo, path, ...req }),

  /* remotes */
  remotes: (repo: string) => call<{ remotes: RemoteInfo[] }>('/api/remotes', 'POST', { repo }),
  remoteAdd: (repo: string, name: string, url: string) =>
    call<Op>('/api/remote/add', 'POST', { repo, name, url }),
  remoteRemove: (repo: string, name: string, confirmed: boolean) =>
    call<Op>('/api/remote/remove', 'POST', { repo, name, confirmed }),

  /* tags */
  tags: (repo: string) => call<{ tags: TagInfo[] }>('/api/tags', 'POST', { repo }),
  tagCreate: (repo: string, req: TagCreateRequest) =>
    call<Op>('/api/tag/create', 'POST', { repo, ...req }),
  tagDelete: (repo: string, name: string, confirmed: boolean) =>
    call<Op>('/api/tag/delete', 'POST', { repo, name, confirmed }),

  /* ai (explicit user click only) */
  sendToConversation: (repo: string, req: SendToConversationRequest) =>
    call<{ conversationId?: string }>('/api/ai/send-to-conversation', 'POST', { repo, ...req }),

  /* version / prefs */
  version: (repo: string) => call<VersionInfo>('/api/version', 'POST', { repo }),
  getPrefs: () => call<PrefsResponse>('/api/prefs', 'GET'),
  setPrefs: (prefs: Record<string, unknown>) =>
    call<PrefsResponse>('/api/prefs', 'POST', { prefs }),
};

export type CommitList = CommitInfo[];
