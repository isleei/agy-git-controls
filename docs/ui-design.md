# UI 设计 — Git Controls 面板

参照 Orca Git Controls / VS Code Source Control / GitLens 的紧凑交互。**效率优先，杜绝后台管理系统风格**（不用大卡片、大圆角、无意义留白）。窄侧栏优先，同时可容纳在更宽的 FULL_PANE。

## 布局

```
┌──────────────────────────────┐
│ [repo ▾]        ⟳            │  顶栏：仓库选择器 + 刷新
│ [⎇ branch ▾] ↑2 ↓0  ⬇ ⬆ ↓  │  分支选择器、ahead/behind、Fetch/Pull/Push
├──────────────────────────────┤
│ Changes Branches History …   │  分区页签：Changes|Branches|History|Stash|Worktrees
├──────────────────────────────┤
│ <当前分区>                    │
└──────────────────────────────┘
```

- **顶栏**：repo 下拉（workspace repos 分组 + 已注册 + "Add repository…"）；分支下拉兼做 checkout/create；↑↓ 数可点击触发 fetch；Fetch/Pull/Push 为图标按钮（lucide: `arrow-down`, `arrow-up`, `refresh-cw`, `git-branch`）。
- **Changes**：顶部 commit 框（textarea + Commit + Amend checkbox）；分组折叠：Conflicts（红）、Staged、Changes、Untracked；行 = 状态字母彩标 + 文件名 + 路径（窄栏省略号）；hover 行内按钮：stage/unstage/discard/diff；点击行打开下方或覆盖层 Diff 视图。
- **Diff 视图**：unified 渲染（自绘，按 `@@` hunk 拆分、+/- 行着色）；顶部切换 unified/split（split 用双栏自绘对齐）；大文件截断提示"已截断 x%"；文件头显示状态与路径，rename 显示 old→new。
- **Branches**：搜索框；Local/Remote 两组；行含 upstream、↑↓、最后提交相对时间；hover 操作：Checkout、Rename、Delete、Set upstream、New branch from、Track remote；当前分支加粗+✓。
- **History**：提交列表 + 左侧 SVG 泳道图（按 parent 关系计算 lane 颜色，merge 节点双连线）；refs chips（HEAD 实色、branch、tag、remote、stash 虚线）；行：subject / author·相对时间 / short sha；点击展开详情（message 全文 + 文件列表 + 点文件看 diff）；底部"Load more"；顶部搜索（匹配 subject/author/sha）。
- **Stash**：条目 message·分支·时间；操作 Apply/Pop/Drop/Diff。
- **Worktrees**：path·branch·lock 状态；操作 Switch(设为当前 repo)/Remove/Add…。
- **右键菜单**：文件、分支、commit 行支持上下文菜单（浏览器 contextmenu 自绘浮层），放低频操作（cherry-pick、revert、copy sha、send to agent…）。
- **确认弹层**：删除分支/丢弃改动/force-push/删 worktree/删 remote/删 tag/drop stash → 统一 ConfirmDialog（操作名 + 目标 + 可选 force 勾选）；取消/确认按钮。
- **Toast**：写操作完成右下角浮条；失败显示 stderr 摘要 + "详情"展开。
- **进行中状态**：按钮 spinner、操作期间禁用相关按钮；后端返回 conflicted[] 时跳到 Conflicts 分区并提示 abort 入口。

## 主题与无障碍

- 全部颜色走 CSS 变量：`color: var(--foreground, #e6e6e6)` 等宿主注入 token；补充自有变量集（`--agc-added`/`--agc-deleted`/`--agc-accent`…）随宿主明暗切换。
- 键盘：分区页签 `Cmd/Ctrl+1..5`；`/` 聚焦各分区搜索；`Enter` 触发主按钮；`Esc` 关弹层；j/k 或方向键在文件列表移动（可选）。
- 列表虚拟化：History 用简单分页 + IntersectionObserver；文件列表超过 ~500 用等高虚拟滚动自绘（不引依赖）。

## 状态管理

纯 React（useState/useReducer/useContext），不引状态库。`api.ts` 集中所有端点调用 + 统一错误/`confirm-required` 处理；`useRepo` hook 管 active repo、status 轮询（可见时 5s + 手动刷新 + 操作后即时刷新）。

## AI 功能入口（P2，默认隐藏于菜单）

行级/详情级 "Send to Agent"：diff/commit 摘要经 `/api/ai/send-to-conversation` → `sidecar.agent.startConversation`。UI 上单独一节/菜单项，绝不自动触发。
