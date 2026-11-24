#!/usr/bin/env node
/**
 * Sync dist-plugin/ into ~/.gemini/config/plugins/agy-git-controls.
 * Preserves nothing user-editable lives under the managed paths.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'dist-plugin');
const TARGET = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agy-git-controls');

if (!fs.existsSync(path.join(SRC, 'plugin.json'))) {
  console.error('dist-plugin missing — run `pnpm build` first.');
  process.exit(1);
}

// Replace managed payload paths, keep the plugin dir itself.
for (const rel of ['plugin.json', 'mcp_config.json', 'README.md', 'LICENSE']) {
  fs.mkdirSync(TARGET, { recursive: true });
  if (fs.existsSync(path.join(SRC, rel))) {
    fs.copyFileSync(path.join(SRC, rel), path.join(TARGET, rel));
  }
}
for (const rel of ['sidecars', 'mcp', 'assets']) {
  const from = path.join(SRC, rel);
  const to = path.join(TARGET, rel);
  fs.rmSync(to, { recursive: true, force: true });
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
}

console.log(`[install] synced to ${TARGET}`);
try {
  const out = execFileSync('agy', ['plugin', 'validate', TARGET, '--strict'], { encoding: 'utf-8' });
  console.log(out.trim());
} catch (e) {
  console.log(`[install] agy validate: ${e.stdout?.trim() || e.message}`);
}
console.log('[install] Restart Antigravity (or toggle the sidecar) to pick up changes.');
