# 0003 — 包名改为 dsh-git-branch-manage（dsh-git-branch 已被他人占用）

状态: 已接受

## 背景

0001 把包名从 `@gaohu9712/dsh-git-branch` 改成无作用域的 `dsh-git-branch`，并在"影响"里记下了无作用域名的固有风险："将来如与他人冲突只能再改名"。该风险在紧接着的 v1.0.1 发布里立刻应验：

- 发布 run 37701652264（tag `v1.0.1`）在 `Publish to npm` 步骤失败，错误为
  `[E403] 403 Forbidden - PUT https://registry.npmjs.org/dsh-git-branch - You do not have permission to publish "dsh-git-branch". Are you logged in as the correct user?`
- 同一段日志证明这不是凭据问题：`NPM_TOKEN: length=40 prefix=npm_(masked)`、`Authenticated on npm as: gaohu9712`；publish 之前的 tag 校验、版本未占用校验、typecheck、测试、build、pack 全部通过。
- 注册表事实：`dsh-git-branch` 已于 2026-08-16 由另一位用户发布，latest `0.1.1`，维护者 `hanyueqiang <webyueqiang@163.com>`，仓库为 `github.com/hanyueqiang/dsh-git-branch`，且是一个功能高度重叠的 DSH 插件（"在输入框工具行展示当前工作区 git 分支"）。npm 不存在强制改名/回收通道，该名字实际不可得。

## 决策

把包名定为无作用域的 `dsh-git-branch-manage`（先经注册表确认不存在），并在同一变更里同步所有的包名引用：

- `package.json:2` — `"name": "dsh-git-branch-manage"`（`version` 仍为 1.0.1：升号由用户发起，见 0002）。
- `cordis.patch.yml:5` — bundle patch 插入行的 `name:`，DSH loader 按它解析 host 模块，须与包名逐字一致（见 0002）。
- `src/client/index.ts:79` — `PLUGIN_PACKAGE`：`plugins.bundle.config` 槽位按包名派发配置卡，须与 patch 的 `name` 一致。
- `tests/client-apply.spec.ts:235` — 断言 `options.key` 为新包名，守护上述契约。

被否决的备选：

- 改回 `@gaohu9712/dsh-git-branch`：永久可用且 1.0.0 已发布，但违背 0001 的核心动机（安装命令更短、与仓库名一致），故不采纳；作用域名作为永远的兜底。
- 换用其他无作用域短名：`dsh-git-worktree`（已占 0.10.0）、`dsh-branch`（已占 0.0.1）、`dsh-git`（已占 0.0.1）均不可用；`dsh-git-branch-plugin` / `dsh-plugin-git-branch` / `dsh-gitbranch` 当时空闲，但 `dsh-git-branch-manage` 更贴近仓库名与"管理"能力，故取之。

刻意不改的两处（避免制造无谓的破坏性变更）：

- `cordis.patch.yml:4` 的 `id`：loader entry 的 id，同时是设置命名空间与 HTTP 路由前缀（见 0002）。它只是一个稳定命名空间标签，与包名解耦，改名会打断既有 profile 的配置持久化。
- `src/index.ts:25` 的 `export const name = 'dsh-git-branch'`：cordis 插件名，不是 npm 包名。证据：包名为 `@gaohu9712/dsh-git-branch` 时期它就已经是无作用域的 `dsh-git-branch`，二者一直是独立的。

## 影响

- 正面：包名可用且不冲突，v1.0.1 可以发布；插件在安装/更新命令里仍是无作用域短名。
- 正面：`plugins.bundle.config` 的 key 与 patch 行、包名三方一致，测试继续守护这一契约。
- 负面：这已是同一插件的第三个 npm 包名（`@gaohu9712/dsh-git-branch` → `dsh-git-branch` → `dsh-git-branch-manage`）。前两个名字都不会自动消失：已安装 `@gaohu9712/dsh-git-branch@1.0.0` 的用户需要 `remove` 后重新 `add`；`dsh-git-branch` 上从来没有本项目的版本。
- 负面：无作用域名仍占用全局命名空间，未来仍可能再次撞名（本次已是第二次）。若后续再遇冲突，应直接改回作用域名 `@gaohu9712/dsh-git-branch`，那是唯一永远可用的名字。
- 遗留：`package.json:48` 的 `files` 仍列着已被删除的 `README.zh.md`（空引用，npm 会忽略，但清单与实际不符）。
