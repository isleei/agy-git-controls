/**
 * Repository allowlist shared by every entry point (sidecar REST already
 * resolves through `RepoRegistry`; this is the core-level gate for the MCP
 * server, which runs as a separate process).
 *
 * The source of truth is the registry file the sidecar writes under
 * PLUGIN_DATA (`git-controls.json`): `registeredRepos` plus the workspace
 * repos last pushed via `/api/context`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const REGISTRY_FILE = 'git-controls.json';

const MAX_REGISTRY_BYTES = 1024 * 1024;
const CASE_INSENSITIVE_PLATFORM = process.platform === 'darwin' || process.platform === 'win32';

export interface AllowedRepoOptions {
  /** Additional absolute repo roots (tests, future config). */
  extraAllowed?: readonly string[];
  /** Override the registry directory (defaults to PLUGIN_DATA). */
  dataDir?: string;
}

/** Same PLUGIN_DATA resolution the sidecar backend uses. */
export function registryDataDir(): string {
  return process.env.PLUGIN_DATA ?? path.join(os.tmpdir(), 'agy-git-controls-data');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function foldCase(value: string): string {
  return CASE_INSENSITIVE_PLATFORM ? value.toLowerCase() : value;
}

async function readPersistedRoots(dataDir: string): Promise<string[]> {
  const file = path.join(dataDir, REGISTRY_FILE);
  let raw: string;
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_REGISTRY_BYTES) return [];
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const roots: string[] = [];
  for (const key of ['registeredRepos', 'workspaceRepos'] as const) {
    const list = parsed[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== 'string' || entry.length === 0 || entry.includes('\0')) continue;
      if (!path.isAbsolute(entry)) continue;
      roots.push(entry);
    }
  }
  return roots;
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(path.resolve(target));
  } catch {
    return null;
  }
}

/**
 * True when `target` (a repo root or any path inside one) belongs to a repo
 * registered in PLUGIN_DATA or supplied via `extraAllowed`.
 *
 * Fails closed: missing/corrupt registry, missing target or a path that only
 * shares a string prefix (`/tmp/repo-evil` vs `/tmp/repo`) are all rejected.
 */
export async function isAllowedRepo(
  target: string,
  opts: AllowedRepoOptions = {},
): Promise<boolean> {
  if (typeof target !== 'string' || target.length === 0 || target.includes('\0')) return false;
  const real = await realpathOrNull(target);
  if (real === null) return false;
  const wanted = foldCase(real);

  const candidates = [...(opts.extraAllowed ?? []), ...(await readPersistedRoots(opts.dataDir ?? registryDataDir()))];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
    const root = await realpathOrNull(candidate);
    if (root === null) continue;
    const folded = foldCase(root);
    if (wanted === folded || wanted.startsWith(`${folded}${path.sep}`)) return true;
  }
  return false;
}
