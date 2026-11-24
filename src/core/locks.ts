/**
 * Per-repository write serialization.
 *
 * Every write operation in `ops.ts` runs inside `withRepoLock`, so two UI
 * requests (or an MCP tool call racing a panel click) can never mutate the
 * same work tree at the same time. Reads never take the lock.
 */
import path from 'node:path';

/** Tail of the pending queue per repo key. */
const tails = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every previously queued operation for `repo` settled.
 * A failed operation does not poison the queue: later work still runs.
 */
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repo);
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
