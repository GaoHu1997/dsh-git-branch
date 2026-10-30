# 0033 — 发布 v1.0.10 补丁版本

状态：已接受

日期：2026-10-30

## 背景

自 v1.0.9 以来合入 0032（shell 里的 `git push` 也走插件密钥：宿主进程用 `GIT_CONFIG_*` 环境变量装一个按域名作用域的 credential helper，并清空机器 helper 链让未配置域名快速失败）。这条改动只有发到 npm、被 profile 更新后才真正生效——安装目录里的 1.0.9 里没有 `lib/shell-bridge.js`，运行中的插件仍在弹 GCM 凭据对话框。用户发起发版（版本号 +1），按 AGENTS.md 约定升号作为独立 chore 提交。

## 决策

将 `package.json` 的 `version` 从 `1.0.9` 升到 `1.0.10`，作为独立 chore 提交（与该提交一起带上本决策记录），推送 main 后打 `v1.0.10` tag 并推送，由 release 工作流（0010）校验 tag 与版本一致后发布 npm 并创建 GitHub Release。

冒烟验证用的探针确认了三件事，都写进 0032：已配置域名命中 `username=oauth2`（107ms）、未配置域名 28ms 内 exit 128、全局 `credential.helper` 空值是必需项。

被否决的备选：

- 把升号并进 0032 的功能提交——被否决：违反 AGENTS.md 的独立 chore 提交约定。
- 只推 main 不打 tag——被否决：release 工作流是唯一发布通道，不打 tag 就没有 npm 与 Release。
- 跳过 CI 直接发——被否决：`.github/workflows/ci.yml` 的 verify 任务与 release 里的 typecheck/test/build 是发现打包遗漏（`files` 只含 `lib`，新增的 `lib/helpers/` 必须随编译产出）的第一道闸。

## 影响

- 正面：npm 与 GitHub Releases 的 1.0.10 包含 0032 的环境桥，AI 与用户在 shell 里 `git push` 都会用面板里的令牌；未配置域名不再弹凭据对话框。
- 反面：全局 `credential.helper` 清空使宿主派生的 shell 不再使用机器 GCM 凭据，Gitee 等未在面板配置的域名会直接失败，详见 0032 的「影响」。
- 依赖：发布依赖仓库 secret `NPM_TOKEN`（见 0010），凭据失效会导致发布步骤失败但不产生半成品 Release。
