# 0001 — npm 包名从 @gaohu9712/dsh-git-branch 改为 dsh-git-branch

状态: 已废弃（被 0003 取代）

## 背景

包此前以用户作用域名 `@gaohu9712/dsh-git-branch` 发布到 npm。作用域名在安装命令里更长，
且与 GitHub 仓库地址（`github.com/GaoHu1997/dsh-git-branch`）中不含作用域的命名方式不一致；
希望改用无作用域的 `dsh-git-branch` 作为包名。

## 决策

把包名统一改为 `dsh-git-branch`（无作用域）。涉及六处，全部在同一变更里同步：

- `package.json:2` — `"name": "dsh-git-branch"`（`version` 字段不动，按 AGENTS.md 约定发版升号由用户发起）。
- `cordis.patch.yml:5` — bundle patch 插入行的 `name:` 字段，须与包名逐字一致。
- `src/client/index.ts:79` — `const PLUGIN_PACKAGE = 'dsh-git-branch'`：`plugins.bundle.config`
  槽位按包名派发配置卡，此常量必须与 `cordis.patch.yml` 的 `name` 一致，否则配置卡收不到。
- `tests/client-apply.spec.ts:235` — 断言 `options.key` 为新包名。
- `README.md` / `README.zh.md` — 六处安装/更新/移除命令与 `NPM_TOKEN` 权限说明改为新包名
  （`@dsh-alpha` dist-tag 写法保留）。

被否决的备选：保留旧名并发布一个指向新名的占位包 — 徒增维护面，且旧名包从未广泛安装，
直接改名即可。

## 影响

- 正面：安装命令更短，与仓库名一致；无作用域包在 `dsh plugin add` 输出里更易读。
- 正面：`plugins.bundle.config` 的 key 与 patch 行、包名三方一致，测试守护了这一契约。
- 负面：npm 上旧名 `@gaohu9712/dsh-git-branch` 与新名是两个包 — 已安装旧名的用户原地
  `update` 不会收到新包，需先 `remove` 旧包名再 `add` 新名（README 的"从旧 github: 安装升级"
  提示同理适用）；如需通知可考虑旧名发终版说明，本次未做。
- 负面：无作用域包名占用的是全局命名空间，将来如与他人冲突只能再改名。
