# 0011 — 设置面板按 Host 条目 id 读取插件配置

状态: 已接受

日期: 2026-10-16

## 背景

`dsh-git-branch-manage` 的 bundle patch 插入的 Host 条目 id 是 `dsh-git-branch`。`configForms.get(entryId)` 按 Host 条目 id 读取并写入配置，客户端却传入了功能命名空间 `git-worktree`，还用该名字匹配 `configForms.describe()` 返回的 `namespaces[].ns`。当环境只存在实际插件条目时，配置表单不可用，设置卡片也不会注册。

原有客户端测试固定报告 `git-worktree`，且忽略 `configForms.get` 的参数，因此未发现条目 id 与客户端读取目标不一致。

## 决策

- 客户端使用独立常量 `PLUGIN_ENTRY_ID = 'dsh-git-branch'`，对应 `cordis.patch.yml` 中的 `id`。配置表单获取和卡片注册条件共用该常量，设置写入沿用该表单。
- `plugins.bundle.config` 的派发 key 继续使用 npm 包名 `dsh-git-branch-manage`；`git-worktree` 继续作为文案、HTTP 路由与输入栏槽位的功能标识。这些标识各有用途，不能替代 Host 条目 id。
- 更新测试，让未提供的条目返回不可用表单，并验证实际条目的配置读取、开关写入，以及条目出现和消失时的卡片注册与移除。

被否决的备选：

- 让插件市场把配置目标替换成旧名字：自定义设置卡片由插件客户端获取表单，市场无法修正其内部调用。
- 把 Host 条目改为 `git-worktree` 或同时回退读取两个名字：会改变现有 profile 的配置目标，或在存在同名条目时读取错误配置；本次直接使用插件声明的实际条目。
- 把所有 `git-worktree` 标识统一改名：文案与路由无需依赖条目 id，扩大改名范围不会解决额外问题。

## 影响

- 正面：只安装 `dsh-git-branch` 条目的环境可以显示设置卡片，并通过同一条目读取和写入配置；依赖该表单的自动清理设置也能正确读取。
- 正面：测试能发现客户端读取了不存在的条目，卡片仍按 npm 包名归属到当前插件。
- 负面：客户端保留一份条目 id 字符串；以后修改 bundle patch 的 id 时，需要同步配置表单常量与测试，避免再次出现身份不一致。
- 兼容性：自行把 profile 条目 id 改为 `git-worktree` 的部署需要对齐插件声明的 `dsh-git-branch`；本次不提供旧 id 的自动迁移。包版本保持不变。
