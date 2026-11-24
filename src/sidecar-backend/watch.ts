/**
 * Repo watcher: bumps an in-memory version counter on filesystem activity so
 * the UI can poll `/api/version` cheaply (zero git calls) instead of asking
 * for a full status every few seconds.
 *
 * One `fs.watch` per repo root, debounced. When the recursive watch is not
 * available (Linux), fall back to watching `.git/index`, `.git/HEAD` and the
 * refs directories. A failed watch is never fatal — the version stays 0.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface RepoWatcherOptions {
  /** Coalescing window for bursts of fs events. Default 500 ms. */
  debounceMs?: number;
  /** Invoked after a debounced bump. */
  onVersion?: (repo: string, version: number, lastChangeAt: number) => void;
}

export interface RepoWatchState {
  /** True when a watcher is attached to this repo. */
  watched: boolean;
  version: number;
  lastChangeAt: number | null;
}

interface WatchEntry {
  version: number;
  lastChangeAt: number | null;
  timer: NodeJS.Timeout | null;
  closers: Array<() => void>;
}

/** `.git` directory for a work tree (handles linked worktrees/submodules). */
function resolveGitDir(repo: string): string | null {
  const dotGit = path.join(repo, '.git');
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    const content = fs.readFileSync(dotGit, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/m.exec(content);
    if (match?.[1]) return path.resolve(repo, match[1].trim());
  } catch {
    /* not a git work tree */
  }
  return null;
}

export class RepoWatcher {
  readonly debounceMs: number;

  #entries = new Map<string, WatchEntry>();
  #onVersion: RepoWatcherOptions['onVersion'];
  #closed = false;

  constructor(opts: RepoWatcherOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 500;
    this.#onVersion = opts.onVersion;
  }

  /** Reconcile the watched set with `repos`: open new, close removed. */
  sync(repos: readonly string[]): void {
    if (this.#closed) return;
    const next = new Set(repos.map((repo) => path.resolve(repo)));
    for (const repo of [...this.#entries.keys()]) {
      if (!next.has(repo)) this.#closeEntry(repo);
    }
    for (const repo of next) {
      if (!this.#entries.has(repo)) this.#open(repo);
    }
  }

  version(repo: string): number {
    return this.#entries.get(path.resolve(repo))?.version ?? 0;
  }

  lastChangeAt(repo: string): number | null {
    return this.#entries.get(path.resolve(repo))?.lastChangeAt ?? null;
  }

  state(repo: string): RepoWatchState {
    const entry = this.#entries.get(path.resolve(repo));
    if (!entry) return { watched: false, version: 0, lastChangeAt: null };
    return { watched: true, version: entry.version, lastChangeAt: entry.lastChangeAt };
  }

  get watchedCount(): number {
    return this.#entries.size;
  }

  /** Close every watcher (repo removed / process exit). */
  closeAll(): void {
    for (const repo of [...this.#entries.keys()]) this.#closeEntry(repo);
    this.#closed = true;
  }

  #open(repo: string): void {
    const entry: WatchEntry = { version: 0, lastChangeAt: null, timer: null, closers: [] };
    this.#entries.set(repo, entry);

    const bump = (): void => {
      entry.lastChangeAt = Date.now();
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        entry.version += 1;
        try {
          this.#onVersion?.(repo, entry.version, entry.lastChangeAt ?? Date.now());
        } catch (err) {
          console.warn('[git-controls] watcher callback failed:', err);
        }
      }, this.debounceMs);
      // Never keep the process alive just for a pending debounce.
      entry.timer.unref();
    };

    const attach = (target: string, options: fs.WatchOptions): boolean => {
      try {
        const watcher = fs.watch(target, options, bump);
        watcher.on('error', (err) => {
          console.warn(`[git-controls] watch error for ${repo}:`, err);
          this.#closeEntry(repo);
        });
        entry.closers.push(() => {
          try {
            watcher.close();
          } catch {
            /* already closed */
          }
        });
        return true;
      } catch {
        return false;
      }
    };

    // Preferred: the whole work tree, recursively (macOS/Windows).
    if (attach(repo, { recursive: true })) return;

    // Fallback: watch the git metadata that changes on index/ref writes.
    const gitDir = resolveGitDir(repo);
    const targets = gitDir
      ? [
          path.join(gitDir, 'index'),
          path.join(gitDir, 'HEAD'),
          path.join(gitDir, 'refs'),
          path.join(gitDir, 'refs', 'heads'),
        ]
      : [];
    let any = false;
    for (const target of targets) {
      if (!fs.existsSync(target)) continue;
      if (attach(target, {})) any = true;
    }
    if (!any) {
      this.#entries.delete(repo);
      console.warn(`[git-controls] cannot watch ${repo}; version stays 0`);
    }
  }

  #closeEntry(repo: string): void {
    const entry = this.#entries.get(repo);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    for (const close of entry.closers) {
      try {
        close();
      } catch {
        /* ignore */
      }
    }
    this.#entries.delete(repo);
  }
}
