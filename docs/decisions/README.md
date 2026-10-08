# 决策记录（Decision Records）

本目录存放本仓库非平凡变更的决策记录（ADR）。每次非平凡变更须在同一个提交里新增或更新一条记录。

## 规范

- 文件名：`NNNN-短标题.md`（四位递增序号，kebab-case 短标题），如 `0001-rename-npm-package.md`。
- 状态：`已接受` / `已废弃（被 NNNN 取代）`。
- 结构（必须包含以下小节）：
  - `## 背景` — 变更面对的处境与约束。
  - `## 决策` — 做了什么、为什么选它（含被否决的备选与理由）。
  - `## 影响` — 采纳后带来的后果（正反两面都要写）。
- 语言：中文为主，代码与包名保留原文。

## 索引

- [0001 — npm 包名从 @gaohu9712/dsh-git-branch 改为 dsh-git-branch](0001-rename-npm-package.md)（已废弃，被 0003 取代）
- [0002 — 发布 v1.0.1 补丁版本](0002-release-v1.0.1.md)
- [0003 — 包名改为 dsh-git-branch-manage（dsh-git-branch 已被他人占用）](0003-rename-package-to-dsh-git-branch-manage.md)
- [0004 — Release 步骤打印最终状态并在草稿时告警](0004-release-status-logging.md)

以下 0005–0010 是 2026-10-08 从本机补录的历史记录（此前 `docs/` 未被跟踪，这些记录一直只存在于本地）；标题下的 `日期` 保留各记录原始的日期，编号按补录提交的先后顺延：

- [0005 — 放宽 DSH peer 依赖版本为范围适配](0005-widen-dsh-peer-version-range.md)
- [0006 — bundle patch 必须使用可解析的 npm 包名](0006-bundle-patch-module-name.md)
- [0007 — 插件展示名称与描述使用 locale 词典](0007-localized-plugin-display-metadata.md)
- [0008 — 保留 Git 推送失败诊断](0008-preserve-git-push-diagnostics.md)
- [0009 — 禁用无可推送提交的推送按钮](0009-disable-empty-push.md)
- [0010 — GitHub Actions 承担 CI 与 tag 触发的 npm 发布](0010-github-actions-ci-and-npm-release.md)
