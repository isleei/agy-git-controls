/**
 * Git Controls sidecar entry point.
 *
 * Assembly only: SidecarApp + repo registry + fs watchers + REST routes +
 * the single-file UI page. All behaviour lives in `registry.ts`, `watch.ts`,
 * `routes.ts` and `src/core`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { RepoRegistry } from './registry.js';
import { registerApi } from './routes.js';
import { RepoWatcher } from './watch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(__dirname, 'ui', 'index.html');
const DEBOUNCE_MS = 500;

function log(...args: unknown[]): void {
  console.log('[git-controls]', ...args);
}

// The host restarts us (restart_policy=always), but a stray rejection should
// log and keep the panel alive instead of taking the whole sidecar down.
process.on('uncaughtException', (err) => {
  console.error('[git-controls] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[git-controls] unhandledRejection:', reason);
});

const app = new SidecarApp();

const dataDir =
  process.env.PLUGIN_DATA ?? path.join(os.tmpdir(), 'agy-git-controls-data');
if (!process.env.PLUGIN_DATA) {
  log(`PLUGIN_DATA is not set; using temporary state dir ${dataDir}`);
}

const registry = new RepoRegistry({ dataDir });
await registry.load();

const watcher = new RepoWatcher({ debounceMs: DEBOUNCE_MS });

let syncChain: Promise<void> = Promise.resolve();
function syncWatchers(): Promise<void> {
  syncChain = syncChain
    .then(async () => {
      const repos = await registry.listRepos();
      watcher.sync(repos.map((repo) => repo.path));
    })
    .catch((err) => {
      console.warn('[git-controls] watcher sync failed:', err);
    });
  return syncChain;
}

registry.subscribe(() => {
  void syncWatchers();
});
await syncWatchers();

// ---------- UI ----------

app.page('/', () => {
  if (!fs.existsSync(UI_FILE)) {
    return new Response('UI not built — run pnpm build', { status: 500 });
  }
  return new Response(fs.readFileSync(UI_FILE, 'utf-8'), { contentType: 'text/html' });
});

// ---------- REST ----------

registerApi(app, {
  registry,
  versionOf: (repo) => watcher.version(repo),
  agent: {
    startConversation: (message, opts) => app.startConversation(message, opts),
    ...(app.config.projectId !== undefined ? { projectId: app.config.projectId } : {}),
  },
});

// ---------- lifecycle ----------

process.once('exit', () => {
  watcher.closeAll();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log(`received ${signal}; shutting down`);
    watcher.closeAll();
    void app.close().finally(() => process.exit(0));
  });
}

try {
  await app.run();
  log(`ready (${watcher.watchedCount} repo watcher(s), data dir ${dataDir})`);
} catch (err) {
  console.error('[git-controls] failed to start:', err);
  watcher.closeAll();
  process.exitCode = 1;
}
