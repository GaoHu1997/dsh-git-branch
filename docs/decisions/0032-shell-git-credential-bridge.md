# 0032 — shell 里的 `git push` 也用插件密钥（环境变量桥）

状态：已接受
日期：2026-10-30

## 背景

0021 把密钥按远程域名存进 `~/.dsh/git-credentials.json`，0029 又把它注入到面板自己的 fetch/pull/push 路由和一个模型可调用的 `git_network` 工具里。两条通道都靠 `git -c http.<url>.extraHeader=…`，因此都只在「插件自己发起的那一次 git 调用」里生效。

真实的会话执行路径是 shell：模型在 `ops_bash` 里跑 `git push origin main`。那一刻 git 只看得到机器上的 credential helper 链（本机是 `helper-selector` → Git Credential Manager），而那里保存的是另一个 GitHub 账号（`GaoHu1997` 的 CLI 登录），插件里配的 `gaohu9712@163.com` 令牌根本不在链上。于是第一次推送要么以错误账号发出去，要么在拿不到凭据时打开一个没人能点的 GUI 弹窗——2026-10-30 的一次发布实测是后者：`git tag -a v0.1.3 && git push origin master` 挂死 3 分 38 秒、零输出，被杀掉后改用 `git_network` 才推上去。

约束沿用 0021/0029：用户机器上的 git 配置文件不许改写；令牌不许进会话；不许为此给模型一个通用命令执行器。

## 决策

在 host 进程里用**进程环境**安装一个按域名作用域的 credential helper，并让它随插件生命周期更新：

1. 新增 `src/helpers/git-credential-bridge.ts`，编译到 `lib/helpers/git-credential-bridge.js`，是一个独立的 git credential helper 脚本：`get` 时读 stdin 的 `host=…`，到 `~/.dsh/git-credentials.json` 里查同域名的记录，命中就输出 `username=…/password=…`，未命中保持静默（git 自动落回下一个 helper）；`store`/`erase` 刻意不写盘（写回会和面板的原子保存打架，还会泄露文件结构）。
2. 新增 `src/shell-bridge.ts`：`shellBridgeEnv(hosts, …)` 先产出**一条全局 `credential.helper` 空值**（把机器整条 helper 链清掉），再为每个已存密钥的域名产出两对 `GIT_CONFIG_*`——先用空值把该 URL 作用域下的 helper 列表重置掉，再挂上 `!<node> <bridge.js>`；同时设 `DSH_GIT_BRIDGE_HELPER`（凭据文件路径）、`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`。`createShellBridge(deps).apply()` 读一次凭据库、把上一轮的键删掉再写本轮，因此新增/删除域名都能即时反映。

   那条全局空值不是可选项：本机 `credential.helper = helper-selector` 会转给 Git Credential Manager，而 GCM 拿不到凭据时**弹 GUI 对话框**。`GIT_TERMINAL_PROMPT=0` 和 `GCM_INTERACTIVE=never` 都拦不住它——实测未配置域名会挂满超时（8s/30s 都试过），加上全局空值后 `git credential fill` 在 29ms 内以 `fatal: could not read Username … terminal prompts disabled`（exit 128）结束。代价是宿主派生的 shell 里不再使用机器 helper 的任何凭据（含 Gitee 的 `provider=generic`），换来的是「配了就能推、没配就立刻报错」而不是弹窗挂死。
3. `src/index.ts` 在 `apply()` 里创建 bridge 并 `void shellBridge.apply()`，再把 `refreshShellBridge` 塞进 `RouteDeps`；`src/routes.ts` 的 `/credentials-save`、`/credentials-delete`、`/credentials-oauth-poll` 在 `store.save()` 成功后调用它（失败只吞掉，不让保存变红）。
4. `git_network` 的工具描述与三个模块头注释改写：shell 现在也能拿到凭据，但桥依赖宿主进程环境（旧宿主、插件之外的终端里没有），所以仍优先用 `git_network`。

被否决的备选：

- **`GIT_ASKPASS` 指脚本**：askpass 只在 helper 链拿不到凭据时才被问，而本机 `helper-selector`→GCM 会先弹 GUI 把命令卡死，根本轮不到 askpass；要让它生效还得同时清空 helper 链，等于做第 2 步的事外加一个更弱的注入点（askpass 只回答「用户名/密码」，不对 URL 作用域做区分）。
- **用 `GIT_CONFIG_*` 注入 `http.<url>.extraHeader`**：实现最短，但令牌会出现在任意子进程的 `env` 里，模型跑一次 `env` 就把它带进会话——直接违反 0021 的「令牌不进会话」。
- **改 `~/.gitconfig` 或全局注册 helper**：0021 已明确否决（会污染用户的所有仓库，且删除插件后残留）。
- **只改 `git_network` 的描述，让模型总用它**：治不了「模型顺手写 `git push`」这类事，也治不了用户自己在终端里推。

关键实现细节（都踩过坑）：

- helper 值必须带 `!` 前缀。git 不对 helper 值做 shell 拆词，`node "C:/…/bridge.js"` 会被当成名为 `git-credential-node` 的程序而报 `git: 'credential-node' is not a git command`；`!` 前缀让它走 shell，`argv[2]` 就是 `get`。
- 路径里的反斜杠要换成正斜杠并加引号：`sh` 会把 `C:\Users` 里的反斜杠当转义。
- 重置必须排在同名键的写入之前（`GIT_CONFIG_VALUE_0` 空值、`_1` 命令），顺序反了 git 会先跑机器 helper。
- `GIT_CONFIG_PARAMETERS` 那条老接口在本机 bash 下报 `bogus format`，只用 `GIT_CONFIG_COUNT/KEY_n/VALUE_n`。

## 影响

正面：

- shell 里的 `git push/fetch/pull` 对已配置域名直接用插件令牌，第一次推送不再以错误账号发送或挂死；`git_network` 退化成「确定性明确的通道」而不是唯一通道。
- 用户 git 配置文件一个字节都不变；令牌只存在 host 进程环境里，不进会话、不进日志（helper 的 stdout 直接给 git，模型看不到）。
- 未配置的域名不再弹窗挂死：全局 helper 清空 + `GIT_TERMINAL_PROMPT=0` 让它 30ms 内报 `terminal prompts disabled`。这一条对 agent shell 尤其重要——GUI 弹窗没人能点，之前会一直挂着。
- 凭据保存/删除/浏览器登录之后立即生效，不用重启宿主。

负面与风险：

- 注入的是**进程环境**，任何能读 host 进程环境的子进程都能看到 `GIT_CONFIG_VALUE_*` 里的凭据文件**路径**（不是令牌本身，令牌由 helper 运行时读取）。这比「令牌进 env」轻得多，但仍意味着同进程的其它插件理论上能定位凭据文件。
- `GIT_TERMINAL_PROMPT=0` 与 `GCM_INTERACTIVE=never` 是全局性的：宿主派生的一切 git 调用都不再能交互式提问。这正是想要的（挂死比失败更糟），但用户若指望「在 agent shell 里手动输密码」会失效，需要到系统终端里做。
- 全局 `credential.helper` 清空意味着宿主派生的 shell 里**不再有机器 helper 的凭据**：Gitee、GitLab 等没在面板里配过的域名会直接失败，而不是悄悄用 GCM 里存的账号。这是刻意的——用错账号推送比失败更难发现——但如果用户习惯让 shell 走 GCM，需要在面板里补上对应域名。
- helper 是 `node <script>` 子进程，每次凭据协商多一次 node 启动（几十毫秒级）；只在真正需要凭据时发生。
- 宿主进程若在插件加载前就派生了长驻 shell，那些进程拿不到后来的环境更新（普通一次性命令不受影响）。

## 相关

- 0021（全局按域名的 Git 密钥配置）、0029（git_network 工具）——本条是它们的第三条通道与补丁。
- 复现与验证：`GIT_CONFIG_COUNT=2`、`GIT_CONFIG_KEY_0=credential.https://github.com/.helper`（空值）、`GIT_CONFIG_KEY_1` 同上 + `GIT_CONFIG_VALUE_1='!node "…/lib/helpers/git-credential-bridge.js"'`、`GIT_TERMINAL_PROMPT=0`，然后 `printf 'protocol=https\nhost=github.com\n\n' | git credential fill` 应当直接答出 `username=oauth2`。
