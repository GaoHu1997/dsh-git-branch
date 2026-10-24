# 0013 — Git 管理面板（侧边栏全局面板 + 提交操作 + AI 提交信息）

状态: 已接受

日期: 2026-10-24

## 背景

用户要求在右侧侧边栏新增一个类 IDEA Git 页面的「Git 管理」面板：上中下三段（未提交变更 + 提交操作、分支操作、提交历史），点击提交记录向下展开变更文件，点击分支弹出操作菜单，提交按钮带「提交并推送」下拉，并由当前会话的模型生成提交信息。

宿主的 ui-sidebar / ui-layout / dsh-llm 包不是本插件的依赖（浏览器 bundle 禁止 import 宿主包），插件程序里没有这些插槽与服务的类型；同时「当前会话的模型」在客户端的存放位置（会话投影）需要一条不依赖宿主内部实现的读取路径。取消暂存、空仓库分页等 git 行为细节也需要确定语义。

## 决策

- **入口（dsh-better-sidebar 右侧栏卡片，最终形态）**：用户截图定位后确认，目标位置是 dsh-better-sidebar 插件渲染的右侧栏——该插件公开 `ctx.betterSidebar` 服务（`registerTab(descriptor)`）供第三方插件贡献侧栏卡片（文件/Git/终端等卡片即其 builtin）。本插件经 `ctx.inject(['betterSidebar'])` 等待该服务后注册一张卡片（id `git-history`，`single: true`，thunked title/description 跟随 locale，icon 用 primitives 的分支图标，order 150 排在 builtin 之后）；组件收到的 `scope` 直接携带 sessionId/cwd，模型选择从会话列表投影读取。better-sidebar 是**可选**插件：`ctx.inject` 的等待语义使未安装它的部署不显示卡片，chip 与设置卡不受影响；disposer 挂在本插件 fiber（ctx.effect），插件重载即收回卡片类型。被否决的历程：左侧 `sidebar.panellist` 行 + keyed `main` 面板（入口位置不对，且 layout 服务先后试过 `ctx.get` 探针——服务晚注册时永远错过、实测入口不出现的根因——与插件级 inject 硬依赖）；会话级 `conversation.view` 条目（入口出现在会话头部 View 标签栏，仍不是用户指的右侧栏，已随本决策移除）。
- **类型镜像而非 devDependencies**：better-sidebar 的服务形状（registerTab 描述符、SessionScope、会话列表读取面）以 `src/client/panel-types.ts` 的 type-only 镜像表达，沿用 dsh-token-total 对宿主契约的镜像惯例；`package.json` 保持不动（被否决：新增 devDependencies 需要联网安装、扩大 peer 面，而镜像零成本且已有先例；早期为左侧入口镜像的 `sidebar.panellist`/`main`/layout 契约随入口改版一并移除）。
- **路由**：host 半边新增 6 条——`/changes`（porcelain -z 解析）、`/stage`、`/commit`、`/log`（分页，ref 经 `rev-parse --verify` 校验）、`/commit-files`（name-status + numstat 按行合并）、`/ai-commit-message`。检出、新建/重命名/删除分支、拉取/更新/推送全部复用既有路由，不重复实现。AI 路由挂载在 `ctx.inject(['llm'])` 内，宿主无 llm 服务时 404，客户端隐藏 AI 按钮。
- **AI 生成**：host 用 `ctx.llm.stream` 一次性调用（`GenerateOptions` 的 hand-built one-shot 形态），diff 截断 12k 字符并附带最近 10 条提交主题做风格 few-shot；provider/model/effort 由客户端从主视图会话的 `projectionsBySession[id].values.modelSelection`（`next` 优先回退 `lastUsed`）读取后随请求传入——即「使用当前会话中的模型」。生成结果只填充输入框，提交永远由用户点击。
- **git 语义**：取消暂存用 `git reset -q HEAD -- <paths>`（实测对未跟踪路径与未出生分支都是静默成功），不用会报错的 `restore --staged`；提交不带 `--allow-empty`（与 0009 禁空推送同取向）；删除分支只用安全 `-d`；工作树与历史读取都以会话目录自身 toplevel 为根，linked worktree 会话看到自己的工作树。
- **展示**：三段纵向堆叠，提交行悬浮 Tooltip（主题·作者 <邮箱>·时间·哈希）、点击行内展开变更文件（同时只展开一条）；merge 提交圆点着色；refs 徽章按 HEAD/tag/remote/local 分类。

## 影响

- 正面：侧边栏获得与用量统计同级的 Git 全局面板，提交/暂存/签出/历史一站式完成；老宿主（无 layout、无插槽声明、无 llm）逐层降级，既有功能零影响。
- 正面：包不新增依赖，构建产物与发布流程不变；53 项新测试覆盖解析、路由与注册行为。
- 负面：`panel-types.ts` 保存了一份宿主契约镜像，宿主修改 `sidebar.panellist`/`main`/layout 的形状时需要同步（与 dsh-token-total 相同的代价）。
- 负面：linked worktree 会话内「检出」经 `/switch` 作用于主检出（与 chip 的既有语义一致），面板刷新后显示的仍是该 worktree 自身分支——跨 worktree 检出语义留待后续决策。
- 兼容性：`main`/`sidebar.panellist` 为宿主声明插槽，插件只注册不声明；宿主版本回退到没有这些插槽的形态时注册静默不生效。包版本保持不变。

## 复审修正（同日，随本变更集一并落地）

实现复审发现若干逻辑漏洞与"规格已写、实现未接线"的缺口，修正如下（均为对上述决策的落地补全，不改变方向）：

- **非仓库空态**：`/status` 的 `repo: false` 分支此前落到加载态；现渲染 `panel.notARepo` 空态（规格 §3 原有要求）。
- **当前分支菜单**：分支行点击不再对当前分支短路，菜单照常弹出、仅隐藏检出与删除两项；重命名/新建自此/复制名称对当前分支可用。
- **Toast 色调**：错误提示不再渲染绿色成功对勾；`pushToast` 携带色调，错误走原语默认警告样式。
- **竞态守卫收敛**：暂存/取消暂存突变后的重读统一走 `loadAll`（推进请求序号），旧快照不再能覆盖突变后的新状态；「加载更多」同样尊重序号。
- **未合并状态**：porcelain 的 XY 未合并对（UU/DD/AU/UD/UA/DU/AA）解析为 `unstaged: 'U'` 冲突行（红色徽标，勾选 = `git add` 解决冲突），不再把 `U` 硬塞进既有状态联合。
- **空仓库判定**：`git log` 失败时改用 `rev-parse --verify HEAD` 二次探测判定 unborn，不再匹配 locale 相关的 stderr 文案。
- **补接线**：顶栏刷新按钮（`panel.refresh`）、`/changes` 500 行截断（`truncated` 标记 + 面板提示）、提交输入框 `maxLength` 与 host 共享 `COMMIT_MESSAGE_LIMIT`（wire 常量）、AI 按钮在无任何变更时禁用（`panel.aiNeedsChanges`）、`key={cwd}` 真正按目录重挂载数据组件、Space 键 `preventDefault`、删除死键 `panel.upToDate`/`panel.aiNoModel`/`panel.checkoutBusy` 与从未被引用的 `historyRefForBranch`。
- **仍留待后续**：merge 提交的文件列表走 combined diff（干净合并常为空）是否改 first-parent 语义；AI 生成尚无 AbortSignal 透传（依赖宿主 llm.stream 的信号支持）；行悬浮 Tooltip 暂不含文件数（需逐提交额外请求）。
- **入口改版（用户验收反馈）**：首次交付把入口做在左侧 `sidebar.panellist` 行 + `main` 全局面板，用户指出目标位置是**右侧侧边栏**（会话头部的右侧栏展开入口展开的侧栏，内含 View 卡片，点卡片出现管理页面）。改为注册会话级 `conversation.view` 条目（同会话用量的挂载点）：宿主拥有卡片与选中呈现，面板内容从会话标准工具派生 cwd 与模型选择（不再需要 cwd observable 与注入面），back 按钮/布局历史随宿主导航一并移除，layout 依赖撤销。返工中一并修正了 `ctx.get` 探针的加载顺序竞争（layout 晚注册时入口永远不出现——第一次"入口不出现"报告的根因）。
- **入口再改版（用户截图定位）**：`conversation.view` 版本实际生效（会话头部 View 标签栏出现「Git 管理」），但用户截图指明目标位置是右侧栏展开后的卡片列表——那是 dsh-better-sidebar 插件的 UI,不是宿主内置。改为经 `ctx.betterSidebar.registerTab` 注册卡片并移除 conversation.view 条目（单一入口,避免头部标签与侧栏卡片并存）;cwd/模型选择的派生从会话标准工具钩子换成 tab scope + 会话列表 store 的 useSyncExternalStore 读取。
- **侧栏实测修正（用户验收第二轮）**：右侧栏（better-sidebar tab 面板）为定高 flex 纵向容器，区块子项默认可收缩——内容超屏时区块被压扁、内容溢出叠到后续区块上（分支区空、提交框漂移），`.section` 改 `flex: none` 由容器整体滚动。AI 一次性调用按 dsh-llm 实际契约修正：user 消息 content 必须是内容块数组（`[{type:'text',text}]`，纯字符串被拒），流式文本只折叠 `text-delta` chunk（`reasoning-delta` 也携带 text 字段）。主按钮蓝色加字面量 fallback（better-sidebar 面板内 brand token 未必可达），提交分裂菜单紧凑化（`width: max-content`、去副文案），分支区改为 本地/远程 两个可折叠树（远程按 remote 名二级分组、行内去 `<remote>/` 前缀）。
