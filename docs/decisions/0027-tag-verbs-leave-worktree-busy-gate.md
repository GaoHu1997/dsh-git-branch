# 0027 — 标签动作不再占用工作区 busy 闸门

状态：已接受  
日期：2026-10-29

## 背景

0020 给提交历史右键菜单加了「推送标签 <tag>」。该动作在 `src/client/GitHistoryPanel.tsx` 里复用了面板唯一的守卫 `runGuarded`，而 `runGuarded` 的职责写着「section busy 守卫」：进入时 `setSectionBusy(true)`，结束后复位。

`sectionBusy` 同时被喂给三个 section。其中未提交改动卡片把它当 `busy`，提交按钮的文案就是 `busy ? t('panel.commitBusy') : t('panel.commit')`（`src/client/panel/UncommittedSection.tsx:214`），禁用条件也含 `busy`。于是点击「推送标签」后，正在向远端推标签的那一两秒里，提交按钮显示「提交中…」并且被禁用——用户什么都没提交，这个状态是假的。用户实测后报告了这一点。

同样的错位存在于「创建标签」（`onCreateTag`）：它也只是写一个仓库级 ref，却同样点亮工作区闸门。

## 决策

- 给 `runGuarded` 增加第二个参数 `scope: GuardScope = 'section'`，取值 `'section' | 'repo'`：
  - `'section'`（默认，保持既有行为）：占工作区 busy 闸门，用于暂存、提交、切分支、重命名/删除/新建分支等会改变工作区或 HEAD 的动作。
  - `'repo'`：只写仓库 ref、不读也不写工作区，因此不点亮该闸门。错误 toast 与跨面板刷新通知（`emitGitMutated`）照旧。
- `onPushTag` 与 `onCreateTag` 改用 `'repo'`。推送标签之后仍不主动重拉面板（0020 的既有决定：标签是本地 ref、远端标签不改变面板可见状态）；创建标签仍 `loadAll()`，因为新标签要出现在提交历史的装饰上。
- 被否决的备选：
  - **把提交按钮文案换成独立的 `commitBusy`，只由提交/暂存点亮**——语义上更彻底，但要把三张卡片的 `busy` 拆成两套粒度，波及 `UncommittedSection` / `BranchSection` / `HistorySection` 的 props 与全部调用点；本次问题的根因是「守卫只有一种粒度」，用一个可选作用域即可修好，且后续新的 ref 类动作有明确落点。
  - **给标签动作单独开一个 `tagBusy`**——只解决推送这一条路径，动作一多就要继续加状态，仍然回答不了「这个动作该不该禁提交」。
  - **标签动作干脆不走 `runGuarded`、自己 try/catch**——会丢掉统一的错误 toast 与 `emitGitMutated` 语义，同一份守卫逻辑出现第二份实现。

## 影响

- 推送/创建标签期间，提交按钮保持「提交」文案与可点击状态；分支卡片、历史菜单也不再因为一个标签动作被禁用。
- 标签动作因此不再有「进行中」的 UI 反馈：右键菜单点击后即关闭，结果只通过完成后的 toast（已推送 / 已是最新 / 失败）呈现。这是刻意的——标签推送不阻塞工作区，用一个假的提交状态换来的「反馈」代价更大。
- `GuardScope` 成为后续新增守卫动作的显式选择点：任何新动作都要回答「它会改变工作区吗」，答错的表现是按钮文案撒谎，而不是功能失败。`tests/` 里目前没有覆盖这一点的测试：`sectionBusy` 是组件内部状态，断言它需要在浏览器里跑面板。
