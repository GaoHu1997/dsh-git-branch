# 变更日志

本文件记录 `dsh-git-branch-manage` 的重要变更。版本号遵循语义化版本。

## [1.1.0] - 2026-11-02

### 修复

- **宿主里的 `git` 命令全部 `fatal`**（`fatal: unable to parse command-line config`）：0032 的 `GIT_CONFIG_KEY/VALUE_*` 环境注入被 DeepSeek Harness 的子进程环境清洗（按 `/KEY|PASSWORD|SECRET|TOKEN/i` 过滤变量名、并剥掉 `DSH_*` 前缀）半剥离——`KEY_n` 被删、`COUNT/VALUE_n` 幸存。改用 `GIT_CONFIG_GLOBAL` 指向一份会话临时 gitconfig 注入凭据（决策 0034）。
- **shell 里的 `git` 走本机 gh 账号而非面板令牌**：会话配置用 URL 作用域的空 `helper` 重置，清掉 `~/.gitconfig` 里 `[credential "https://github.com"]` 的 gh helper，让已配置域名命中面板令牌。
- **未配置域名弹 GCM 凭据对话框 / 挂死**：全局空 `helper` 清空机器 helper 链，未配置域名 `exit 128` 快速失败，不再弹窗。
- **含空格的 node/helper 路径调用失败**（`sh: C:/Program: No such file or directory`）：`gitconfigEscape` / `shellQuote` 正确转义引号与反斜杠。

### 变更

- 新增 `createCredentialService`，把凭据入口收敛为单一服务（`store` / `authConfigArgs` / `refreshShellEnv` / `dispose`）；routes、`git_network`、密钥工具统一经它取 store 与注入通道（决策 0034）。
- 桥 helper 环境变量改 `DGB_*` 命名（`DGB_BRIDGE_HELPER` 等），避开 DSH 环境清洗。
- 新增真实 `git` 端到端回归测试（`shell-bridge-e2e`）：验证已配置域名命中桥令牌、空格路径正确调用、未配置域名快速失败。

## [1.0.10] - 2026-10-30

- shell 里的 `git push` 也走插件密钥（环境变量桥，决策 0032）。注：该注入通道在 DeepSeek Harness 宿主中失效，已由 1.1.0 修正（决策 0034）。

更早版本见 [GitHub Releases](https://github.com/GaoHu1997/dsh-git-branch/releases)。
