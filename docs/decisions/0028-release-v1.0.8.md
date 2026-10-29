# 0028 — 发布 v1.0.8 补丁版本

状态: 已接受

日期: 2026-10-29

## 背景

自 v1.0.7 以来累积了 0026（凭据表单以浏览器登录为主路径、轮询网络抖动不再终止登录）与 0027（推送/创建标签不再占用工作区 busy 闸门）两类修复。用户推送了 `v1.0.8` tag（指向 `f1170e7`，即 0027 的修复提交），但 `package.json` 的 `version` 仍是 `1.0.7`，Release 工作流在 `Match tag against package.json` 步骤直接失败，后续 typecheck / test / build / publish / GitHub Release 全部被跳过。

按 AGENTS.md，升号由用户发起并作为独立 chore 提交；用户推 tag 的动作即是发版指令，此处补上升号提交，并把 tag 移到该提交上。

## 决策

将 `package.json` 的 `version` 从 `1.0.7` 升到 `1.0.8`，作为独立 chore 提交（与该提交一起带上本决策记录），推送 main 后删除远端 tag `v1.0.8` 并在升号提交上重新打 tag 推送，由 release 工作流（0010）校验 tag 与版本一致后发布 npm 并创建 GitHub Release。

被否决的备选：

- 把 `v1.0.8` tag 改指到 v1.0.7 的提交——被否决：`1.0.7` 已在 npm 上，工作流的 `Refuse to republish an existing version` 步骤会拒绝，等于放弃本次发布。
- 不删旧 tag，直接在 main 上升号并推一个新 tag（如 v1.0.9）——被否决：已推的 `v1.0.8` 会永久指向一个版本号不符的提交，且失败运行会留在 Actions 历史里误导后来者；本次 Release 尚未发布任何产物，移动 tag 无副作用。
- 把升号并进 0027 的修复提交——被否决：违反 AGENTS.md 的独立 chore 提交约定，且该提交已在远端与 tag 上，改写历史代价更大。

## 影响

- 正面：npm 与 GitHub Releases 的 1.0.8 包含 0026、0027 两项修复（浏览器登录为主的凭据流程、标签动作不再阻塞提交按钮）。
- 正面：tag 与 `package.json` 版本由工作流强校验，本次正是该校验把误发的 tag 拦在构建之前。
- 负面：`v1.0.8` 是一次「移动过」的 tag，若有人在移动前已拉取该 tag，需要 `git fetch --force --tags` 才能对齐。
- 依赖：发布依赖仓库 secret `NPM_TOKEN`（见 0010），凭据失效会导致发布步骤失败但不产生半成品 Release。
