#!/usr/bin/env node
/** Pack dist-plugin into a versioned zip for distribution. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'dist-plugin');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'plugin.json'), 'utf-8'));
const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const zip = path.join(outDir, `${manifest.name}-${manifest.version}.zip`);

fs.rmSync(zip, { force: true });
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', SRC, zip], { stdio: 'inherit' });
console.log(`[pack] ${zip}`);
