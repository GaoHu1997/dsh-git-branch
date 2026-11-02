# 0038 — 从本机凭据导入并在启动时默认接管

状态：已接受（补充 0037）

日期：2026-11-02

## 背景

0037 之后面板直接管理 `~/.git-credentials`，但**只看得到这个文件里已有的行**。用户机器上的凭据从来不止这一处：`gh` 把 token 放在自己的 store 里，GCM 放在 Windows 凭据管理器里，两者都不可枚举。0037 的一次性迁移只搬了插件私有的 `~/.dsh/git-credentials.json`，于是出现很实际的落差——面板里只有手工加过的那几个域名（如 `gitlab.cofco-trust.com`），而 `D:\work` 下一半仓库的 remote 指向 `git.cofco-trust.com`，本机明明能推，面板却看不见、也没法用面板的账号去接管。

用户因此要求：把本机已有的凭据**导入**进来接管，并且**默认就这么干**，面板上再给一个手动触发的入口。

## 决策

1. **候选域名来自用户 gitconfig**。`git config --get-regexp '^credential\.https?://'` 列出所有 URL 作用域的 credential 段，取其中的 host，normalize 去重。这是本机唯一可枚举的「git 知道要问哪些域名」的来源：GCM 与 `gh` 的内部存储都不可读，命令行 `git credential fill` 又必须先告诉它 host。
2. **逐个探测，答出 secret 才导入**。对每个候选 host 跑一次 `git credential fill`（stdin `protocol=https\nhost=<host>\n\n`），有 `password` 才写入 store。探测**保留**本机的 helper 链（不清 `helper =`，这正是要用它），只加 `GIT_TERMINAL_PROMPT=0` 与 `GCM_INTERACTIVE=never` 防止挂起，并清掉 0036 遗留的半注入 `GIT_CONFIG_COUNT`/`KEY`/`VALUE`。
3. **串行 + 20 秒超时 + 逐 host 记失败**。GCM 会拉起系统组件，实测单次 2–6 秒，偶发十几秒超时；并发会让进程数失控，也难定位是谁挂住。超时 kill 后记为该 host 失败，不影响其余 host。
4. **已管理的域名跳过**，不探测、不覆盖。导入只增不删：用户的显式配置优先于本机 helper 当时的答案，否则启动时的自动导入会把面板里刚改过的令牌改回旧值。
5. **token 归一**。`username` 为空或等于 `oauth2` 时按 token 存（空用户名 + `method: 'token'`），与 0037 的存储约定一致。
6. **批量一次保存**。收集完所有探测结果后只 `save` 一次，避免 N 次重写 `~/.git-credentials` 与元数据文件。
7. **启动时默认执行**。`apply()` 里先 `refreshShellEnv()`（迁移 + 装 include），再 `autoImport()`；导入非空时再 `apply()` 一次，把新域名写进 include。`autoImport` 单飞（缓存 promise），重复调用不再跑 git。
8. **面板入口**：`POST /credentials-import`，可选 `{ hosts: string[] }` 显式指定（支持粘贴 remote URL，内部 normalize），省略则走 gitconfig 候选。响应为最新掩码列表 + `imported`/`skipped`/`failed`，前端以 toast 汇总三个数字。

被否决的备选：

- **读 `~/.config/gh/hosts.yml`**——被否决：本机实测该文件不存在，`gh auth git-credential` 的令牌由 gh 自己保管；且只覆盖 gh，覆盖不到 GCM、`store` 与未来其他 helper。
- **枚举 GCM / 系统钥匙串**——被否决：需要原生模块或平台 API，破坏纯 Node 安装；`git credential fill` 已经是跨平台统一的那一层。
- **无条件 `git credential fill` 而不看 gitconfig**——被否决：fill 必须给 host，没有候选就无从问起；凭据管理器里可能存着的域名无法反过来列出来。
- **覆盖已管理的域名**——被否决：会让启动时的自动导入持续回滚用户在面板里的修改，行为不可预期。
- **导入时删除本机已消失的域名**——被否决：`fill` 失败可能只是 helper 暂时不可用（本机实测 GCM 会偶发失败），删凭据的代价远大于留一条旧值；面板仍可手动删除。
- **把候选域名做成面板里的多选列表**——被否决（本轮）：候选量随 gitconfig 增长，先给「一键全部导入 + 逐 host 报告」，需要精细控制时用显式 `hosts`。

## 影响

- 正面：从 `gh`、GCM、`store` 来的账号一次导入即可在面板里查看与接管；新机器上打开插件就自动对齐本机现状，不必逐个域名手输。
- 正面：只在启动时执行一次，且只对 gitconfig 声明过的域名动手，不做网络请求，凭据不出本机；报告里只有 host/username/method 与错误文本，不含 secret。
- 代价：启动多若干次 `git credential fill` 子进程（每个候选一次，串行；本机约 2–6 秒/个，最坏 20 秒）。它在后台跑（`void … .catch()`），不阻塞面板打开。
- 代价：导入后令牌以明文进入 `~/.git-credentials`（0600）——与 0037 相同的取舍，且这是「用面板管理本机凭据」的必然结果。
- 局限：导入的是 helper **那一刻**的答案；之后 helper 侧轮换（如在 GCM 里改密码）不会自动同步，需再点一次「从本机导入」。
- 失败可见：GCM 偶发超时/拒绝时该 host 进 `failed`，前端 toast 会显示失败数量，不会静默吞掉。
- 验证：`tests/local-import.spec.ts` 覆盖 gitconfig 候选解析、探测参数与环境清洗、password/token 归一、已管理跳过、逐 host 失败、批量只保存一次、显式 host 归一；`tests/remote-management.spec.ts` 的 `credentials import route` 覆盖报告透传、是否刷新 bridge、请求体校验。
