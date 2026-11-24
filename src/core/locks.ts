/**
 * Per-repository write serialization.
 *
 * Every write operation in `ops.ts` runs inside `withRepoLock`, so two UI
 * requests for the same work tree can never mutate it at the same time.
 * Reads never take the lock.
 *
 * The lock key is the realpath (symlinks resolved) with case folded on the
 * platforms whose default volumes are case-insensitive, so `/tmp/x`,
 * `/private/tmp/x` (macOS) and `/Repo` vs `/repo` share one queue.
 *
 * Known downgrade (not implemented here): this is an in-process mutex only.
 * The MCP server is a separate stdio process with its own queue, so a MCP
 * call could still race a panel write. That is acceptable today because the
 * MCP server exposes read-only tools; write tools are restricted to the
 * panel-confirmed REST path. A cross-process lock under PLUGIN_DATA would be
 * required before adding MCP write tools.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Tail of the pending queue per repo key. */
const tails = new Map<string, Promise<unknown>>();

const CASE_INSENSITIVE_PLATFORM = process.platform === 'darwin' || process.platform === 'win32';

async function lockKey(repo: string): Promise<string> {
  let key: string;
  try {
    key = await fs.realpath(repo);
  } catch {
    key = path.resolve(repo);
  }
  return CASE_INSENSITIVE_PLATFORM ? key.toLowerCase() : key;
}

/**
 * Run `fn` after every previously queued operation for `repo` settled.
 * A failed operation does not poison the queue: later work still runs.
 */
export async function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const key = await lockKey(repo);
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
