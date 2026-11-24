#!/usr/bin/env node
/**
 * Build the plugin payload into dist-plugin/.
 *
 *  - esbuild: src/sidecar-backend/main.ts  -> dist-plugin/sidecars/git_controls/main.mjs
 *  - esbuild: src/mcp-server/index.ts      -> dist-plugin/mcp/git-server.mjs
 *  - vite:    src/ui/index.html            -> dist-plugin/sidecars/git_controls/ui/index.html (single file)
 *  - copies plugin.json, mcp_config.json, sidecar.json, assets, docs
 */
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-plugin');
const watch = process.argv.includes('--watch');

const sidecarDir = path.join(OUT, 'sidecars', 'git_controls');
fs.mkdirSync(path.join(sidecarDir, 'ui'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'mcp'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });

for (const f of ['plugin.json', 'mcp_config.json', 'README.md', 'LICENSE']) {
  if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
}
fs.copyFileSync(
  path.join(ROOT, 'sidecars', 'git_controls', 'sidecar.json'),
  path.join(sidecarDir, 'sidecar.json'),
);
if (fs.existsSync(path.join(ROOT, 'assets', 'logo.svg'))) {
  fs.copyFileSync(path.join(ROOT, 'assets', 'logo.svg'), path.join(OUT, 'assets', 'logo.svg'));
}

const common = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
};

await esbuild({
  ...common,
  entryPoints: [path.join(ROOT, 'src/sidecar-backend/main.ts')],
  outfile: path.join(sidecarDir, 'main.mjs'),
  external: ['sidecar_sdk'],
});

await esbuild({
  ...common,
  entryPoints: [path.join(ROOT, 'src/mcp-server/index.ts')],
  outfile: path.join(OUT, 'mcp', 'git-server.mjs'),
}).catch(() => {
  // MCP server is optional during early development; keep going if entry missing.
  if (!fs.existsSync(path.join(ROOT, 'src/mcp-server/index.ts'))) return;
  throw new Error('mcp-server build failed');
});

await viteBuild({
  root: path.join(ROOT, 'src/ui'),
  plugins: [react(), viteSingleFile()],
  logLevel: 'warn',
  build: {
    outDir: path.join(sidecarDir, 'ui'),
    emptyOutDir: true,
    minify: true,
    target: 'es2022',
  },
});

console.log(`[build] dist-plugin ready at ${OUT}`);
