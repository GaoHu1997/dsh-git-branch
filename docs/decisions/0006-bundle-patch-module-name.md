# 0006 — bundle patch 必须使用可解析的 npm 包名

日期: 2026-09-30
状态: 已接受

## 背景

`git-worktree` 是插件在 UI 中使用的入口行 ID 和功能命名空间，不是已安装的 npm 包名。DSH loader 会直接按 bundle patch 的 `name` 导入 host 模块；此前 patch 写入 `git-worktree` 时，profile 中实际安装的包 `@gaohu9712/dsh-git-branch` 无法被解析，启动时出现 `1 entry did not activate git-worktree (git-worktree): failed to import`。

## 决策

`cordis.patch.yml` 中 host loader entry 的 `name` 固定使用可由 Node 解析的包名 `@gaohu9712/dsh-git-branch`。`git-worktree` 只继续作为 loader entry 的 `id`、设置命名空间和 HTTP 路由前缀使用。

## 理由

- loader 的 `name` 是模块导入目标，必须与安装包的 package name 或可解析子路径一致。
- `id` 是 Cordis loader entry 的稳定标识，可以与 npm 包名不同；把 UI/功能名误当成模块名会在激活阶段失败。
- 使用 scoped package name 与 `package.json`、`exports` 和 profile 的 `link:` 依赖保持一致，不需要修改版本号或引入额外的别名包。

## 验证

修复后应验证 `cordis.patch.yml` 解析出的 `name` 为 `@gaohu9712/dsh-git-branch`，该包可解析到 `lib/index.js`，并通过构建、类型检查和测试。实际 DSH profile 的重启/启用由用户在确认新包已安装后执行。

## 影响

已有的 `git-worktree` entry ID、客户端 key、设置 namespace 与路由路径不变；只修正 host 模块的导入目标。
