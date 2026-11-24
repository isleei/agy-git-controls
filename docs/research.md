# 技术调研记录 — Antigravity 扩展机制与能力边界

调研日期：2026-11-24。验证环境：macOS ARM64，Antigravity App **2.35.0**（另装 2.34.0）、Antigravity IDE 2.7.0、`agy` CLI 1.5.13。

## 结论：选用 Sidecar Web UI 为主机制 + MCP server 为辅

| 机制 | 官方性 | 适合本项目的点 | 限制 |
|---|---|---|---|
| **Sidecar + Web UI**（`sidecar.json` → `has_web_ui` + `ui_config.views`） | 官方机制（docs/sidecars；`sidecar_sdk` 随 App 分发 `~/.gemini/antigravity/lib/node_modules/`；内置插件 `swarm`、第三方插件 `agy-monitor` 同款用法实测运行） | 常驻 AUX_PANE 面板；后端是普通 Node 进程可跑 git CLI/文件监听；宿主推送 workspace 与主题；`sidecar.agent.*` 直连 Agent API | Web UI 字段（`has_web_ui`/`ui_config`/`agent_permissions`）未写进 sidecar.json 文档 schema（但官方插件在用）；iframe 无持久存储、无 teardown 通知 |
| MCP Apps（`ui://` + `com.google.antigravity/ui` entrypoints） | 官方机制（docs/mcp-apps，App ≥2.34.0） | 标准协议、aux_pane/global/file 三种面 | view 绑定 tool；iframe 默认拒绝；每 view 4 并发 tools/call；tool result 1MiB 持久化上限；HTML ≤10MiB；无 teardown；side pane 页签绑定 (server,tool) |
| Lifecycle hooks / skills / rules / subagents | 官方 | 可做提交信息约定等 | 不是 UI 机制 |

**决策**：Git 管理面板是常驻、高频、数据密集的工具，Sidecar Web UI 明显优于 MCP Apps（无并发/尺寸/绑定限制、可直接长驻监听仓库），且规格允许「其他正式插件扩展机制」。`mcp_config.json` 仍附带一个 MCP server，把同一套 `src/core` git 能力暴露给 Agent（满足"Git 操作经本地 MCP Server"与 P2 集成）。

## 已实测验证的事实（非文档转述）

1. 插件实体 = `~/.gemini/config/plugins/<name>/` 目录（plugin.json + mcp_config.json + sidecars/<id>/sidecar.json）。文件同步进去即被 App 识别，`agy plugin list` 显示 enabled，`agy plugin validate --strict` 通过（报告 mcpServers/sidecars 计数）。
2. Sidecar 被 App 自动注册到 `~/.gemini/config/config.json` 的 `sidecars.<plugin>/<id>`（含 projectId/resolvedPermissions/schemaVersion），并自动拉起进程（`Antigravity Helper --import=.../sidecar_sdk/register_loader.js main.mjs`，cwd=sidecar 目录，restart_policy=always 生效——kill 后自动重启换端口）。
3. `SidecarApp` 注入环境变量：`ANTIGRAVITY_LS_ADDRESS`/`ANTIGRAVITY_CSRF_TOKEN`/`ANTIGRAVITY_SIDECAR_WEB_PORT`/`ANTIGRAVITY_SIDECAR_UI_TOKEN`/`ANTIGRAVITY_PROJECT_ID`/`ANTIGRAVITY_CONVERSATION_ID`/`ANTIGRAVITY_AGENTAPI_EXE`/`PLUGIN_DATA`。`app.page()`/`app.api()`/`app.run()` 绑定 127.0.0.1；GET 免 token，非 GET 需 `X-Sidecar-Token`（前端 `window.sidecar.fetch` 自动带）。
4. 面板入口：侧栏 `+` → 搜索/Plugins 菜单中出现插件名，点击开页签（`Sidecar View` 容器内挂 iframe），与 AGY 控制台并存多页签。隐藏的 view 帧在内存保活——改 UI 后要么等 LRU 淘汰，要么重启 sidecar 进程/应用来强制重载（开发期注意）。
5. `window.sidecar.getWorkspaceUris()` 由宿主推送 workspace 文件夹 URI；`onWorkspaceChange` 监听切换。Agent API 的 `get-conversation-metadata` 额外返回 `workspaces[].gitRootAbsoluteUri`、`repository.gitOriginUrl`、`branchName`（见 sidecar_data events 日志）——仓库识别可双通道。
6. `window.sidecar.agent.startConversation/sendMessage/getConversationMetadata` 经 `agentapi` 子命令走通，`ANTIGRAVITY_AGENTAPI_EXE` 提供二进制路径。
7. 主题：宿主 `theme-change` postMessage 把 CSS 变量写到 iframe documentElement（`--background`/`--foreground` 等）。
8. iframe 为 opaque origin：UI 必须单文件（inlined JS/CSS，`vite-plugin-singlefile` 实测可跑），不能用 Cookie/localStorage/外链 CDN。
9. 面板中已完成真实链路：workspace URI → `rev-parse --show-toplevel` → `status --porcelain=v2 --branch` → 渲染分支/upstream/ahead/behind/变更数。
10. Antigravity IDE（2.7.0）不渲染任何 Web UI（MCP Apps 只跑纯文本工具）；Sidecar Web UI 同样是 App-only。**目标宿主 = Antigravity App ≥2.34.0**。

## 与规格的出入（已按"官方允许的替代方案"处理并记录）

- 规格写"所有 Git 操作通过本地 MCP Server 完成" → 实现为：面板走 sidecar REST（官方机制、零 Token）；同一 `src/core` 同时被 `mcp/git-server.mjs` 复用暴露给 Agent 的 MCP 工具。意图（本地执行、不耗 Token、官方扩展点）完全保留。
- `getWorkspaceUris` 推到 iframe 而非后端进程：后端不能自己得知 workspace，因此协议是 UI 先 `getWorkspaceUris()` → `POST /api/context` 注册到后端；后端再校验这些路径的 git 归属。后端不可信路径来源，仍做 realpath + git 归属校验。

## 待验证/风险

- **跨进程写锁未实现（已知降级）**：`src/core/locks.ts` 只提供进程内互斥，sidecar 后端与 MCP server（stdio，独立进程）各自持有一份队列。当前 MCP 仅暴露只读工具，写工具只走面板确认的 REST 路径，因此暂不引入 `PLUGIN_DATA` 下的文件锁；新增 MCP 写工具前必须补跨进程锁。
- `SIDECAR_UI_ENTRYPOINT_SIDEBAR`/`FULL_PANE` 枚举存在（language_server 二进制字符串），未实测；AUX_PANE 已实测。
- Sidecar 视图跟随"当前会话"还是全局常驻：ui_config.views 目前一个 `/` 面板；多项目切换时 workspace push 是否随会话项目变化——`onWorkspaceChange` 已接，实测时确认。
- `agy plugin install <dir>` 与手动同步到 plugins 目录的等价性（install 可能额外做 registry 记录）；分发优先走官方 `agy plugin install` / Marketplace。
