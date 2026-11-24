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
