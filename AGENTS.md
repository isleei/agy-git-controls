# AGENTS.md — agy-git-controls

Visual Git management plugin for Google Antigravity (the **App**, v2.34.0+), MIT-licensed.

## Hard rules (non-negotiable)

- **No invasive implementation.** Never modify Antigravity app files, `app.asar`, inject JS, monkey-patch, use CDP/Electron debug to reach into the host, or break code signing. Only official extension mechanisms: **sidecars** (primary UI surface) and **MCP servers** (`mcp_config.json`).
- **Git only via structured args.** `node:child_process.execFile`/`spawn` with argument arrays. Never concatenate a shell command string. Never expose arbitrary command execution.
- **Path safety.** All repo paths validated through `src/core` repo-resolution (realpath + registry/workspace allowlist). No operations on paths the user/workspace did not register. No path traversal.
- **Dangerous ops need explicit confirmation** at the API layer (`confirm: true` + a `confirmToken` naming the action). Forbidden server-side endpoints: `git reset --hard`, `git clean -fd`, force-push without `--force-with-lease`, deleting lock files, killing git processes.
- **Serialize writes per repo** through the repo mutex in `src/core/locks.ts`. Re-check status before write ops; never act on stale state.
- **No secrets.** Never log tokens, credentials, or auth headers. Honor the user's existing git credential helpers/SSH agent — never read or store them.
- **Regular git ops spend zero AI tokens.** The panel calls the sidecar REST API only. `window.sidecar.agent.*` may only be invoked by an explicit user click on an AI feature.

## Architecture

```
plugin.json                  AGY plugin manifest
mcp_config.json              optional MCP server (agent-facing git tools)
sidecars/git_controls/
  sidecar.json               sidecar manifest: has_web_ui, AUX_PANE entrypoint
src/
  core/                      pure git logic shared by backend + MCP server
    git.ts                   execFile runner (timeout, AbortSignal, no shell)
    repo.ts                  discovery, status (porcelain v2), branches, worktrees
    ops.ts                   stage/commit/sync/merge/rebase/stash/tag/remote
    locks.ts                 per-repo write serialization
    types.ts                 API DTOs shared with the UI
  sidecar-backend/
    main.ts                  SidecarApp entry (import { SidecarApp } from 'sidecar_sdk')
    routes.ts                /api/* REST -> core
    registry.ts              known repos + prefs persisted under PLUGIN_DATA
    watch.ts                 fs watchers (debounced) -> repo-change events
  mcp-server/index.ts        stdio MCP server wrapping core (bundled, no node_modules)
  ui/                        React 19 SPA -> vite-plugin-singlefile -> one HTML
tests/                       vitest; integration tests use temp git repos only
scripts/build.mjs            esbuild backend/mcp bundles + vite UI build -> dist-plugin/
scripts/install.mjs          sync dist-plugin -> ~/.gemini/config/plugins/agy-git-controls
```

The UI never talks to git directly: UI → `window.sidecar.fetch('/api/…')` → backend → `src/core` → `git` CLI. The MCP server reuses the same `src/core` entry points for agent calls.

## Sidecar contract (verified on AGY App 2.34/2.35)

- `import { SidecarApp, Response } from 'sidecar_sdk'` — keep the specifier bare; the host's `register_loader.js` resolves it. Mark `sidecar_sdk` external when bundling.
- Env present at runtime: `ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`, `ANTIGRAVITY_SIDECAR_WEB_PORT`, `ANTIGRAVITY_SIDECAR_UI_TOKEN`, `ANTIGRAVITY_PROJECT_ID`, `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_AGENTAPI_EXE`, `PLUGIN_DATA`, `ANTIGRAVITY_EXECUTABLE_DATA_DIR`.
- `app.page(path, () => html)` serves pages/GET assets; `app.api(path, handler, 'GET'|'POST')` registers JSON routes; `app.run()` binds 127.0.0.1 on the injected port. Non-GET requests need `X-Sidecar-Token` (use `window.sidecar.fetch`, it injects it).
- Frontend bridge (`window.sidecar`): `fetch`, `getWorkspaceUris(): Promise<string[]>`, `onWorkspaceChange(fn)`, `conversationId`, `agent.sendMessage/startConversation/getConversationMetadata`, `ui.toggleAuxPane/toggleConversation/addArtifactComment`, `auth.requestCredentialRefresh`.
- Host pushes `theme-change` CSS variables onto `document.documentElement` — style the UI with `var(--…)` tokens, provide fallbacks.
- The iframe origin is opaque (`null`); serve the UI as a **single self-contained HTML** (inlined JS/CSS). Do not rely on ES-module `<script type="module">`, external CDNs, cookies, or localStorage (use PLUGIN_DATA via API).
- `ANTIGRAVITY_AGENTAPI_EXE` + `agentapi` subcommand is the supported way to reach the agent (P2 AI features).

## Commands

```bash
pnpm install          # deps (network required — Codex sandbox has none)
pnpm build            # -> dist-plugin/ (plugin payload)
pnpm typecheck
pnpm test             # vitest (temp repos only — never a real user repo)
pnpm install-plugin   # sync dist-plugin -> ~/.gemini/config/plugins/agy-git-controls
agy plugin validate ./dist-plugin --strict
node scripts/release.mjs --push   # build + publish payload to the `release` branch
                                  # (user install: agy plugin install …/tree/release)
```

## Testing rules

- Unit + integration tests must create their own temp repos (`git init` under `os.tmpdir()`); never touch real repos.
- Cover: detached HEAD, fresh repo (no commits), merge conflict state, worktrees, staged/unstaged/untracked, rename detection.
- Keep UI free of business logic; parsing and safety checks live in `src/core` and `src/sidecar-backend`.

## Known platform limits (verified)

- MCP Apps `ui://` surfaces render only in the Antigravity **App** ≥2.34.0 — the **IDE** runs bundled MCP tools as plain text, no UI. Sidecar web UI is App-only too.
- Sidecar iframe: no teardown notification, no persistent browser storage.
- `agy` CLI plugin lifecycle: `agy plugin validate|install|list|enable|disable|uninstall`.
