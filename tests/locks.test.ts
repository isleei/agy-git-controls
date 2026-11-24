import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withRepoLock } from '../src/core/locks.js';
import { makeTempDir } from './helpers.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('withRepoLock', () => {
  it('serializes work for the same repo', async () => {
    const order: string[] = [];
    const repo = '/tmp/agy-git-lock-test-same';

    const first = withRepoLock(repo, async () => {
      order.push('a-start');
      await delay(40);
      order.push('a-end');
      return 'a';
    });
    const second = withRepoLock(repo, async () => {
      order.push('b-start');
      await delay(1);
      order.push('b-end');
      return 'b';
    });

    await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b']);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('does not block a different repo', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const held = withRepoLock('/tmp/agy-git-lock-test-r1', async () => {
      await gate;
      return 1;
    });
    const other = await Promise.race([
      withRepoLock('/tmp/agy-git-lock-test-r2', async () => 2 as const),
      delay(500).then(() => 'blocked' as const),
    ]);

    expect(other).toBe(2);
    release();
    await expect(held).resolves.toBe(1);
  });

  it('keeps the queue usable after a failure', async () => {
    const repo = '/tmp/agy-git-lock-test-fail';
    const failing = withRepoLock(repo, async () => {
      throw new Error('boom');
    });
    const after = withRepoLock(repo, async () => 'ok');

    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
  });

  it('treats a symlinked path and its target as the same repo', async () => {
    const real = await makeTempDir('agy-git-lock-real-');
    tempDirs.push(real);
    const link = path.join(real, '..', `${path.basename(real)}-link`);
    tempDirs.push(link);
    await fs.symlink(real, link);

    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const held = withRepoLock(real, async () => {
      await gate;
      return 'real';
    });
    // Give the first callback time to reach the gate.
    await delay(50);
    const blocked = await Promise.race([
      withRepoLock(link, async () => 'link'),
      delay(300).then(() => 'blocked' as const),
    ]);
    expect(blocked).toBe('blocked');

    release();
    await expect(held).resolves.toBe('real');
    await expect(withRepoLock(link, async () => 'after')).resolves.toBe('after');
  });
});
