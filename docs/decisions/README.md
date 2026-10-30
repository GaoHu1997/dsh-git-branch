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
- [0011 — 设置面板按 Host 条目 id 读取插件配置](0011-settings-use-host-entry-id.md)
- [0012 — 发布 v1.0.2 补丁版本](0012-release-v1.0.2.md)
- [0013 — Git 管理面板（侧边栏全局面板 + 提交操作 + AI 提交信息）](0013-git-history-panel.md)
- [0014 — 面板卡片高度受控与分支树折叠/定位](0014-panel-card-height-and-branch-collapse.md)
- [0015 — 分支菜单改右键、跨面板刷新、/switch 切会话自己的检出](0015-branch-context-menu-and-switch-target.md)
- [0016 — 分支卡片标题栏加分支搜索框、去掉标题栏分支数量](0016-branch-card-search-box.md)
- [0017 — 发布 v1.0.4 补丁版本](0017-release-v1.0.4.md)
- [0018 — Git 管理面板加「国内加速」按钮（加速前缀 URL 重写）](0018-cn-accelerate-mirror-prefix.md)
- [0019 — 提交历史图、筛选与右键操作（含行间连线几何修复）](0019-git-history-graph-panel.md)
- [0020 — 提交历史右键「推送标签」动作](0020-push-tag-action.md)
- [0021 — 全局按域名的 Git 密钥配置](0021-global-git-credentials.md)
- [0022 — 面板内管理远程地址（含多个远程）](0022-remote-address-management.md)
- [0023 — 令牌免用户名与 AI 可读的密钥工具](0023-token-without-username-and-credentials-tool.md)
- [0024 — 凭据表单的 IDEA 式浏览器授权与令牌创建入口](0024-credentials-browser-sign-in.md)
- [0025 — 远程对话框改用密钥对话框的折叠编辑器范式](0025-remotes-modal-collapsed-editor.md)
- [0026 — 凭据表单以浏览器登录为主路径，轮询网络抖动不再终止登录](0026-credential-browser-first-and-poll-retry.md)
- [0027 — 标签动作不再占用工作区 busy 闸门](0027-tag-verbs-leave-worktree-busy-gate.md)
- [0028 — 发布 v1.0.8 补丁版本](0028-release-v1.0.8.md)
- [0029 — AI 可用的带凭据 Git 网络工具（git_network）](0029-ai-network-credentials-tool.md)
- [0030 — 发布 v1.0.9 补丁版本](0030-release-v1.0.9.md)
- [0031 — git_network 测试用绝对路径改为平台无关](0031-cross-platform-network-tool-test.md)
- [0032 — shell 里的 `git push` 也用插件密钥（环境变量桥）](0032-shell-git-credential-bridge.md)
