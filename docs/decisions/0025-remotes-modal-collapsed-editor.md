# 0025 — 远程对话框改用密钥对话框的折叠编辑器范式

状态：已接受  
日期：2026-10-29

## 背景

0022 落地的 `RemotesModal` 把编辑表单常驻在列表下方：对话框一打开，分界线、表单标题、两个输入框和「保存」按钮就在眼前，哪怕用户只是想看看现有远程指向哪里。0021 的 `CredentialModal` 走的是另一种形状——列表是默认视图，标题行的「+」才展开编辑器，「取消」只收起编辑器，关闭整个对话框的动作在对话框自己的底部。

两个对话框本质上是同一类东西（一个列表 + 单条编辑器），交互却不一致。用户要求：添加远程也要先点新增按钮才出现填写框，取消与保存按钮参考密钥配置。

## 决策

- `RemotesModal` 引入 `editorOpen` 状态，整块编辑器（`credDivider` + `credFormTitle` + `credForm` + `credFooter`）收进 `{editorOpen ? … : null}`，与 `CredentialModal` 同构。`resetEditor` 一并把 `editorOpen` 置回 false，于是「保存成功」「取消」「删掉正在编辑的那个远程」三条路径都自然回到纯列表视图。
- 标题行复用既有的 `credTop` / `credAdd` 类，按钮 `title` 与 `aria-label` 取 `remotes.add`、`aria-expanded` 绑 `editorOpen`；行内「修改地址」在 `startEdit` 里同时 `setEditorOpen(true)`，`name` 字段仍按编辑态只读。
- 编辑器动作行统一成密钥配置的那一对：`variant="outline"` 的「取消」（`t('cancel')`，收起编辑器）+ `variant="primary"` 的「保存」，且只在编辑器展开时渲染。对话框底部那颗 ghost 按钮从 `t('cancel')` 改为 `t('close')`：关闭弹窗与取消编辑是两个动作，此前混用「取消」会让底部那颗按钮看起来像要撤销表单。
- locale 里 `remotes.add` 的中文由「添加远程」改为「新增远程」，与 `cred.add`「新增密钥」同措辞——这个 key 现在同时充当「+」按钮的 tooltip 和新建态的表单标题。
- 不抽公共的 `CollapsibleEditor` 组件：两边的字段差异远大于相似（预设域名、认证方式切换、取令牌链接 vs 只有 name/url 两项），抽出来只会把差异塞进一串 props。复用止于 CSS 类与交互约定。

## 影响

- 正面：远程对话框打开即列表，零远程时是空态加一个「+」；想动手才见到输入框，视觉噪声少一层，也和密钥配置读起来像同一个设计。
- 行为变化：编辑态点「取消」现在连编辑目标一起清空（回到列表），旧实现只清 `editing`、表单还留在原地。
- 新增 `tests/remotes-modal.spec.ts`：宿主 `Modal` 以 `createPortal(…, document.body)` 结尾，node 环境的 vitest 渲染不了，因此把 UI 原语 mock 成只渲染 children 与 footer 的替身，锁住「默认不渲染任何表单字段」和「底部只有一个 close」。点击展开这一段测不到（需要真实 DOM），靠与 `CredentialModal` 同构的实现来保证。
- 未触碰 host 侧：`add` / `set-url` / `remove` 三个动作、写回完整列表、`onChanged` 刷新分支分组，都还是 0022 的设计。
