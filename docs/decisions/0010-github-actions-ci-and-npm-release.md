# 0010 — GitHub Actions 承担 CI 与 tag 触发的 npm 发布

日期: 2026-10-05
状态: 已接受

## 背景

仓库此前没有任何 CI。`lib/` 被 `.gitignore` 排除、由本地 `pnpm publish` 的 `prepublishOnly` 现场构建，因此构建与发布完全依赖本地环境和人工步骤。README 已经承诺"从 npm 安装"，但包在 registry 上并不存在（`npm view @gaohu9712/dsh-git-branch` 返回 404），也没有任何机制把 tag 变成一次发布。同时仓库里还跟踪着 `artifacts/gaohu9712-dsh-git-branch-1.0.0.tgz` 这份手工打包的产物快照，与"仓库不携带预构建产物"的说明相矛盾。

（本记录写于包名仍为 `@gaohu9712/dsh-git-branch` 时；该名字后来被他人占用，包名经 0001、0003 两次改名定为 `dsh-git-branch-manage`。文中出现的旧包名是当时的事实。）

## 决策

- 新增 `.github/workflows/ci.yml`：在 push 到 `main` 和所有 PR 上依次跑 `typecheck` → `test` → `build:all`，并把 `lib/` 作为构建产物上传；`permissions` 只给 `contents: read`。安装用 `pnpm install --frozen-lockfile`，Node 取 22（`engines` 下限是 `>=22.19`）。
- 新增 `.github/workflows/release.yml`：只由 `v*` tag 触发，`concurrency` 固定为 `release-${{ github.ref }}` 且不取消进行中的发布。
- 发布前强校验 tag 与 `package.json` 的 `version` 严格相等（要求 `${GITHUB_REF_NAME}` 等于 `v${version}`），不等立即失败。
- dist-tag 由版本派生：稳定版发 `latest`，带预发布后缀（版本串含 `-`）的发 `next`；不引入任何额外输入。
- 发布顺序固定为：校验版本尚未发布过 → `typecheck`/`test`/`build:all` → `pnpm pack --pack-destination artifacts` → `pnpm publish --access public --no-git-checks --tag <派生值>` → 最后用 `gh` 创建 GitHub Release 并附上刚打出的 tarball。
- 凭据走仓库 secret `NPM_TOKEN`：写进 `$RUNNER_TEMP` 下的临时 npmrc，用 `NPM_CONFIG_USERCONFIG` 指过去，仓库内被跟踪的 `.npmrc`（含 `@deepseek-ai` 镜像 pin）保持不变。
- 不自动升号：`version` 仍由用户手动改并作独立 chore 提交（见 AGENTS.md）。
- 取消跟踪 `artifacts/*.tgz`，并把 `artifacts/` 加入 `.gitignore`。
- 工作流固定用各 action 的当前主版本：`actions/checkout@v7`、`pnpm/action-setup@v6`、`actions/setup-node@v7`、`actions/upload-artifact@v7`。`pnpm/action-setup` 只有 v6 起才声明支持 pnpm 11（本仓库 `packageManager` 是 pnpm@11.8.0），v5 起才把 Node 24 作为 action 运行时；`actions/setup-node@v5` 起会在 `packageManager` 存在时自动开启包管理器缓存，v6 又把「自动缓存」收窄到 npm——本仓库显式写 `cache: pnpm`，因此不受这两次行为变更影响。

## 理由

- 以 tag 作为唯一发布入口，与"升号是独立 chore 提交"的约定契合：tag 就是那次 chore 提交的锚点，CI 无法自作主张地改版本。
- tag 与 `version` 强校验挡住最常见的误发——先打 tag 后忘了改 `package.json`，或改了却没提交；把校验放在所有构建之前，失败代价最小。
- 预发布版本默认落到 `latest` 是 npm 的既有行为，会把 rc 推给所有执行普通安装的用户；由版本后缀决定 dist-tag，让"发布通道"成为版本的函数，无需人工在每次发布时记得选。
- 让 GitHub Release 在 npm 成功之后创建：Release 页永远只指向真实存在的版本，否则会出现"有 Release 没有包"的状态。
- 用 `NPM_CONFIG_USERCONFIG` 而不是往 `.npmrc` 追加 token：仓库文件不必被 CI 弄脏，镜像 pin 也不会被覆盖；已在本地验证 pnpm 会读取该变量指向的配置。
- 仓库里存 tgz 快照会随代码漂移（1.0.0 的产物 ≠ 当前源码），构建产物应由 CI 现场产出。
- 发布前先用 `pnpm whoami` 校验凭据，再执行 `pnpm publish`：npm 对未授权的 PUT 一律回 404（实测无 Authorization、伪造 Bearer、伪造 Basic 三种情况全是 404），不先校验就会把"token 无效/只读"误报成"包不存在或权限不足"。同时打印 token 的长度与前缀（如 `npm_`），便于识别粘贴错误或把 GitHub PAT 误填进 secret。whoami 的身份与包 scope 不一致时给 warning（org 成员也可能有发布权，故不阻断）。

## 验证

- 本地复现 CI 全流程并通过：`pnpm run typecheck`、`pnpm test`（15 个文件 318 个测试全部通过）、`pnpm run build:all`（tsc 出 host 半边、tsdown 出 `lib/client.js`）。
- 前置事实核验：`pnpm@11.8.0` 存在于 npmjs；`pnpm pack --pack-destination <dir>` 在 11.8.0 上可用；`NPM_CONFIG_USERCONFIG` 指向的临时 npmrc 能被 pnpm 读到 `_authToken`，且仓库 `.npmrc` 未被改动。
- 两个工作流的 YAML 均按解析结果校验，tag/version 与 dist-tag 派生逻辑在本地用同一段 shell 复算。
- 推送首版工作流后 CI 实跑通过（run 37308252843，40s，`verify` 全绿并成功上传 `plugin-lib` 产物），确认 checkout/setup-node/action-setup/upload-artifact 这套组合在 GitHub runner 上可用。
- 升级 action 主版本后再跑一次同样全绿（run 37309345246，25s），且首跑时出现的 Node 20 弃用注解（点名 v4 系列）已消失，只剩一条 ubuntu-latest 将于 2026-10-19 迁移到 Ubuntu 26 的提示。
- 本地 `pnpm pack` 的产物清单核对：tarball 只含 `lib/*.js` + `lib/*.d.ts`、`cordis.patch.yml`、`locale/*.json`、`README*.md`、`icon.svg`、`package.json`、`LICENSE`，不含 `src/`、`.map` 或 `artifacts/`。
- 首次真实发布 run 37398605753 在 `Publish to npm` 失败：`[E404] 404 Not Found - PUT https://registry.npmjs.org/@gaohu9712%2fdsh-git-branch - Not found`；此前各步（tag 校验、版本未被占用校验、typecheck、318 测试、build、pack）全部通过。日志另有 `[WARN] Skipped OIDC: ERR_PNPM_ID_TOKEN_GITHUB_WORKFLOW_INCORRECT_PERMISSIONS`——pnpm 先尝试了 trusted publishing，因工作流没有 `id-token: write` 而跳过，随后回落到 token。
- 为定位该 404，用注册表只读接口探明：`GET https://registry.npmjs.org/-/org/gaohu9712/user` → 200 `{"gaohu9712":"owner"}`（伪造 org 同名接口返回 404，说明该接口可用于判定），即 `@gaohu9712` scope 确实存在且归 npm 用户 `gaohu9712` 所有；`GET /-/org/gaohu9712/package` → `{}`，说明当时 npm 上确实没有产生任何包。故该 404 与 scope 归属无关。
- 判别实验（对同一 PUT 端点）：无 Authorization、伪造 Bearer、伪造 Basic 全部返回 404，无法用状态码区分"未带 token""token 无效""token 只读"，因此改为在工作流内显式 `pnpm whoami` 前置校验；该段 shell 已用 stub `pnpm` 覆盖四个分支实测（凭据正常→继续发布；身份与 scope 不符→warning 但仍发布；whoami 失败→`::error::` 且不发布；secret 为空→`::error::`）。
- 加上前置校验后重跑（run 37398995517，tag 已重指向 26a7c78）立刻给出结论：`NPM_TOKEN: length=20 prefix=npm (masked)` 且 `[ERR_PNPM_WHOAMI_FAILED] Failed to find the current user: 401 Unauthorized`——**secret 已配置，但值只有 20 字符、叫 npm 拒绝为未授权**（真实 npm token 约 40 字符，故判断为粘贴被截断或 token 已失效/撤销）。这条 401 与 scope 归属无关，属凭据侧问题，需重新生成 token 后重跑，无需再动 tag。

- 账号开启 2FA 后，"能通过 whoami 校验"与"能发布"是两回事：run 37400026490（tag 重指到 `1bc8d1f`）里凭据本身完好（`NPM_TOKEN: length=40 prefix=npm_(masked)`、`Authenticated on npm as: gaohu9712`），但 PUT 仍被拒：`[E403] 403 Forbidden - PUT https://registry.npmjs.org/@gaohu9712%2fdsh-git-branch - Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.`。换成具备直发权限的凭据后 run 37401256250 全绿（47s），`Publish to npm` 打印 `✅ Published package @gaohu9712/dsh-git-branch@1.0.0`，紧接着 `Create GitHub Release` 创建 v1.0.0 并附上 tarball。故 403 属于凭据策略问题，与 scope 归属、工作流逻辑均无关。
- 新包的注册表读接口存在延迟：发布完成约 50 秒时 `npm view`、`GET https://registry.npmjs.org/@gaohu9712%2Fdsh-git-branch` 与 registry.npmmirror.com 全部返回 404，直到发布后约 4 分钟才读到 `latest=1.0.0`。**教训：新包发布后不能以即时的 404 判定发布失败**，应以 `✅ Published package` 与随后创建的 Release 为准，并间隔重试读取。
- 发布产物核对：registry 上的 tarball 共 23 个文件、118.3 kB（解包 436.7 kB），含 tsc 产出的 host 半边 `lib/*.js` + `lib/*.d.ts`、tsdown 产出的 client 半边 `lib/client.js`、`cordis.patch.yml`、`locale/{en,zh}.json`、`README*.md`、`icon.svg`、`LICENSE`，不含 `.map`、`src/`、`artifacts/`。

## 影响

- 正面：构建与发布从"依赖本机环境和人工步骤"变成 tag 触发的可复现流水线；push/PR 上先跑 typecheck + test + build，坏提交不会走到发布。
- 正面：仓库不再保存 tgz 快照，产物的唯一来源是那次 tag 对应的源码；GitHub Release 在 npm 成功之后创建，不会出现"有 Release 没有包"。
- 正面：凭据只存在于仓库 secret 与 runner 临时 npmrc 里，仓库内被跟踪的 `.npmrc` 与其镜像 pin 不被污染。
- 负面：发布依赖长期凭据 `NPM_TOKEN`，对账号侧 2FA 政策变化敏感（npm 已公告 granular token 的"绕过 2FA + 直接发布"将于 2027 年 1 月移除，见"遗留"）。
- 负面：工作流文件本身只在 tag 指向该提交时才生效，改动工作流后若不重新打 tag，旧 tag 仍按旧逻辑执行。

## 遗留

- `NPM_TOKEN` 已配置，`@gaohu9712/dsh-git-branch@1.0.0` 已发布到 npm（dist-tag `latest`），GitHub Release v1.0.0 已创建；未配置 secret 时发布步骤仍会带明确错误信息失败。
- **建议迁移到 trusted publishing（OIDC）**：npm 已公告 granular token 的"绕过 2FA + 直接发布"将于 2027 年 1 月移除。仓库侧改动很小——给 release 工作流加 `permissions: id-token: write`（pnpm 原生支持 OIDC，日志里的 `Skipped OIDC: ERR_PNPM_ID_TOKEN_GITHUB_WORKFLOW_INCORRECT_PERMISSIONS` 就是它已经试过的证据），之后即可不再依赖长期 token。但 `npm trust` 要求包已存在、且 CLI 需要 npm@11.15.0+（本机 11.6.0 连 `stage` 子命令都没有），所以配置只能放在首次发布之后，例如：`npx -y npm@^11.15.0 trust github @gaohu9712/dsh-git-branch --repo GaoHu1997/dsh-git-branch --file release.yml --allow-publish`（需以 2FA 登录；bypass-2FA 的 GAT 不被 trust 命令接受）。若不想用 OIDC，可改为 staged publishing（`npm stage publish` 由 CI 暂存 + 人工用 2FA 执行 `npm stage approve`），代价是每次发布多一步人工审批。
- 若将来需要 `dsh-alpha` 这类独立通道，应在 release 工作流上补一个 dist-tag 输入，而不是改动这里的派生规则。
- 本记录写完之后工作流又有一轮增量：发布前的 token 长度健全性检查与 `pnpm whoami` 前置校验（run 37713334297 的日志里可见），以及 Release 步骤打印最终状态并在草稿时告警（见 0004）。包名的两次变更见 0001、0003。
