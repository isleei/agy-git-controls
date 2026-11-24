# Sidecar REST API 契约

UI ↔ 后端的全部通道。除 `/api/ping` 外一律 `POST` + JSON body（`window.sidecar.fetch` 自动带 token）。
`repo` 一律为 canonical 仓库根路径；后端只允许操作已注册（workspace 推送或用户添加）的仓库。

错误统一 `{ error: string, code?: string }`；写操作统一返回 `OperationResult{ok,stdout,stderr,code,conflicted?}`。
危险操作必须带 `confirmed: true` 字段，否则返回 `{ error:'confirm-required', action:'<name>' }` + HTTP 200（前端据此弹确认框后重发）。

| 端点 | 入参 | 返回 | 说明 |
|---|---|---|---|
| GET `/api/ping` | — | `{ok,ts,projectId}` | 健康检查 |
| `/api/context` | `{workspaceUris:string[]}` | `WorkspaceContext{workspaceUris,repos}` | UI 启动/切换时推送 host workspace |
| `/api/repos/list` | `{}` | `{repos:RepoInfo[],registered:string[]}` | workspace repos + 用户注册的 repos |
| `/api/repos/add` | `{path}` | `RepoInfo | {error}` | 校验 git work tree 后登记（持久化 PLUGIN_DATA） |
| `/api/repos/remove` | `{path}` | `{ok}` | 移除登记（不动磁盘） |
| `/api/status` | `{repo}` | `RepoStatus` | porcelain v2 状态 + operation |
| `/api/branches` | `{repo}` | `{branches:BranchInfo[]}` | 本地+远程，含 upstream/ahead/behind |
| `/api/branch/create` | `{repo,name,startPoint?,checkout?}` | Op | 创建（可同时切换） |
| `/api/branch/checkout` | `{repo,name}` | Op | 切换分支 |
| `/api/branch/rename` | `{repo,old,new}` | Op | |
| `/api/branch/delete` | `{repo,name,force?,confirmed}` | Op | 危险→confirmed |
| `/api/branch/set-upstream` | `{repo,branch,upstream:string|null}` | Op | null=unset |
| `/api/track-remote` | `{repo,remoteBranch,localName?}` | Op | 从远程分支建本地跟踪分支 |
| `/api/stage` | `{repo,paths[]}` | Op | |
| `/api/unstage` | `{repo,paths[]}` | Op | |
| `/api/stage-all` | `{repo}` | Op | |
| `/api/unstage-all` | `{repo}` | Op | |
| `/api/discard` | `{repo,paths[],staged?,deleteUntracked?,confirmed}` | Op | 危险→confirmed；untracked 需 deleteUntracked |
| `/api/diff` | `{repo,path?,staged?,ref?,ref2?,context?,maxBytes?}` | `DiffResult` | |
| `/api/commit` | `{repo,message,amend?,signoff?}` | Op | message 走 -m 数组 |
| `/api/fetch` | `{repo,remote?,all?,prune?}` | Op | timeout 120s |
| `/api/pull` | `{repo,mode:'ff'|'merge'|'rebase'}` | Op | 默认 ff-only |
| `/api/push` | `{repo,remote?,branch?,setUpstream?,forceWithLease?,confirmed?}` | Op | forceWithLease 需 confirmed |
| `/api/log` | `{repo,skip?,maxCount?,path?,query?}` | `LogPage` | Graph 数据源 |
| `/api/conflicts` | `{repo}` | `{files:string[],operation}` | |
| `/api/merge` | `{repo,branch,noFf?,squash?,confirmed?}` | Op | |
| `/api/rebase` | `{repo,onto,action?:'start'|'abort'|'continue'|'skip'}` | Op | |
| `/api/cherry-pick` | `{repo,shas[],action?:'start'|'abort'|'continue'}` | Op | |
| `/api/revert` | `{repo,shas[],noCommit?}` | Op | |
| `/api/stash` | `{repo,action:'push'|'apply'|'pop'|'drop'|'show',message?,includeUntracked?,index?,confirmed?}` | Op / `{entries:StashEntry[],text?}` | drop 需 confirmed |
| `/api/stashes` | `{repo}` | `{entries:StashEntry[]}` | |
| `/api/worktrees` | `{repo}` | `{worktrees:WorktreeInfo[]}` | |
| `/api/worktree/add` | `{repo,path,branch?,newBranch?,detached?}` | Op | |
| `/api/worktree/remove` | `{repo,path,force?,confirmed}` | Op | 危险→confirmed |
| `/api/remotes` | `{repo}` | `{remotes:RemoteInfo[]}` | |
| `/api/remote/add` | `{repo,name,url}` | Op | url 安全校验 |
| `/api/remote/remove` | `{repo,name,confirmed}` | Op | 危险→confirmed |
| `/api/tags` | `{repo}` | `{tags:TagInfo[]}` | |
| `/api/tag/create` | `{repo,name,ref?,message?,annotated?}` | Op | |
| `/api/tag/delete` | `{repo,name,confirmed}` | Op | 危险→confirmed |
| `/api/ai/send-to-conversation` | `{repo,kind:'diff'|'commit',ref?|paths?,prompt?}` | `{conversationId?}` | 唯一碰 Agent API 的端点；仅用户点击触发 |
| `/api/prefs` GET+POST | `{prefs?}` | 面板偏好持久化（PLUGIN_DATA） | 主题/布局/记住的 repo |

实现要点：handler 只做参数校验+调 `src/core`；写操作 core 内部已串行化；路径/分支名校验失败返回 `{error,code:'EINVAL'}`。
