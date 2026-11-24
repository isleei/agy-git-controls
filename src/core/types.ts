/** Shared DTOs between sidecar backend, UI and MCP server. */

export interface RepoInfo {
  /** Canonical absolute path of the working-tree root. */
  path: string;
  /** Basename of the repo root for display. */
  name: string;
  /** True when this path is a linked worktree (not the main checkout). */
  isWorktree: boolean;
  /** Where this repo came from. */
  source: 'workspace' | 'registered';
}

export interface FileChange {
  path: string;
  /** Original path for renames/copies. */
  origPath?: string;
  /** Porcelain XY-style status: staged, unstaged, both. */
  staged: boolean;
  unstaged: boolean;
  /** Single-letter kind: A M D R C U T ? ! */
  kind: string;
  /** True for unmerged/conflicted entries. */
  conflicted: boolean;
}

export interface RepoStatus {
  repo: string;
  branch: string | null;
  /** Non-null when HEAD is detached — the short sha. */
  detachedAt: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  /** In-progress operation: merge | rebase | cherry-pick | revert | bisect | null */
  operation: string | null;
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: FileChange[];
  conflicted: FileChange[];
}

export interface WorkspaceContext {
  /** Workspace folder URIs pushed by the host. */
  workspaceUris: string[];
  /** Resolved repos (workspace folders that are inside git work trees). */
  repos: RepoInfo[];
}

export interface ApiError {
  error: string;
  code?: string;
}

export interface BranchInfo {
  /** Short name: `main` for locals, `origin/main` for remotes. */
  name: string;
  /** Full refname. */
  ref: string;
  remote: boolean;
  current: boolean;
  /** Short upstream name, e.g. `origin/main`; null when untracked. */
  upstream: string | null;
  ahead: number;
  behind: number;
  lastCommitAt: string;
  lastCommitSha: string;
}

export type CommitRefType = 'head' | 'tag' | 'branch' | 'remote' | 'stash';

export interface CommitRef {
  name: string;
  type: CommitRefType;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  authorEmail: string;
  /** ISO-8601 author date. */
  date: string;
  subject: string;
  body?: string;
  refs: CommitRef[];
}

export interface LogPage {
  commits: CommitInfo[];
  total?: number;
  hasMore: boolean;
}

export interface DiffResult {
  /** Path the diff was requested for ('' for a multi-file diff). */
  path: string;
  /** Raw unified patch (may be truncated). */
  hunks: string;
  binary: boolean;
  truncated: boolean;
  /** Source path when the diff follows a rename. */
  oldPath?: string;
}

export interface StashEntry {
  index: number;
  /** Reflog selector, e.g. `stash@{0}`. */
  name: string;
  message: string;
  /** Branch the stash was created on, when parseable. */
  branch?: string;
  date: string;
}

export interface WorktreeInfo {
  path: string;
  /** Short branch name; null when detached or bare. */
  branch: string | null;
  head: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface TagInfo {
  name: string;
  annotated: boolean;
  date?: string;
  message?: string;
  sha: string;
}

/** Uniform result for every write operation. */
export interface OperationResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Unmerged paths present after the operation failed. */
  conflicted?: string[];
}
