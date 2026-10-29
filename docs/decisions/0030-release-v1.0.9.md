# 0030 — 发布 v1.0.9 补丁版本

状态：已接受

日期：2026-10-29

## 背景

自 v1.0.8 以来合入 0029（新增模型可见工具 `git_network`，在指定仓库目录执行一条白名单 git 网络子命令，并前置与面板路由完全相同的凭据头）。用户发起发版（版本号 +1），按 AGENTS.md 约定升号作为独立 chore 提交。

## 决策

将 `package.json` 的 `version` 从 `1.0.8` 升到 `1.0.9`，作为独立 chore 提交（与该提交一起带上本决策记录），推送 main 后打 `v1.0.9` tag 并推送，由 release 工作流（0010）校验 tag 与版本一致后发布 npm 并创建 GitHub Release。

被否决的备选：

- 把升号并进 0029 的功能提交——被否决：违反 AGENTS.md 的独立 chore 提交约定。
- 不打 tag，手动 npm publish 与创建 Release——被否决：release 工作流已承担校验、构建、发布与 Release 创建，手动操作绕过 `Match tag against package.json` 等防护。

## 影响

- 正面：npm 与 GitHub Releases 的 1.0.9 包含 0029 的 `git_network` 工具，AI 在会话内推送/拉取将以面板配置的账号发出，令牌不进入会话记录。
- 依赖：发布依赖仓库 secret `NPM_TOKEN`（见 0010），凭据失效会导致发布步骤失败但不产生半成品 Release。
