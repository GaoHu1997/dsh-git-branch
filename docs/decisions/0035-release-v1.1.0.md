# 0035 — 发布 v1.1.0 次版本

状态：已接受

日期：2026-11-02

## 背景

自 v1.0.10 合入 0034（shell 凭据桥改用 `GIT_CONFIG_GLOBAL` 会话配置，修掉 DSH 宿主环境清洗把 `GIT_CONFIG_KEY_*` 半剥离导致的每条 `git` 命令 `fatal`，并把凭据入口收敛到 `createCredentialService`）。用户发起升号到 v1.1.0，按 AGENTS.md 约定作为独立 chore 提交。版本从 1.0.x 跨到 1.1.0：既有 bug 修复（shell 凭据桥通道），也有内部结构收敛（凭据服务），非纯补丁，故升次版本。

## 决策

将 `package.json` 的 `version` 从 `1.0.10` 升到 `1.1.0`，作为独立 chore 提交（与该提交一起带上本决策记录）。验证：`pnpm test` 32 文件 608 测试全过（含新增的真实 `git` 端到端回归 `shell-bridge-e2e`）、`typecheck`、`build` 全绿。推送 main 并打 tag `v1.1.0` 后，由 release 工作流（0010）校验 tag 与版本一致后发布 npm 与 GitHub Release。随包附带 `CHANGELOG.md` 作为 npm 版本日志（纳入 `package.json` 的 `files`），在 npm 包与 GitHub Release 里说明本次升级内容。

被否决的备选：

- 把升号并进 0034 的功能提交——被否决：违反 AGENTS.md 的独立 chore 提交约定。
- 版本号用 `1.0.11`——被否决：本次含凭据服务的结构收敛与注入通道切换，非纯补丁，按语义化版本升次版本。

## 影响

- 正面：npm 与 GitHub Releases 的 v1.1.0 包含修复后的 shell 凭据桥与凭据服务，宿主派生 shell 里 `git` 不再 `fatal`、按域名命中面板令牌，未配置域名快速失败。
- 反面：升号本身无运行时行为变化；行为变化来自 0034，其「全局清空 helper 链使未配置域名直接失败」的取舍随 v1.1.0 一并生效。
- 依赖：发布依赖仓库 secret `NPM_TOKEN`（0010）；tag 与版本不一致会被 release 工作流拦下，不产生半成品 Release。
