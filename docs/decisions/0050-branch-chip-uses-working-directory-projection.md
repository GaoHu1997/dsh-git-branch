# 0050 — 分支 chip 改用 workingDirectory 投影取当前目录

日期: 2026-11-17
状态: 已接受

## 背景

输入框左侧的分支 chip 通过 `useSessions(state => state.byId[sessionId])?.cwd` 取目录，再用该目录跑 `git symbolic-ref` 决定显示哪个分支。

`byId[sessionId].cwd` 镜像的是 Session header 里的起始目录。header 在会话创建时写死，**不随 `working-directory/change` 更新**。因此：

- 用户用 `working_directory` 工具（或任何会发 `working-directory/change` 的入口）把会话切到 worktree 后，chip 仍指向原检出。
- chip 显示原检出的分支（如 `master`），而会话实际在 `fix/xxx` 上。
- 刷新页面无效——这条路径上没有缓存陈旧，只是取错了字段。
- 更严重的是 chip 上的分支操作（签出、推送、worktree 增删）都以这个错目录为作用对象。

DSH 已注册 `workingDirectory` 投影（`packages/session/working-directory`），语义正是「会话的有效目录」，由 `working-directory/change` 驱动，并通过标准 kit 的 `useProjection` 暴露给插件。本仓库此前完全没有使用它。

## 决策

- 新增 `resolveChipCwd(projectedCwd, headerCwd)`：优先返回 `useProjection('workingDirectory')`，为 `null`/`undefined` 时回退到 header 的 `cwd`。
- `BranchChipDock` 改为 `const cwd = resolveChipCwd(useProjection('workingDirectory'), summary?.cwd)`。
- 取目录的决策抽成导出的纯函数，让回归测试能覆盖它；仓库没有 jsdom，chip 的 effect 在 `renderToStaticMarkup` 下不运行，组件级断言只能得到一个空断言。

**被否决的备选**：

- 直接读 `ctx.sessions.list.getSnapshot().projectionsBySession[id].values.workingDirectory`（`GitHistoryPanel` 读 `modelSelection` 的方式）。可行，但要自己订阅 store、还要在 `panel-types.ts` 里补类型；`useProjection` 是框架给会话级 slot 的标准席位，reference 稳定性由框架保证，没有理由绕开。
- 让 chip 每次渲染前现场跑一次 `git rev-parse --show-toplevel` 推目录。多一次进程且与投影可能不一致，且需自己处理会话未就绪；投影本来就是权威值。
- 只改 npm 安装产物（`lib/client.js`）。能立刻生效，但仓库源码仍带缺陷，下游重新安装即复现，且不受类型检查与测试保护。

## 验证

- 新增 `tests/branch-chip-cwd.spec.ts`：投影优先、投影缺席回退 header、两者皆无时返回 `undefined`，共 3 条。
- `pnpm run typecheck` 通过；`pnpm test` 698 passed / 9 skipped，无既有用例回归。

## 影响

- 正面：会话切到 worktree 后 chip 显示真实分支，分支操作落到正确检出。
- 正面：`workingDirectory` 投影缺席时仍回退 header，未切换过目录的会话行为不变，首屏不会空白。
- 负面：chip 现在依赖 `workingDirectory` 投影可用；宿主未注册该校验 key 的极旧版本会一直走回退分支（行为与修复前一致，不产生新故障）。
- 负面：`resolveChipCwd` 是纯函数，组件里「用 `useProjection` 喂它」这一行本身没有被测试直接覆盖，靠 typecheck 与 jsx-order 用例兜底。
