#!/usr/bin/env node
// Publish the built payload to the `release` branch so users can install with:
//   agy plugin install https://github.com/isleei/agy-git-controls/tree/release
// Usage: node scripts/release.mjs [--push]
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const payload = join(root, 'dist-plugin');
const push = process.argv.includes('--push');

const git = (args, cwd) =>
  execFileSync('git', args, { cwd: cwd ?? root, stdio: ['ignore', 'pipe', 'inherit'] })
    .toString()
    .trim();

execFileSync('node', [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });

const wt = mkdtempSync(join(tmpdir(), 'agc-release-'));
try {
  git(['worktree', 'add', '--detach', wt, 'origin/release']);
  for (const entry of ['LICENSE', 'README.md', 'assets', 'mcp', 'mcp_config.json', 'plugin.json', 'sidecars']) {
    rmSync(join(wt, entry), { recursive: true, force: true });
    cpSync(join(payload, entry), join(wt, entry), { recursive: true });
  }
  git(['add', '-A'], wt);
  const dirty = git(['status', '--porcelain'], wt);
  if (!dirty) {
    console.log('[release] already up to date');
  } else {
    const version = JSON.parse(readFileSync(join(payload, 'plugin.json'), 'utf8')).version;
    git(['commit', '-m', `release: v${version} payload`], wt);
    if (push) {
      git(['push', 'origin', 'HEAD:release'], wt);
      console.log('[release] pushed to origin/release');
    } else {
      console.log('[release] committed locally (dry run — pass --push to publish)');
    }
  }
} finally {
  git(['worktree', 'remove', '--force', wt]);
}
