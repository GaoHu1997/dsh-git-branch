# 变更日志

本文件记录 `dsh-git-branch-manage` 的重要变更。版本号遵循语义化版本。

## [1.3.0] - 2026-11-04

### 新增

- **网络备用通道与代理配置**（决策 0042、0043）：直连发生可重试网络故障时，对 GitHub 地址使用运行时 DoH 查询和真实 Git 请求竞速选择可用 IP；支持显式配置 HTTP(S)/SOCKS 代理，并提供只读系统代理探测建议与「检测网络」诊断。
- **网络操作状态诊断**（决策 0041）：按探测、读取、写入和超时核验分别设置预算；推送前探测远端，推送超时后核验远端 ref，并按失败类型给出建议。

### 变更

- **镜像仅作为读取加速**（决策 0044）：镜像 fetch/update 失败后自动恢复原始 URL 回直连，再按备用通道链尝试；推送不走镜像，避免将写入交给第三方。
- SSH 远端不再进行无效的 HTTP 代理/IP 通道探测，错误信息改为提示可执行的 HTTPS 方案。
- 加速前缀改为拼接完整 GitHub URL（决策 0040），并用真实 Git URL 解析与提取覆盖回归场景。

### 修复

- **CI 在非 Windows 上失败**（决策 0046）：系统代理探测的用例此前无条件假设 Windows 注册表，在 ubuntu-latest 上必然失败；现按平台分派，Windows 侧保留注册表行为覆盖，非 Windows 侧断言不读取注册表。

## [1.2.0] - 2026-11-02

### 新增

- **凭据管理直接读写本机 `~/.git-credentials`**（决策 0037）：面板里存一次，任何 shell、任何子进程的 `git push/fetch/pull` 都用同一账号；文件里不属于本插件的行（注释、`ssh://` 等）原样保留，卸载插件后凭据仍属于用户。
- **从本机导入凭据，启动时默认执行**（决策 0038）：按用户 gitconfig 里声明过的 credential 域名逐个探测（`git credential fill`，串行 + 20 秒超时），答出令牌即导入面板；面板另有手动「从本机导入」入口（`POST /credentials-import`），toast 汇总导入/跳过/失败数量。`gh`、GCM、`store` 里的账号一次导入即可接管。

### 变更

- 凭据生效通道改用 git 原生机制：`~/.gitconfig` 幂等追加一行 `[include]` 指向生成的 URL 作用域配置（每个已存域名重置 helper 链后装内置 `store`），不再向进程环境注入（废弃 0032/0034 的 `GIT_CONFIG_*` / `GIT_CONFIG_GLOBAL` 通道），令牌也不再进入命令行参数。
- 未管理域名的机器原有 helper（gh、GCM 等）保持原样，不再被全局清空；未存域名依旧 fail-fast 不弹窗。
- 令牌明文落在 `~/.git-credentials`（0600）——与 git 自带 `store` helper 一致的安全取舍；面板列表元数据（`method`/`updatedAt`）另存不含 secret 的旁文件。

### 移除

- 删除自研 `git-credential-bridge` helper，改用 git 内置 `credential-store`，不再为每次 git 调用拉起 node 进程。

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
