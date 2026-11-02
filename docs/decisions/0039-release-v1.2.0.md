# 0039 — 发布 v1.2.0 次版本

状态：已接受

日期：2026-11-02

## 背景

自 v1.1.0 合入 0037（凭据管理直接读写本机 `~/.git-credentials`，经 `~/.gitconfig` 的 URL 作用域 include 生效，取代 0021 的存储位置与 0034 的环境注入通道）与 0038（从本机凭据导入并在启动时默认接管，面板新增 `POST /credentials-import` 入口）。用户发起升号到 v1.2.0，按 AGENTS.md 约定作为独立 chore 提交。版本从 1.1.0 跨到 1.2.0：本次全是新功能（本机凭据后端 + 本机导入），非补丁，故升次版本。

## 决策

将 `package.json` 的 `version` 从 `1.1.0` 升到 `1.2.0`，作为独立 chore 提交（与该提交一起带上本决策记录）。验证：`pnpm test` 33 文件 637 测试全过（含真实 `git` 端到端回归 `shell-bridge-e2e` 与新文件 `local-import`）、`typecheck`、`build:all` 全绿。推送 main 并打 tag `v1.2.0` 后，由 release 工作流（0010）校验 tag 与版本一致后发布 npm 与 GitHub Release。随包附带 `CHANGELOG.md` 作为 npm 版本日志（纳入 `package.json` 的 `files`），1.2.0 段落说明本次升级内容：凭据直接管理本机文件、启动时自动导入本机凭据、注入通道换 git 原生 include 机制、删除自研 bridge helper。

被否决的备选：

- 把升号并进 0037/0038 的功能提交——被否决：违反 AGENTS.md 的独立 chore 提交约定。
- 版本号用 `1.1.1`——被否决：本次无修复而是纯新功能（本机凭据后端与本机导入），按语义化版本升次版本。

## 影响

- 正面：npm 与 GitHub Releases 的 v1.2.0 包含本机凭据后端与本机导入功能，面板存一次凭据任何 shell 都生效，新机器打开插件即自动对齐本机账号，`gh`/GCM/store 的账号一次导入即可接管。
- 反面：升号本身无运行时行为变化；令牌明文落 `~/.git-credentials`（0600）的取舍随 0037 生效，与 git 自带 `store` helper 一致。
- 依赖：发布依赖仓库 secret `NPM_TOKEN`（0010）；tag 与版本不一致会被 release 工作流拦下，不产生半成品 Release。
