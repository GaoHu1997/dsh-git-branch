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
