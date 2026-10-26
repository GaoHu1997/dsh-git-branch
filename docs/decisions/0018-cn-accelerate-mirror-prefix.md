# 0018 — Git 管理面板加「国内加速」按钮（加速前缀 URL 重写）

状态: 已接受

日期: 2026-10-26

## 背景

国内网络访问 GitHub 频繁超时/断连，仓库在 GitHub 上时 fetch/update 直接失败（用户最早在 2026-10-26 提出「代码在 github 上很多时候链接不上」）。用户随后把范围收窄为「本地没有代理的」用户，并指定方案：URL 重写走加速前缀——在 Git 管理页面顶部加「国内加速」按钮，可自定义加速地址（默认 `https://gh-proxy.com/`），可启用/禁用，并给出 HTML 设计稿（`docs/design/cn-accelerate.md`、`docs/design/cn-accelerate-mockup.html`）。用户指令「按照这个方案执行」。

## 决策

- **机制：按命令注入 `git -c` 前缀重写，不动用户全局配置**。`accelArgs(prefix)`（`src/git.ts`）产出 `['-c', 'url.<prefix>/.insteadOf=https://github.com/']`，拼在子命令之前，把 `https://github.com/o/r.git` 重写为 `<prefix>https://github.com/o/r.git`。被否决：写用户全局 `git config --global url.…insteadOf…`——重写会泄漏到本插件之外的终端/工具，用户难以追溯；被否决：hosts 指定 IP——SNI 阻断下已失效。
- **只加速提取/更新，永不加速推送**。`fetchAll`/`updateBranch`（提取阶段）与新建工作树前置提取接受 `accelPrefix` 参数；`pushBranch` 不设该参数（设计如此，注释写明）。被否决：所有联网命令都重写——公共加速镜像没有 receive-pack，push 走镜像既失败得更难诊断（镜像报错替代直连报错），又把待推内容泄露给第三方；SSH 远端（`git@github.com:`）不属重写范围。
- **失效安全**：`accelArgs` 对 `undefined`/非法值返回 `[]`，命令退回直连；`validateConfig` 在加载时拒绝非法 `cnAccelerateUrl`（`GitWorktreeConfig: "cnAccelerateUrl" must be an http(s) URL without whitespace`），平时不会走到失效分支。被否决：启用加速后自动降级直连——把「镜像挂了」变成静默慢路径，用户失去明确反馈，本期不做。
- **配置键**（volatile，与 `fetchBeforeCreate` 同层）：`cnAccelerate`（默认 `false`）、`cnAccelerateUrl`（默认 `https://gh-proxy.com/`）。URL 校验（`accelerateUrlError`/`normalizeAccelerateUrl`，`src/normalize.ts`，宿主/客户端共享纯函数）：trim；空串报 `empty`；含空白字符或非 `http(s)://` 开头报 `invalid`；结尾缺 `/` 自动补上（前缀拼接必须以 `/` 结尾）。未设置时 `sectionOf` 不落 URL 键（只有布尔开关拼写默认值）。
- **表单：`AccelForm` 独立于 `CardForm`，一套实例两处入口**（`src/client/accel-form.ts`，浮层与设置卡共用一个实例挂在共享 `ConfigForm<SectionValue>` 上）。开关+URL 是一个提交单元，`saveAccel` 无条件写两个键（不做半对半错状态），校验不过不写。被否决：把字段并进 `CardForm` 随卡片草稿暂存——浮层保存会连带提交卡片里无关的 keep/copyFiles 草稿。设计文档 §3/§9 说「card-form.ts 新增字段与开关动作」，实现改为独立 `accel-form.ts` 且 `SectionValue` 只加字段类型，理由如上。
- **UI**：顶栏按钮（关=幽灵态「国内加速」+⚡；开=`rgba(76,107,245,.16)` 品牌色底+绿点），全局配置无需会话即可点；浮层含开关/说明/地址+「恢复默认」/错误行/取消·保存，Esc 与点外关闭并丢弃未保存草稿。设置卡片同一提交单元的行（开关+地址输入+说明），卡脚保存/取消同时提交两个单元。提取/更新失败的错误 toast 追加「若加速地址不可用，可停用国内加速或更换地址」（仅加速开启时），推送失败不追加。
- **文案复用既有词条**（沿 0016 惯例）：保存=`cardSave`、取消=`cancel`、标题=`panel.cnAccelerate`，不新增 `accel.save`/`accel.cancel`/`accel.title`；新增 `accel.saveFailed`（保存未生效——设计表漏了保存失败文案）。安全提示（镜像可见仓库内容，勿用于私有/敏感仓库）常驻浮层与卡片说明。

## 影响

- 正面：无代理的国内用户在提取/更新上获得一条可用路径，且一键开关、地址可换；加速地址失效时命令自动退回直连，不会比现状更糟。
- 正面：重写只存在于单条命令的 `-c` 参数里，不污染用户 git 全局配置；push 永远直连，保留既有推送失败诊断（0008）。
- 负面：公共加速站能看到仓库内容与流量，私有/敏感仓库不能用（已在界面提示）；第三方镜像站点存续不稳定（fastgit/kgithub 等已死），默认地址 `https://gh-proxy.com/` 将来可能失效，用户需自行更换。
- 负面：带凭据的远端 URL（`https://<token>@github.com/…`）与大小写变体（`https://GitHub.com/`）不命中 `insteadOf` 前缀，这些场景仍走直连；本期不做连通性测试按钮与自动降级。
- 兼容性：新增两个 volatile 配置键带默认值，旧配置无感；无新增 HTTP 路由（wire 契约不变），`RouteDeps` 只加两个可选 getter；locale 新增 `panel.cnAccelerate`/`accel.*` 键，en/zh 齐全；包版本保持不变（发版升号由用户发起）。
