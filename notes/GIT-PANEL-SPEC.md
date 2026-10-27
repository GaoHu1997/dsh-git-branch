# Git 管理面板(Git Panel)需求与技术规格

状态: 已实施(M1–M3 全量,M4 部分_merge 着色_ → 已由 0018 的 SVG lane 图取代;实现记录见 docs/decisions/0013、**0018**) · 结构决策: 面板为**上中下纵向堆叠**,不做左右分栏;提交记录点击后**向下展开**变更文件;分支**点击弹操作菜单**(IDEA 式);提交按钮**下置**并带分裂下拉(提交并推送);提交区含 **AI 生成提交信息**(调当前会话的模型);提交历史默认**全 ref 的 lane 图** + 区头三段服务端筛选 + 提交右键写操作

与本文档的实现偏差(以实现为准,均记录在决策 0013):

- 宿主契约(ui-sidebar / ui-layout / llm)以 `src/client/panel-types.ts` 的 declare-module 镜像引入,`package.json` 不新增 devDependencies(dsh-token-total 惯例)。
- 取消暂存用 `git reset -q HEAD --`(实测容忍未跟踪路径与未出生分支),非 `restore --staged`。
- AI 路由 `ctx.inject(['llm'])` 内挂载,流式 chunk 拼接后剥 markdown 围栏;模型选择从会话投影 `modelSelection.next ?? lastUsed` 读取。
- change 状态含 `T`(typechange);入口为 dsh-better-sidebar 右侧栏卡片(`ctx.betterSidebar.registerTab`,可选依赖经 `ctx.inject` 等待,未安装该插件的部署无卡片但其余功能不受影响;曾用左侧 panellist 行 + main 面板与会话级 conversation.view,均被用户验收反馈否决并移除)。

## 1. 目标与范围

在 DSH 右侧侧边栏新增全局面板入口「Git 管理」,打开后是主区域中的 Git 管理面板,纵向三段:

1. **① 未提交变更区(最上)** —— 工作区状态与提交操作:
   - 已暂存 / 未暂存两组文件列表(状态 M/D/?? 等);勾选 = `git add`,取消勾选 = `git restore --staged`;「全部暂存 / 全部取消暂存」
   - 提交信息输入框;**按钮行在输入框下方**: 左侧「✦ AI 生成」(调当前会话模型,按暂存 diff 生成信息,填充输入框供编辑),右侧**分裂按钮「提交 ▾」**(主体=提交;小三角下拉: 提交 / 提交并推送)
   - 同区工具位: 拉取(fetch)/更新(ff-only)/推送(push)
2. **② 分支操作区(中)** —— 分支列表;**点击分支行弹出操作菜单(IDEA 式)**:
   - 本地分支: 检出(当前分支禁用)/ 新建分支自此… / 重命名… / 删除(当前分支禁用,安全 `-d`)/ 复制名称
   - 远程分支: 检出(新建本地跟踪分支,dwim)/ 新建分支自此… / 复制名称
   - 区头「新建分支」(从当前 HEAD)
3. **③ 提交历史区(下)** —— 仓库提交历史(**默认 `--all` 全部 ref**,分页 50,**`--topo-order`**):
   - 区头筛选(顺序: **提交人、分支、时间**): 提交人输入框(失焦或 Enter 才提交,避免每敲一个字重走一次历史;空 = 不限)/ 分支下拉(选中即 `ref` 锁定,「全部 ref」= 走 `--all`)/ 时间下拉(全部、近 24 小时、近 7 天、自定义 —— 自定义展开两个 `<input type="date">`,结束日含当天 23:59:59.999);筛选全部翻译成 `/log` 参数在**宿主侧**生效,不是客户端过滤(分页下客户端过滤会静默漏掉后续页的匹配)
   - 提交行: **左侧 SVG lane 图**(LANE_PITCH 14px、8 色循环,实心圆 = 普通提交、空心环 = 合并提交;`through` 直行、`in` 上方汇入、`out` 下方分叉,曲线为三次贝塞尔)、主题、refs 徽章、作者、绝对时间 `YYYY/MM/DD HH:mm`、短哈希;**悬浮 → Tooltip**(主题、作者+邮箱、时间、哈希、文件数、refs)
   - **点击行 → 向下展开**该提交的变更文件(状态色块、路径、+/- 行数);同时只展开一条
   - **右键行 → 浮动菜单**: 基于此提交新建分支… / 在此提交打 tag…(名称 + 可选说明;有说明 = 附注标签 `-a -m`,无 = 轻量标签)/ 复制短哈希 / 复制提交信息;两个写操作都走 Modal 表单 + 区忙碌态,成功 toast 后整面板刷新
   - 「加载更多」按累积列表续页;lane 图对**整份累积列表**重算,分页边界不会断 lane

非目标(本期不做): diff 内容查看、作者头像网络获取、discard/force 等破坏性操作、文件级 blame、推送 tag(打 tag 只落本地,推送是独立发布动作)。

### 交互总览

```
┌──────────────────────────────────────────┐
│ ←  Git 管理    [dsh-git-branch·main ↓0↑2]  ⟳ │  顶栏: 返回 / 仓库+分支 / 刷新
├──────────────────────────────────────────┤
│ ▾ 未提交变更 [4]        拉取 · 更新 · 推送 │ ① 提交操作区(可折叠)
│   已暂存 [1]                 全部取消暂存 │
│     ☑ M package.json                      │
│   未暂存 [3]                     全部暂存 │
│     ☐ M src/git.ts   ☐ ?? notes/x.md      │
│   [ 提交信息(chore: …)              ]     │
│   [✦ AI 生成]                [提交 ▾]     │ ← 按钮行在输入框下方
│                                ┌────────┐ │    ▾ 下拉: 提交 / 提交并推送
│                                └────────┘ │
├──────────────────────────────────────────┤
│ ▾ 分支 [本地 3 · 远程 5]       + 新建分支  │ ② 分支操作区(点击行弹菜单)
│   ✓ main                        ↓0 ↑2     │
│     feat/git-panel  ← 点击弹:            │
│     ┌─ 分支 feat/git-panel ──────┐        │
│     │ → 检出                    │        │
│     │ ⇱ 新建分支自此…           │        │
│     │ ✎ 重命名…  🗑 删除        │        │
│     │ ⧉ 复制名称                │        │
│     └───────────────────────────┘        │
│     origin/dev                      │
├──────────────────────────────────────────┤
│ ▾ 提交历史   [提交人…] [分支 ▾] [时间 ▾]  │ ③ 提交历史(区头三段筛选)
│   ●─╮ chore: 版本号升到 1.0.2 [v1.0.2]    │ ← 左 lane 图: 实心圆 = 提交
│   │ ●  fix: 设置面板按 Host 条目 id …      │    空心环 = 合并;曲线 = 分叉/汇入
│   │ │  奋斗的小高  2026/10/15 23:29 2c3ded5│    作者 + 绝对时间 + 短哈希
│   │ │  └─ 变更文件(3)· 作者 · 时间         │ ← 点击向下展开
│   │ │      M package.json        +1 -1     │
│   ●─╯ 右键: 新建分支 / 打 tag / 复制…      │ ← 右键浮动菜单(FloatMenu portal)
│   [加载更多]                               │
└──────────────────────────────────────────┘
```

数据刷新时机: 面板打开、会话 cwd 变化、手动刷新、拉取/更新/推送/提交/签出成功后。不做轮询与文件监听。

## 2. 技术方案(双端架构不变)

host 半边出 HTTP 路由(纯函数 handler + 可注入 exec 缝),client 半边注册插槽组件,`wire.ts` 承载契约。

### 2.1 入口与面板挂载(client)

- `sidebar.panellist` 注册行: id `git-history`,label「Git 管理」,git-branch 图标,order 40
- `main` keyed 槽注册面板本体: key `git-history`(与行 id 一致);`ctx.layout.selectPanel('git-history')` 打开
- 面板左上「← 返回」: 订阅 `ctx.layout.panelInfo` 记住来路面板(dsh-token-total 同款)
- cwd 来源: 从 `ctx.sessions.list` 派生主视图会话(`retainedBy.mainView`)cwd 的响应式 observable,经 inject 的 `hooks.cwd` 注入;仓库变化即整面板重载
- 兼容性: 面板注册整体包在 `ctx.inject(['layout'], …)` 内,老宿主(无 layout 服务/无插槽声明)静默跳过,现有 chip 与设置卡不受影响
- 面板组件 ctx-free: 数据请求直接调 `api.ts`;框架动作(返回/cwd)走 inject 面

### 2.2 host 半边: 路由全景

新增 7 条路由(6 条 git + 1 条 AI 生成);**签出与分支增删改、拉取/更新/推送全部复用现有路由**(/switch、/branch、/branch-rename、/branch-delete、/fetch、/update、/push)。

```
POST /plugin/git-worktree/changes        工作区变更(已暂存/未暂存明细)   新增
POST /plugin/git-worktree/stage          批量暂存 / 取消暂存              新增
POST /plugin/git-worktree/commit         提交暂存区(git commit -m)       新增
POST /plugin/git-worktree/log            提交历史(分页 + all/author/since/until)  新增
POST /plugin/git-worktree/commit-files   单次提交的变更文件               新增
POST /plugin/git-worktree/tag            在某提交上打标签                 新增
POST /plugin/git-worktree/ai-commit-message  AI 生成提交信息(ctx.llm)   新增
POST /plugin/git-worktree/switch|branch|branch-rename|branch-delete|fetch|update|push   复用
GET  /plugin/git-worktree/status         仓库事实(分支列表/ahead-behind) 复用
```

分支操作菜单 → 路由映射: 检出=`/switch`(远程分支走 dwim 建跟踪);新建分支自此…=`/branch` 带 `from`(不勾 checkout,不动当前检出);重命名=`/branch-rename`;删除=`/branch-delete`(安全 `-d`);复制名称=客户端剪贴板。「提交并推送」= `/commit` 成功后接 `/push`(失败各自 toast)。

提交行右键菜单 → 路由映射: 基于此提交新建分支…=`/branch` 带 `from`(**不勾 checkout**: 从历史提交建分支不能把工作区切走);在此提交打 tag…=`/tag` 带 `target`(提交哈希)+ 可选 `message`;复制短哈希 / 复制提交信息=客户端剪贴板。

#### git 封装(src/git.ts 新增)

`workingChanges(exec, cwd)`:

```
git status --porcelain=v1 -z
```

- NUL 分隔解析(文件名含空格/中文安全);XY 状态码 → 每文件 `staged`(X: 'M'/'A'/'D'/'R'/'C')与 `unstaged`(Y: 'M'/'D')、`untracked`('??');暂存组 = X≠空格,未暂存组 = Y≠空格 或 untracked;重命名解析 `old → new`(core.quotepath 处理:加 `-c core.quotepath=false` 防八进制转义)

`stagePaths(exec, cwd, paths, stage)`:

```
git add -- <paths…>                 # stage=true
git restore --staged -- <paths…>    # stage=false
```

- 路径校验: 必须来自 /changes 输出的相对路径;拒绝绝对路径、`..` 段、数量上限 500;execFile 参数数组传递,无 shell

`commitIndex(exec, cwd, message)`:

```
git commit -m <message>
```

- message trim 后非空、长度 ≤ 2000;hooks 照常执行(不加 --no-verify);空暂存区由 git 拒绝(错误原文透出);不加 --allow-empty(与 0009 禁空推送同一取向)

`logHistory(exec, cwd, limit, skip, ref?, filter?)`:

```
git log --max-count=N --skip=M --topo-order --date=iso-strict
  [--all] [--author=<needle>] [--since=<iso>] [--until=<iso>] [<ref>]
  --pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s%x1f%b%x1f%D%x1e
```

- 字段 `%x1f`/记录 `%x1e` 分隔;`%P` 父哈希(>1 = merge,SVG 画空心环);`%D` → refs 数组;ref 先 `rev-parse --verify` 校验(校验通过后用**解析出的对象 id**,不是 ref 名作起点),非法 → 400;limit 默认 50 上限 200
- **`--topo-order` 恒定**: lane 图只靠 `parents` 推列,日期序会把分支提交排到它的 merge base 之前,边会指向尚未绘制的行
- `filter.all` 且未指定 ref 时加 `--all`(面板默认视图: 一张图装下所有分支/tag 及其合并边);**ref 优先于 all**,否则「看某分支」会串出全部历史
- `author`(≤200 字符)、`since`/`until`(正整数 epoch ms,`until ≥ since`)由 `/log` 校验后交给 git;条数上限仍由 `limit` 管
- `%an` 作者名、`%ad` ISO 严格时间(面板按字段格式化成 `YYYY/MM/DD HH:mm`)

`createTag(exec, repoRoot, name, target?, message?)`:

```
git tag [-a <name> -m <message>] <name> [<target>]
git rev-list -n 1 <name>            # 回读 tag 指向的对象 id
```

- 有 `message` → 附注标签(`-a -m`,带打标签者与日期,`git describe` 优先);无(或全空白) → 轻量标签
- 走 `facts.repoRoot`(**仓库级 ref**,不碰任何 checkout);`target` 限 `/^[0-9a-fA-F]{4,64}$/`(历史卡片只发哈希,收紧成 object-id 形状可杜绝字符串以 flag 形式混进 `git tag`);name 非空、不以 `-` 开头、≤300;message ≤5000;重名/非法名由 git 拒绝并透出 stderr(400)
- **只落本地**: 推 tag 是独立发布动作,不挂在右键一次点击上

`commitFiles(exec, cwd, hash)`:

```
git rev-parse --verify --quiet <hash>^{commit}
git show --numstat --name-status -M --format= <hash>
```

- 状态归一 A/M/D/R/C/T;`--numstat` 的 `-` = 二进制;R 解析 `old => new` 与相似度

#### AI 生成提交信息(host,`ctx.llm` 一次性调用)

宿主进程的 LLM 服务 `ctx.llm: LlmRuntime` 对 cordis Context 开放(`@deepseek-ai/dsh-llm`),其 `stream(options: GenerateOptions)` 官方支持 hand-built one-shot(带独立 `system`、`messages`、`temperature`、`maxTokens`)。**使用当前会话的模型**: 客户端从主视图会话读出模型选择(provider / model / effort)随请求传入。

`POST /ai-commit-message`,body `{ repoPath, provider, model, effort?, hint? }`:

- 暂存 diff: `git diff --cached`(无暂存时回退 `git diff` + untracked 文件名清单),截断至 ~12k 字符
- few-shot 风格: `git log -10 --pretty=%s` 的最近提交主题一并进 prompt,使生成结果贴合仓库语言与 conventional-commit 习惯
- system: 「你是提交信息生成器,输出一行 conventional commit 主题,可选 body,不解释」;user: diff + 风格样例 + 用户 hint(输入框已有草稿时作为改写要求)
- `ctx.llm.stream({ provider, model, ...(effort ? { reasoningEffort: effort } : {}), messages, system, temperature: 0.2, maxTokens: 500 })`,流式拼接为文本,trim 后返回 `{ message }`
- 服务缺失降级: 路由注册包在 `ctx.inject(['llm'], …)` 内,宿主无 llm 服务时不注册;客户端按 404 隐藏 AI 按钮
- 安全边界: diff 只作 prompt 输入;生成结果只填充输入框,提交永远由用户点击;模型/配额费用与普通对话一致(一次小调用)

#### wire 契约(src/wire.ts 新增类型,略举)

```ts
ROUTE_CHANGES / ROUTE_STAGE / ROUTE_COMMIT / ROUTE_LOG / ROUTE_COMMIT_FILES

interface WorktreeChange { path: string; oldPath?: string;
  staged?: 'M'|'A'|'D'|'R'|'C'; unstaged?: 'M'|'D'; untracked?: boolean }
interface ChangesBody { repoPath: string }
interface ChangesResult { changes: WorktreeChange[] }
interface StageBody { repoPath: string; paths: string[]; stage: boolean }
interface StageResult { staged: boolean }
interface CommitBody { repoPath: string; message: string }
interface CommitResult { hash: string; subject: string }
interface CommitEntry { hash; short; authorName; authorEmail; date(epoch ms); parents: string[];
  subject; body; refs: string[] }
interface LogBody { repoPath: string; limit?: number; skip?: number; ref?: string;
  all?: boolean; author?: string; since?: number; until?: number }
interface LogResult { commits: CommitEntry[] }
interface CommitFileEntry { path; oldPath?; status: 'A'|'M'|'D'|'R'|'C'|'T';
  insertions?: number; deletions?: number; binary?: boolean }
interface CommitFilesBody { repoPath: string; hash: string }
interface CommitFilesResult { hash: string; files: CommitFileEntry[] }
ROUTE_TAG = '/plugin/git-worktree/tag'
interface CreateTagBody { repoPath: string; name: string; target?: string; message?: string }
interface CreateTagResult { tag: string; hash: string }
ROUTE_AI_COMMIT_MESSAGE
interface AiCommitMessageBody { repoPath: string; provider: string; model: string; effort?: string; hint?: string }
interface AiCommitMessageResult { message: string }
```

### 2.3 client 半边: 组件结构

| 文件 | 职责 |
|---|---|
| `src/client/GitHistoryPanel.tsx` | 面板页面: 顶栏 + 三段区块;`GitPanelIcon`(侧边栏行图标) |
| `src/client/panel/UncommittedSection.tsx` | ① 暂存/取消暂存/提交;按钮行 = AI 生成(读会话模型选择)+ 分裂提交按钮(提交 / 提交并推送) |
| `src/client/panel/BranchSection.tsx` | ② 分支列表 + 点击行弹 IDEA 式操作菜单(检出/新建自此/重命名/删除/复制;复用 BranchMenu 的确认弹窗与 api 调用模式) |
| `src/client/panel/HistorySection.tsx` | ③ 提交区头三段筛选(提交人/分支/时间)+ lane 图提交列表 + 行内展开文件 + Tooltip + 右键浮动菜单 + 新建分支/打 tag 弹窗;分页「加载更多」 |
| `src/client/git-graph.ts` | 纯函数 lane 布局: `buildGraph(commits) → GraphRow[]`(列分配、through/in/out 边、`trimWidths` 收窄死列)、`graphWidth(rows)`;无 React/DOM,可单测 |
| `src/client/panel/CommitGraph.tsx` | 单行 SVG lane 图: `LANE_PITCH=14`、44px 曲线坐标系按实际标题行高铺满、8 色 `LANE_COLORS`、`laneColor(lane)`、`bend()`(同列直线 / 跨列三次贝塞尔)、固定圆点(实心 = 提交、空心 = 合并);展开文件区把所有 `through/out` 车道延长至行底 |
| `src/client/panel/FloatMenu.tsx` | 共享浮层(portal + 点击外部/Escape 关闭 + useLayoutEffect 视口钳制);② 区分支菜单与 ③ 区提交右键菜单同源 |
| `src/client/git-panel-data.ts` | 纯函数: porcelain -z 解析、refs 徽章分类、搜索过滤、分页状态机 |
| `src/client/GitHistoryPanel.module.css` | 样式(CSS Modules 内联管线现有) |
| `src/client/panel-types.ts` | `layout` 服务窄镜像 + `'main'` 插槽声明合并(type-only) |

复用: `fetchStatus`(分支列表/ahead-behind)、`requestSwitch/CreateBranch/RenameBranch/DeleteBranch/Fetch/Update/Push`(② 区与 ① 区工具位)、`Tooltip`/`Toast`/`Button`/`Tag`/`FileTypeIcon` 基元、`relative-time.ts`。签出有未提交冲突时 git 拒绝 → toast 原文(与 chip 一致);分支删除用安全 `-d`,不带 `-D`。

### 2.4 依赖与构建

- devDependencies 新增(type-only): `@deepseek-ai/dsh-client-ui-sidebar@0.2.0-rc.1`、`@deepseek-ai/dsh-client-ui-layout@0.2.0-rc.1`、`@deepseek-ai/dsh-llm@0.2.0-rc.1`(host `ctx.llm` 类型;服务由宿主运行时注入,缺失时 AI 按钮降级隐藏)
- `dsh.client.inject` 不变;tsdown 管线不变;**版本号不动**

### 2.5 测试

- `tests/git-panel.spec.ts`: porcelain -z 解析(中文路径、重命名、untracked)、log `%x1f/%x1e` 解析(多行 body、merge、空 refs)、numstat/name-status 联合解析(二进制、R 相似度)、stage/commit 参数拼装、`logHistory` 的 `--topo-order`/`--all`/`--author`/`--since`/`--until` 与「ref 压过 all」、`createTag` 轻量/附注/空白说明/拒绝透出
- `tests/git-graph.spec.ts`: `buildGraph` 线性历史单列、merge 开列 + fork 收列、无父提交不画上边、释放的列被后续 tip 复用、`trimWidths` 不为下方才开的列预留宽度、空历史
- `tests/history-graph-browser.spec.ts`: 使用 Playwright + Edge/Chromium 检查 `getScreenCTM()` 屏幕端点，断言行边界及展开区 0.5px 内连续，覆盖线性/合并/并行 lane、loading/失败/空/多文件、窄宽/高行高/125% zoom/分页布局
- `tests/history-filters.spec.ts`: 时间窗(近 24h/近 7 天/自定义)、`parseDayStart/End` 按**浏览器时区**解析且结束日含当天、`historyQueryFor` 默认 `all`、选分支后 `ref` 压掉 `all`、author trim/空值省略
- `tests/routes-git-panel.spec.ts`: 各 handler 的 body 校验、未知键拒绝、非法 ref/hash/message/timestamp → 400、`/log` 的 all/author/since/until 透传与合法性、`/tag` 成功/重名 400/非仓库 400、fake exec 注入(现有 RouteDeps 缝)
- `tests/client-apply-panel.spec.ts`: layout 缺失时面板不注册、chip/设置卡不受影响;hooks.cwd 响应 cwd 变化

## 3. 边界情况

| 情况 | 行为 |
|---|---|
| 无主视图会话 / cwd 非 git 仓库 | 面板空态引导文案,三区块均不渲染 |
| 工作区干净 | ① 区显示「没有变更」,提交区折叠留提示 |
| 空暂存区提交 / 空信息 | 提交按钮禁用 + 提示;绕过时 git/handler 拒绝 |
| 签出冲突(未提交改动) | git 拒绝,toast 原文,分支不变 |
| 中文/空格路径 | `porcelain -z` + `core.quotepath=false`;路径全程原样传递 |
| 空仓库(无提交) | ③ 区「仓库还没有提交」;①② 正常 |
| 多分支/合并历史 | 默认 `--all` + `--topo-order` 一次走全库;lane 图对整份累积列表重算,跨「加载更多」不断列;合并提交画空心环,分叉/汇入为贝塞尔曲线 |
| 只有一条分支 | 图只占一列(每行宽度按实际用到的列收窄,不留死列) |
| 筛选后无匹配 | ③ 区「没有匹配的提交」;筛选条件本身保留可改 |
| 自定义时间反向(起 > 止) | 前端日期输入只产出两端;宿主对 `until < since` 返回 400,不会静默返回空 |
| 打 tag 重名/非法名 | git 拒绝,400 + stderr 原文 toast;仓库 ref 不变 |
| 打 tag 的提交不在任何 checkout 上 | 路由跑在 `facts.repoRoot`,与工作区无关,照样成功 |
| detached HEAD | 分支名显示 `HEAD`(与 /status 约定一致) |
| 会话在 linked worktree | 所有命令 cwd = 会话目录 toplevel: 暂存/提交/历史/签出均作用于该 worktree 自身(签出走 /switch 的 worktree 语义) |
| 大仓库 | 历史分页 50/页(上限 200);/changes 上限 500 行 + 「仅显示前 N」 |
| 并发操作(连续提交/签出/刷新) | 请求序号守卫,旧响应丢弃 |
| hook 拒绝提交 | git 原文 toast,暂存区保持 |
| 宿主无 llm 服务 / 模型不可用 | AI 路由 404,客户端隐藏 AI 按钮;生成失败 toast,输入框保持原值 |
| AI 生成超时/中断 | 按钮恢复可点,可重试;AbortSignal 透传 |

## 4. 里程碑

1. **M1 host 层**: wire 契约 + git.ts 五个封装 + 五条 git 路由 + 单测
2. **M2 面板 UI**: 三段式面板 + 侧边栏入口 + i18n + 空态/错态 + 交互(暂存勾选、分裂提交按钮、分支操作菜单、展开、Tooltip、搜索)
3. **M3 AI 生成**: /ai-commit-message 路由(ctx.llm)+ AI 按钮(读会话模型选择)+ few-shot prompt + 失败降级
4. **M4 打磨**: 区块折叠记忆、分支过滤(本地/远程切换)、~~merge 着色~~ → **已完成**: SVG lane 图(分叉/合并曲线、8 色循环、空心环标合并)、区头三段服务端筛选(提交人/分支/时间 + 自定义区间)、提交右键菜单(新建分支/打 tag/复制)、时间显示改绝对时刻(见 docs/decisions/0018)

## 5. 文件变更清单

```
src/wire.ts                        +7 路由常量 +12 类型(含 ROUTE_TAG、LogBody 筛选字段、CreateTagBody/Result)
src/git.ts                         +workingChanges +stagePaths +commitIndex +logHistory(+-topo-order/--all/--author/--since/--until) +createTag +commitFiles +stagedDiff
src/routes.ts                      +handleChanges +handleStage +handleCommit +handleLog(筛选参数校验) +handleCreateTag +handleCommitFiles +handleAiCommitMessage
src/index.ts                       +6 postRoute 注册(含 /tag)+ /ai-commit-message(ctx.inject(['llm']) 内,缺服务不注册)
src/client/api.ts                  +requestChanges +requestStage +requestCommit +requestLog(HistoryQuery 对象参数) +requestCreateTag +requestCommitFiles +requestAiCommitMessage
src/client/GitHistoryPanel.tsx     新(面板页 + 侧边栏图标;持有 historyFilters,筛选变化重走 loadAll)
src/client/git-graph.ts            新(lane 布局纯函数 buildGraph/graphWidth)
src/client/panel/CommitGraph.tsx   新(单行 SVG lane 图)
src/client/panel/FloatMenu.tsx     新(共享浮层: portal + 视口钳制;②③ 两处菜单复用)
src/client/panel/UncommittedSection.tsx  新(AI 生成 + 分裂提交按钮)
src/client/panel/BranchSection.tsx 新(IDEA 式分支操作菜单;浮层已抽到 FloatMenu)
src/client/panel/HistorySection.tsx 新(筛选栏 + lane 图列表 + 右键菜单 + 建分支/打 tag 弹窗)
src/client/git-panel-data.ts       新(解析/过滤纯函数 + historyRangeBound/historyFilterBound/historyQueryFor)
src/client/GitHistoryPanel.module.css 新
src/client/panel-types.ts          新(layout 镜像 + 'main' 声明合并,type-only)
src/client/index.ts                +面板注册(cwd observable / goBack)
src/client/locales.ts              +文案 keys(zh 为源,en 同步)
package.json                       +3 devDependencies(type-only;version 不动)
tests/git-panel.spec.ts            新
tests/routes-git-panel.spec.ts     新
tests/client-apply-panel.spec.ts   新
tests/git-graph.spec.ts            新(lane 布局)
tests/history-filters.spec.ts      新(时间窗与查询拼装)
docs/decisions/0013-git-history-panel.md  新(面板首次落地)
docs/decisions/0018-git-history-graph-panel.md  新(图样式 + 三段筛选 + 右键写操作)
```
