/**
 * Repository registry.
 *
 * Two kinds of repos are tracked:
 *   - workspace repos — pushed by the UI via `/api/context` (host workspace
 *     folders), persisted with the last push so the MCP process can read the
 *     same allowlist;
 *   - registered repos — added by the user via `/api/repos/add`, persisted to
 *     `${PLUGIN_DATA}/git-controls.json` together with the panel prefs.
 *
 * `resolveRepo` is the security gate for every `/api/*` handler: a path is
 * only accepted when its canonical form (or the work-tree root above it) is
 * one of the repos above.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGISTRY_FILE } from '../core/allowlist.js';
import { canonicalPath, findRepoRoot, repoInfoFor } from '../core/repo.js';
import type { RepoInfo, WorkspaceContext } from '../core/types.js';

export { REGISTRY_FILE };

/** Hard cap for the persisted prefs blob (JSON bytes). */
export const MAX_PREFS_BYTES = 256 * 1024;

/** Refuse to load absurdly large state files. */
const MAX_REGISTRY_BYTES = 1024 * 1024;

export interface RepoRegistryOptions {
  /** Directory holding git-controls.json — PLUGIN_DATA at runtime. */
  dataDir: string;
}

export interface PersistedRegistryState {
  registeredRepos: string[];
  /**
   * Repo roots from the last `/api/context` push. Persisted so the MCP
   * server (a separate process) can use the same allowlist.
   */
  workspaceRepos: string[];
  prefs: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Decode a host workspace URI (or an absolute path) to a local path. */
export function uriToLocalPath(uri: string): string | null {
  try {
    if (uri.startsWith('file://')) return fileURLToPath(uri);
    if (path.isAbsolute(uri)) return uri;
    return null;
  } catch {
    return null;
  }
}

/** `findRepoRoot` that also accepts a file path (probes its directory). */
async function findRepoRootForInput(inputPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(inputPath);
    if (stat.isFile()) return findRepoRoot(path.dirname(inputPath));
  } catch {
    /* missing path: fall through and let git fail */
  }
  return findRepoRoot(inputPath);
}

/** Cheap existence probe (no git) so deleted repos surface as ENOENT_REPO. */
async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export class RepoRegistry {
  readonly dataDir: string;
  readonly file: string;

  #workspacePaths: string[] = [];
  #workspaceRepos = new Map<string, RepoInfo>();
  #registered: string[] = [];
  #registeredSet = new Set<string>();
  #registeredInfo = new Map<string, RepoInfo | null>();
  #prefs: Record<string, unknown> = {};
  #listeners = new Set<() => void>();
  #writeChain: Promise<unknown> = Promise.resolve();
  #loaded = false;

  constructor(opts: RepoRegistryOptions) {
    this.dataDir = opts.dataDir;
    this.file = path.join(opts.dataDir, REGISTRY_FILE);
  }

  /** Load persisted registered repos + prefs. Missing/corrupt files are not fatal. */
  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;

    let raw: string | null = null;
    try {
      const stat = await fs.stat(this.file);
      if (stat.size <= MAX_REGISTRY_BYTES) raw = await fs.readFile(this.file, 'utf8');
      else console.warn('[git-controls] registry file is too large; ignoring it');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[git-controls] cannot read registry file:', err);
      }
    }
    if (raw === null) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn('[git-controls] registry file is not valid JSON; ignoring it:', err);
      return;
    }
    if (!isRecord(parsed)) return;

    if (Array.isArray(parsed.registeredRepos)) {
      const seen = new Set<string>();
      for (const entry of parsed.registeredRepos) {
        if (typeof entry !== 'string' || entry.length === 0 || entry.includes('\0')) continue;
        if (!path.isAbsolute(entry)) continue;
        const canonical = await canonicalPath(entry);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        this.#registered.push(canonical);
        this.#registeredSet.add(canonical);
      }
    }

    // Workspace repos persisted by the last /api/context push (shared with
    // the MCP server's allowlist). Missing dirs are simply not cached.
    if (Array.isArray(parsed.workspaceRepos)) {
      const seen = new Set<string>();
      for (const entry of parsed.workspaceRepos) {
        if (typeof entry !== 'string' || entry.length === 0 || entry.includes('\0')) continue;
        if (!path.isAbsolute(entry)) continue;
        const canonical = await canonicalPath(entry);
        if (seen.has(canonical) || this.#workspaceRepos.has(canonical)) continue;
        seen.add(canonical);
        const info = await repoInfoFor(canonical, 'workspace');
        if (info) this.#workspaceRepos.set(info.path, info);
      }
    }

    if (isRecord(parsed.prefs)) {
      const bytes = Buffer.byteLength(JSON.stringify(parsed.prefs), 'utf8');
      if (bytes <= MAX_PREFS_BYTES) this.#prefs = parsed.prefs;
      else console.warn('[git-controls] persisted prefs exceed the size limit; ignoring them');
    }

    for (const root of this.#registered) {
      this.#registeredInfo.set(root, await repoInfoFor(root, 'registered'));
    }
  }

  /* ---------------------------------------------------------------- */
  /* workspace                                                         */
  /* ---------------------------------------------------------------- */

  async setWorkspace(uris: readonly string[]): Promise<WorkspaceContext> {
    const paths: string[] = [];
    const seenPaths = new Set<string>();
    for (const uri of uris) {
      const local = uriToLocalPath(uri);
      if (local === null || seenPaths.has(local)) continue;
      seenPaths.add(local);
      paths.push(local);
    }

    const next = new Map<string, RepoInfo>();
    for (const local of paths) {
      const info = await repoInfoFor(local, 'workspace');
      if (info) next.set(info.path, info);
    }

    const changed =
      paths.length !== this.#workspacePaths.length ||
      paths.some((p, i) => p !== this.#workspacePaths[i]) ||
      next.size !== this.#workspaceRepos.size ||
      [...next.keys()].some((p) => !this.#workspaceRepos.has(p));

    this.#workspacePaths = paths;
    this.#workspaceRepos = next;
    if (changed) {
      // Keep the persisted allowlist in sync for the MCP server. A failure
      // must not take the panel down — the in-memory allowlist still works.
      try {
        await this.#persist();
      } catch (err) {
        console.warn('[git-controls] cannot persist workspace repos:', err);
      }
      this.#notify();
    }

    return { workspaceUris: paths, repos: [...next.values()] };
  }

  get workspacePaths(): string[] {
    return this.#workspacePaths.slice();
  }

  /* ---------------------------------------------------------------- */
  /* registered repos                                                  */
  /* ---------------------------------------------------------------- */

  /** Validate + persist a user-registered repo. Returns null when not a work tree. */
  async addRegistered(inputPath: string): Promise<RepoInfo | null> {
    const canonical = await canonicalPath(inputPath);
    const info = await repoInfoFor(canonical, 'registered');
    if (!info) return null;

    if (!this.#registeredSet.has(info.path)) {
      this.#registered.push(info.path);
      this.#registeredSet.add(info.path);
      this.#registeredInfo.set(info.path, info);
      await this.#persist();
      this.#notify();
    } else {
      // Refresh cached metadata (isWorktree may have changed).
      this.#registeredInfo.set(info.path, info);
    }

    return this.#workspaceRepos.has(info.path)
      ? { ...info, source: 'workspace' }
      : info;
  }

  async removeRegistered(inputPath: string): Promise<boolean> {
    const canonical = await canonicalPath(inputPath);
    let target: string | undefined;
    if (this.#registeredSet.has(canonical)) {
      target = canonical;
    } else {
      const root = await findRepoRootForInput(canonical);
      if (root !== null && this.#registeredSet.has(root)) target = root;
    }
    if (target === undefined) return false;

    this.#registered = this.#registered.filter((p) => p !== target);
    this.#registeredSet.delete(target);
    this.#registeredInfo.delete(target);
    await this.#persist();
    this.#notify();
    return true;
  }

  /** Persisted registered paths, in insertion order (may include missing dirs). */
  registeredPaths(): string[] {
    return this.#registered.slice();
  }

  /**
   * Resolve an input path to a known repo.
   * Accepts the canonical repo root, or any sub-path whose work-tree root is
   * already registered. Returns null otherwise.
   */
  async resolveRepo(inputPath: string): Promise<RepoInfo | null> {
    if (typeof inputPath !== 'string' || inputPath.length === 0) return null;
    const canonical = await canonicalPath(inputPath);

    const workspace = this.#workspaceRepos.get(canonical);
    if (workspace) return (await isDirectory(workspace.path)) ? workspace : null;
    const registered = await this.#registeredRepo(canonical);
    if (registered) return (await isDirectory(registered.path)) ? registered : null;

    // Sub-path: walk up to the work-tree root, then re-check the allowlists.
    const root = await findRepoRootForInput(canonical);
    if (root === null) return null;
    const workspaceRoot = this.#workspaceRepos.get(root);
    if (workspaceRoot) return (await isDirectory(root)) ? workspaceRoot : null;
    const registeredRoot = await this.#registeredRepo(root);
    return registeredRoot && (await isDirectory(root)) ? registeredRoot : null;
  }

  /** Workspace + registered repos, de-duplicated by canonical path. */
  async listRepos(): Promise<RepoInfo[]> {
    const out: RepoInfo[] = [];
    const seen = new Set<string>();
    for (const info of this.#workspaceRepos.values()) {
      if (seen.has(info.path)) continue;
      seen.add(info.path);
      out.push(info);
    }
    for (const root of this.#registered) {
      if (seen.has(root)) continue;
      const info = await this.#registeredRepo(root);
      if (!info || seen.has(info.path)) continue;
      seen.add(info.path);
      out.push(info);
    }
    return out;
  }

  /**
   * Cached RepoInfo for a registered root. A repo that was missing when the
   * registry was loaded is re-probed on demand (it may have been restored).
   */
  async #registeredRepo(root: string): Promise<RepoInfo | null> {
    if (!this.#registeredSet.has(root)) return null;
    const cached = this.#registeredInfo.get(root);
    if (cached) return cached;
    const info = await repoInfoFor(root, 'registered');
    this.#registeredInfo.set(root, info);
    return info;
  }

  /* ---------------------------------------------------------------- */
  /* prefs                                                             */
  /* ---------------------------------------------------------------- */

  getPrefs(): Record<string, unknown> {
    return structuredClone(this.#prefs);
  }

  async setPrefs(prefs: Record<string, unknown>): Promise<void> {
    if (!isRecord(prefs)) throw new Error('prefs must be an object');
    const json = JSON.stringify(prefs);
    if (Buffer.byteLength(json, 'utf8') > MAX_PREFS_BYTES) {
      throw new Error(`prefs exceed the ${MAX_PREFS_BYTES}-byte limit`);
    }
    this.#prefs = structuredClone(prefs);
    await this.#persist();
  }

  /* ---------------------------------------------------------------- */
  /* change notification / persistence                                 */
  /* ---------------------------------------------------------------- */

  /** Subscribe to repo-set changes (used to resync fs watchers). */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (err) {
        console.warn('[git-controls] registry listener failed:', err);
      }
    }
  }

  /** Atomic write (tmp + rename), serialized so concurrent saves never interleave. */
  #persist(): Promise<void> {
    const state: PersistedRegistryState = {
      registeredRepos: this.#registered.slice(),
      workspaceRepos: [...this.#workspaceRepos.keys()],
      prefs: structuredClone(this.#prefs),
    };
    const json = JSON.stringify(state, null, 2);

    const write = async (): Promise<void> => {
      await fs.mkdir(this.dataDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, json, { encoding: 'utf8', mode: 0o600 });
      try {
        await fs.rename(tmp, this.file);
      } catch (err) {
        await fs.unlink(tmp).catch(() => undefined);
        throw err;
      }
    };

    const run = this.#writeChain.then(write, write);
    this.#writeChain = run.catch(() => undefined);
    return run;
  }
}
