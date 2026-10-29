# 0022 — 面板内管理远程地址（含多个远程）

状态：已接受  
日期：2026-10-29

## 背景

面板一直把远程当成「既成事实」：`remotes` 只从 `git branch -r` / `git remote` 读出名字用于分支分组和推送目标解析，用户想看某个远程指向哪儿、想改地址或再加一个镜像远程，只能回到命令行。

需求的第二点是「远程需要可以管理远程地址，甚至可以增加多个远程」。关键点在于：远程是**仓库级**配置（`git remote add` / `set-url` / `remove` 改的是 `.git/config`），对该仓库的所有工作树共享，和「按域名全局的密钥」是两种作用域，不能混为一谈。

## 决策

- 新增 `remotes`（读）与 `remote`（写）两个 POST 路由，body 带 `repoPath`，走既有的 `probeRepo` 校验（必须绝对路径且是 git 仓库）。
  - 写动作是单一的 `action: 'add' | 'set-url' | 'remove'`，而不是三个路由：前端只有一个表单，动作由「新建 / 编辑 / 移除」三种 UI 状态决定；服务端按 action 分派后**统一重新 `listRemotes` 并返回完整列表**，前端不需要自己拼状态，也顺带得到排序后的真实结果。
- git 侧在 `src/git.ts` 新增 `listRemotes` / `addRemote` / `setRemoteUrl` / `removeRemote`：
  - `listRemotes` 解析 `git remote -v`，把同一 name 的 fetch / push 两行配成 `{name, fetchUrl, pushUrl}`（缺一侧用另一侧补齐），按 name 排序。用 `remote -v` 而不是 `remote get-url`（每条一次进程），一次调用拿全，面板打开即可展示。
  - `setRemoteUrl` 先 `remote set-url <name> <url>` 再 `remote set-url --push <name> <url>`：用户看到的表单只有一个「地址」，如果只改 fetch 一侧，push 会继续打到旧地址，这是最容易让人「改了却不生效」的坑。
- 校验拆成纯函数放在 `src/normalize.ts`，与既有的 `branchNameIssue` / `accelerateUrlError` 同一套风格：
  - `remoteNameIssue` 只放行 `[A-Za-z0-9._-]+`，拒绝空、空白、前导 `-`（会被 git 当成选项）和 `.` / `..`。
  - `remoteUrlIssue` 接受 `scheme://…`、scp 风格 `user@host:path`、以及绝对本地路径（后者允许含空格，Windows 路径很常见）；拒绝空、前导 `-`、含空白的非路径输入。
- 路由层先 `listRemotes` 预查存在性，再执行动作，把 `add` 已存在 / `set-url` 或 `remove` 不存在转成明确的 400 文案，而不是把 git 的英文错误直接抛给用户。执行后仍走 `gitFailure` 兜底。
- UI：`BranchSection` 的标题栏工具区加「管理远程」按钮（与「展开/折叠」「+ 新建分支」并列），点击打开 `RemotesModal`（面板持有，repoPath 即当前 cwd）。分支区本身保持 presentational，只新增一个 `onManageRemotes?: () => void` 回调。
  - 表单只暴露 name 与一个 URL，push URL 只在两者不一致时以只读形式列出，避免把「一个地址」的模型复杂化；编辑时 name 只读（改名不在本次范围内）。
  - 改动成功后调用 `onChanged` 让面板 `loadAll()`，分支分组里的远程名立刻反映新增/移除。

## 影响

- 用户不离开面板就能看清每个远程指向哪里、把地址改掉、删掉多余远程、为同一个仓库加镜像远程（多个远程本来就由 git 支持，这次只是把入口做出来）。
- 远程写入是本地 git 配置变更，不触发网络；改完 URL 后要拉取仍需用户自己点「拉取/更新」，本功能不自动 fetch（避免一次表单提交变成一次网络等待）。
- 不做远程改名（`remote rename`）：改名会牵动 `branch.<name>.remote`、`remote.pushDefault` 等一串引用，收益低、误伤面大；需要时让用户用命令行。
- `set-url` 会把 push URL 一并改成同一地址，这会覆盖用户此前特意配置的「fetch 与 push 不同」的仓库（例如 fetch 上游、push 自己的 fork）。这是刻意的：表单只展示一个地址，写回两个值才符合「所见即所得」；需要分离 push URL 的用户应继续用命令行。
- 删除远程只删配置，不动已存在的 `refs/remotes/<name>/*` 引用，这些分支会在下一次 fetch 时自然消失（或在分组里以只读形式残留到那时）。
