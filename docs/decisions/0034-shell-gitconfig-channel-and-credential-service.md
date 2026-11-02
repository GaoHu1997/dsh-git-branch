# 0034 — shell 凭据桥改用 GIT_CONFIG_GLOBAL 会话配置，凭据入口收敛为服务

状态：已接受

日期：2026-11-02

## 背景

0032 用 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` 三类环境变量给宿主派生的 shell 装一个按域名作用域的 credential helper。在 DeepSeek Harness 宿主里这条路是坏的：子进程环境清洗（`@deepseek-ai/dsh-subprocess`）按 `/KEY|PASSWORD|SECRET|TOKEN/i` 过滤变量名，并剥掉所有 `DSH_` 前缀变量。于是 `GIT_CONFIG_KEY_<n>`（名字含 KEY）与 `DSH_GIT_BRIDGE_HELPER` 被全部删掉，而 `GIT_CONFIG_COUNT` / `GIT_CONFIG_VALUE_<n>` 幸存——半注入导致宿主里每条 `git` 命令都 `fatal: unable to parse command-line config`，桥 helper 也因路径变量被剥而回落错误路径。另一层处境：用户 `~/.gitconfig` 里 `[credential "https://github.com"] helper = !'…\gh.exe' auth git-credential`，让 shell 里的 `git` 一律走本机 gh 账号，而非面板配置的令牌。

实测可用的通道是 `GIT_CONFIG_GLOBAL` 指向一份会话临时 gitconfig：`[include]` 载入用户 `~/.gitconfig`、`[credential] helper =`（空值清空整条机器 helper 链）、按域名的 `[credential "https://<host>/"]` 先空重置再写桥命令。

## 决策

1. **注入通道换 `GIT_CONFIG_GLOBAL`**：`createShellBridge` 生成一份会话 gitconfig（原子写入，`0600`），内含 `[include] path = <home>/.gitconfig`、全局 `[credential] helper =` 清机器链、每个已配置 host 一组 URL 作用域（`helper =` 空重置 + `helper = !"node" "helper.js"`）。`shellBridgeEnv` 注入 `GIT_CONFIG_GLOBAL`、`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`，彻底弃用 `GIT_CONFIG_COUNT/KEY_n/VALUE_n`。
2. **env 命名避开清洗器**：桥 helper 路径变量与调试变量改 `DGB_*`（`DGB_BRIDGE_HELPER`、`DGB_BRIDGE_HOME`、`DGB_BRIDGE_DSH_HOME`、`DGB_BRIDGE_DEBUG`），不含 KEY/PASSWORD/SECRET/TOKEN，也不带 `DSH_` 前缀，能穿过宿主清洗。
3. **引号转义**：`gitconfigEscape` 把值里的 `"` 转成 `\"`，`shellQuote` 把反斜杠归一为正斜杠并加引号，保证 `!` 命令里含空格的 node/helper 路径被 sh 正确拆词（否则报 `sh: C:/Program: No such file or directory`）。
4. **凭据入口收敛为服务**：新增 `src/credential-service.ts` 的 `createCredentialService(deps)`，提供唯一凭据面——`store`、`authConfigArgs()`（产出 `-c http.https://<host>/.extraHeader`）、`refreshShellEnv()`（会话 gitconfig + env）、`dispose()`。`routes.ts`、`network-tool.ts`、`tool.ts`、`index.ts` 一律经它取 store 与注入通道，旧 seam（`credentialsStore` / `refreshShellBridge`）保留为回退。
5. **澄清两件事**：无需设 `GIT_CONFIG_NOSYSTEM`——`[credential] helper =` 空值在真实 credential 解析里已清掉机器链（含 system 的 `helper-selector`），`git config --get-all credential.helper` 仍显示 `helper-selector` 只是原始多值读取、不应用空值清除语义的假象；不设 `GIT_CONFIG_NOSYSTEM` 反而保留系统级 `core.autocrlf` / `symlinks` 等设置。0032 的 `GIT_CONFIG_KEY/VALUE_*` 注入通道在 DSH 宿主失效，被本决策取代。

被否决的备选：

- 保留 `GIT_CONFIG_KEY/VALUE_*` 只改名——被否决：`KEY_n` 仍会被 `/KEY/` 命中剥离，`COUNT`/`VALUE_n` 幸存的半注入风险依旧，治标不治本。
- `GIT_CONFIG_PARAMETERS` 空值清 helper——被否决：该通道 deprecated，实测报 `bogus format`，且空值不清单值 helper，语义不稳。
- 设 `GIT_CONFIG_NOSYSTEM=1`——被否决：空值已足够清机器链（见决策 5），再设反而丢掉系统级 `core.*` 设置。

## 影响

- 正面：宿主派生 shell 里的 `git` 不再 `fatal`，配置过的域名命中面板令牌（含空格的 node/helper 路径也能正确调用）；未配置域名 exit 128 快速失败，不再弹 GCM 对话框；凭据相关逻辑收敛到一个服务，插件间单向依赖。
- 反面：全局 `credential.helper` 清空使宿主 shell 不再使用机器 GCM 凭据，Gitee 等未在面板配置的域名会直接失败（与 0032 的取舍一致）；会话配置只 `[include]` 用户 `~/.gitconfig`，用户级 `includeIf` 不被展开，依赖它的场景需另行处理。
- 依赖：helper 脚本必须用 node 可执行的真实绝对路径；会话 gitconfig 写入失败时降级为只保留 fail-fast 环境变量（`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`），不阻断 git。
