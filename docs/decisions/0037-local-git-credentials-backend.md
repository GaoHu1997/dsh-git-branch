# 0037 — 凭据直接管理本机 `~/.git-credentials`，经 `~/.gitconfig` 的 URL 作用域 include 生效

状态：已接受（取代 0021 的存储位置与 0034 的环境注入通道）

日期：2026-11-02

## 背景

0021 把面板密钥按远程域名存进插件私有文件 `~/.dsh/git-credentials.json`，并靠 `git -c http.https://<host>/.extraHeader=…` 注入；0032/0034 又试图让 shell 里的 `git` 也用上它——先走 `GIT_CONFIG_*` 环境通道，再走生成的 `GIT_CONFIG_GLOBAL` 会话配置。三条通道都只在「插件自己发起的那一次 git 调用」或「拿到同一份环境快照的子进程」里生效，于是留下三个问题：

1. **跨进程盲区**：`apply()` 只改宿主进程的 `process.env`，任何拿到不同环境快照的 shell（`ops_bash` 实测即是）完全看不到会话配置；0036 只能收拾由此产生的半注入残骸。
2. **和本机已有凭据打架**：会话配置先 include 用户 `~/.gitconfig`，再用空 `helper =` 清空整条链，只给「已存域名」装桥。用户本机本来能用的凭据（GCM、`gh`、`~/.git-credentials`）对所有未存域名立刻失效，`git push` 从「换个账号推上去」变成 `fatal: could not read Username … terminal prompts disabled`。实测：`env -u GIT_CONFIG_GLOBAL git credential fill` 答出用户名，插件会话里同一域名答 128。
3. **两份密钥来源**：插件私有 JSON 与本机 `~/.git-credentials` 各存一份，用户改一边另一边不知道；面板「添加凭据」也写不到用户平时用的那份文件里。

用户因此要求：面板的凭据管理**直接管理本机凭据**，新增/删除都改本机那份文件，不再保留插件私有凭据。

## 决策

改用 git 自己的机制，不再碰进程环境：

1. **存储 = `~/.git-credentials`**（git `credential-store` 格式）。一行一条 `https://<user>:<pass>@<host>`，用户名与密码按 RFC3986 非保留字符集百分号编码（小写 hex），与 `git credential approve` 写出来的字节一致；token 型凭据沿用 `oauth2` 占位用户名（0023）。文件里**不属于本插件的行**（注释、`ssh://`、`http://`、畸形行）原样保留并写在凭证行之前，保存不会重排别人的内容。
2. **URL 作用域 include**：生成 `<DSH_HOME>/git-credentials.include.gitconfig`，每个已存域名一段
   ```gitconfig
   [credential "https://github.com/"]
   	helper =
   	helper = store
   ```
   空值 `helper =` 清掉该 URL 下继承来的 helper 列表（`gh`、GCM 等），随后装 git 内置的 `store`。这与 0034 的「全局清空」相反：只覆盖被管理的域名，未管理的域名继续用机器原来的配置。
3. **`~/.gitconfig` 只加一行 include**：`ensureGitconfigInclude` 幂等追加 `[include] path = <上面那份文件>`（Windows 路径转正斜杠，已存在则不动），`dispose()` 时 `removeGitconfigInclude` 只删这一组，其余字节不动。这是 0021「不写用户 git 配置文件」的**明确反转**：只有让 `~/.gitconfig` 指向生成文件，「任何 shell 里的 git」才都生效——这正是 0032/0034 没能做到的。
4. **元数据旁文件**：`method` / `updatedAt` 是面板列表要显示的字段，`~/.git-credentials` 里放不下也不该放。另存 `<DSH_HOME>/git-credentials.meta.json`（`version:1`，只有 `host`/`method`/`updatedAt`，**不含 secret**）。缺失或损坏读作「没有元数据」，凭据本身照常加载，`method` 按行推断（`oauth2` 用户名 → `token`）。
5. **一次性迁移**：`refreshShellEnv()` 先跑 `migrateLegacyCredentialFile`——读旧 JSON、按 host 合入本机文件（同一 host 插件值胜出）、**写成功后才删**旧文件；缺失即 no-op，空文件直接删。此后插件私有凭据文件不再存在。
6. **面板与工具不再注入 header**：`routes.ts` 的 `authArgsFor` 恒返回 `[]`，`git_network` 原样转发 `request.args`（输出仍经 `redactSecrets` 脱敏）。凭据由 git 自己经 include → `store` 取，插件不再把令牌放进命令行参数。
7. **shell-bridge 缩成两件事**：装/卸 include，以及保留 `GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=never` 两个 fail-fast 开关（未存域名时立刻失败，而不是把 agent 的 shell 挂在 GUI 弹窗上）。0036 的遗留通道清理保持不变。

被否决的备选：

- **继续用 0034 的会话 `GIT_CONFIG_GLOBAL`**——被否决：跨进程不可靠（见背景 1），而且「全局清空 helper」会连带废掉用户已有的凭据（背景 2）。
- **继续 `-c http.<url>.extraHeader` 注入面板与 `git_network` 的调用**——被否决：只在插件自己发起的那次调用里生效，shell 里的 `git push` 仍用别的账号；令牌还会出现在进程命令行里。
- **保留 `!node lib/helpers/git-credential-bridge.js` 这种自研 helper**——被否决：多一个 node 进程、还要读插件私有 JSON；git 自带的 `store` helper 更短、跨平台、和用户已有文件天然同源。`src/helpers/git-credential-bridge.ts` 随之删除。
- **改用户 `~/.gitconfig` 里 `gh` 那一段（删掉或改顺序）**——被否决：越界改用户配置；URL 作用域的空值 reset 已经能局部覆盖，且卸载即可恢复。
- **写系统钥匙串（GCM / libsecret / macOS keychain）**——被否决：引入原生依赖，破坏纯 Node 安装；而且用户平时用的就是 `~/.git-credentials`，插件管理同一份文件才对得上「直接管理本地凭据」。

## 影响

- 正面：面板里存一次，**任何** shell、任何派生进程的 `git push/fetch/pull` 都用同一账号（0032/0034 的跨进程盲区消失）；本机原本能用的凭据对未管理域名不再被破坏；用户手工编辑的 `~/.git-credentials` 会被面板照常读出并原样保留非本插件行。
- 正面：令牌不再进入命令行参数，`-c extraHeader` 那一套（含 base64 形态的泄漏面）整体消失；`redactSecrets` 仍兜底工具输出。
- 安全取舍：**令牌明文落在 `~/.git-credentials`（0600）**。这与 git 自身的 `store` helper 一致，也是「插件直接管理本机凭据」的必然代价；面板只显示掩码，生成文件与元数据文件都不含 secret。
- 侵入性：首次 `apply()` 会向 `~/.gitconfig` 追加一组 `[include]`（幂等；卸载时删除）。除此之外不改用户配置，也不动系统级 config。
- 卸载后：include 行与生成文件被清掉，**凭据本身留在 `~/.git-credentials`**——它们属于用户，不属于插件。
- 兼容：旧 `~/.dsh/git-credentials.json` 迁移一次即删除；`method`/`updatedAt` 丢失时按行推断。依赖 git 内置 `store` helper 与 `[include]`（git 1.7+ 即有）。
- 验证：`tests/shell-bridge-e2e.spec.ts` 在隔离 HOME + `GIT_CONFIG_NOSYSTEM=1` 下用真实 `git credential fill` 证明——已存域名答出本机文件里的令牌并压过用户段里的竞争 helper；未管理域名照旧 fail-fast（128）；`dispose()` 后回落用户配置且不删凭据文件。其余由 `tests/credentials.spec.ts`、`tests/credential-service.spec.ts`、`tests/shell-bridge.spec.ts` 覆盖。
