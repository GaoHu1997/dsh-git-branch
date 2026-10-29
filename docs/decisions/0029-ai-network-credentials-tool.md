# 0029 — AI 可用的带凭据 Git 网络工具

状态：已接受  
日期：2026-10-29

## 背景

0021 把凭据注入收敛在插件自己的路由里（`src/routes.ts` 的 `authArgsFor`），0023 又给模型加了一个**只读**的 `git_credentials` 工具。两条加起来的结果是：面板上的 fetch / update / push / 推送标签会用面板里配的令牌，而 AI 在 shell 里跑的 `git push` 不会。

这个分叉在真实使用中立刻可见。本机 `github.com` 的 credential helper 是 GitHub CLI（`credential.https://github.com.helper=!'…\gh.exe' auth git-credential`），`git credential fill` 解析出的账号是 `GaoHu1997`；插件凭据文件里存的却是 `gaohu9712@163.com` 的 40 位 token。于是同一个仓库、同一个用户，面板按钮推上去的是 A 账号，对话里让 AI 推上去的是 B 账号——用户报告「AI 总是用本机全局凭证，而没用插件配置的凭证」，并要求提供一个工具让 AI 用插件凭据。

约束：插件不能改写用户的全局 git config，也不能覆盖 credential helper（0021 已否决）；令牌不能因为「让 AI 会用」就落进会话记录；AI 不应获得一个通用的命令执行器。

## 决策

- **新增模型可见工具 `git_network`**（`src/network-tool.ts`），在指定仓库目录执行**一条** git 网络子命令，并前置与路由完全相同的 `authConfigArgs`（`-c http.https://<host>/.extraHeader=…`）。注册方式与 `git_credentials` 一致：普通对象 + `ctx.tools.register`，不 import `@deepseek-ai/dsh-tools`（0023 的同一取舍）。
- **子命令白名单只有 `fetch` / `pull` / `push` / `ls-remote`**。被否决的备选：
  - 允许任意 git 子命令：等于把插件变成通用命令执行器，而 `status` / `log` / `commit` 这类本地命令本来就不需要凭据，没有理由借道这个工具。
  - 支持 `clone`：`repoPath` 是「已存在的仓库目录」，clone 的目标目录通常还不存在，语义冲突；插件自身也不做 clone。
  - 包一层 shell：必须经过 shell 解析参数，注入面远大于直接 `execFile('git', args)`。
- **危险参数在工具内部拒绝**，不交给 git 裁决：
  - 通用：`-c`、`--config-env*`、`--exec-path`、`--upload-pack*`、`--receive-pack*`、`--git-dir`、`--work-tree`、`--namespace`、`--bare`、`--no-replace-objects`。前两者能替换/禁用注入的凭据头，中间两者能在 ssh 场景下于远端执行任意命令，其余会把命令指到另一个仓库或另一份配置。
  - 仅 `push`：`-f`、`--force`、`--force-with-lease`、`--force-if-includes`、`--mirror`、`--delete`、`-d`、`--prune`，以及以 `+` / `:` 开头的 refspec。这些都是对远端不可逆的改写；AI 拿不到「用户真的想强制推」这一上下文，面板里由人点按才是正确入口。`fetch --prune`、`ls-remote -d` 不受影响。
  - 第一个 token 必须是白名单子命令，因此 `git -c … push` 这种「把全局选项放在子命令前」的形态从语法上就进不来。
- **令牌不出进程**：secret 只在 host 进程内拼成 Basic 头；返回值只含 `exitCode` / 脱敏后的 stdout、stderr / 注入的 host 列表。脱敏同时覆盖明文 secret 与它的 base64 头形式（防远端 URL 里带 token 的回显），单流上限 64 KiB，超出置 `truncated`。
- **失败不中断**：凭据文件读失败时按「没有插件凭据」跑，并把原因折进 `credentialsError`（与路由的降级一致，0021）；git 非零退出不是异常，`exitCode` + stderr 原样交给模型判断。
- **`repoPath` 必须是绝对路径**，作为 cwd 传给 git；不额外探测「是不是仓库」——git 自己的 `not a git repository` 更准确，也少一次进程。超时复用 `NETWORK_TIMEOUT_MS`（120s），与面板的 push / fetch 同一预算。

## 影响

- 正面：AI 的 `git_network push` 以用户在面板里配置的账号发出，不再受本机 credential helper 影响；整个过程不需要 `git_credentials includeSecret`，令牌因此不会进入会话记录。
- 负面：多了一条执行路径要维护白名单。`--force` / `--delete` / `--mirror` 被永久拒绝，用户若让 AI「强制推一下」，AI 只能回复「请到面板手动操作」或改走 shell——这是刻意的取舍：工具的价值是「用对账号」，不是「替人按下危险按钮」。白名单外的新需求（如 `clone`）需要改代码与测试，而不是加参数就能做到。
- 安全边界：工具仍会写远端（push 本身就是写入），且无法区分「用户真心要推」与「提示注入诱导推送」。缓解手段是上面那组不可逆操作的黑名单与固定的子命令面，而不是权限系统。
- 测试：`tests/network-tool.spec.ts` 覆盖参数校验（路径、白名单、危险选项、push 专属拒绝）、header 前缀与 cwd/超时、非零退出、双形式脱敏、坏凭据文件降级、输出截断与渲染。
