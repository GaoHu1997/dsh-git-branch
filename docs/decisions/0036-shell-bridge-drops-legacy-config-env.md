# 0036 — shell 凭据桥启动时清掉 0032 遗留的 `GIT_CONFIG_COUNT` 环境通道

状态：已接受

日期：2026-11-02

## 背景

0034 换掉了 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` 注入通道，但只改了「写什么」，没有清「早就写进去的」。DSH 的子进程环境清洗按 `/KEY|PASSWORD|SECRET|TOKEN/i` 剥变量名，`GIT_CONFIG_KEY_<n>` 全被删、`GIT_CONFIG_COUNT` 与 `GIT_CONFIG_VALUE_<n>` 幸存，于是 1.0.10 在宿主进程里留下一个半注入的通道。git 只要看到 `GIT_CONFIG_COUNT=5` 而 `GIT_CONFIG_KEY_0` 缺失，任何命令都直接：

```
error: missing config key GIT_CONFIG_KEY_0
fatal: unable to parse command-line config
```

这个残留不属于任何一次 `apply()` 的 `applied` 列表——1.0.10 的写入者已经被卸载，1.1.0 的桥只删自己写的键。所以在同一个宿主进程里热升级插件后，`git` 依然全挂；重启宿主才会消失（下次升级仍会重演）。实测环境：`GIT_CONFIG_GLOBAL` 已指向 1.1.0 生成的会话配置，同时 `GIT_CONFIG_COUNT=5` 与 `GIT_CONFIG_VALUE_0..4` 仍在，`KEY_*` 一个都没有。

## 决策

`createShellBridge` 的 `apply()` 与 `dispose()` 在动环境之前先调 `legacyConfigNames(env)`，把**半注入**的遗留通道整组删掉（`GIT_CONFIG_COUNT` + 所有 `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`）。判据是「通道不完整」：

- `GIT_CONFIG_COUNT` 不存在 → 什么都不删；
- 存在且 `0..count-1` 的 `GIT_CONFIG_KEY_<i>` 全部存在 → 视为调用方有意设置的合法通道，**保留**（git 能正常解析，删掉反而改了别人的配置）；
- 否则（缺任一 `KEY_i`，或 `COUNT` 不是非负整数）→ 整组删除。

清理发生在写会话配置之前，所以「会话配置写失败、只保留 fail-fast 变量」的降级路径同样会清掉遗留通道——残留本身就能让 git 全挂，与本次写入成功与否无关。

被否决的备选：

- **只删自己的 `applied` 键**——被否决：写这些键的是已卸载的 1.0.10，新实例的 `applied` 里根本没有它们；这正是本 bug。
- **无条件删掉所有 `GIT_CONFIG_COUNT/KEY_n/VALUE_n`**——被否决：调用方可能真的用这条通道传合法配置，完整通道不该被插件接管；按「是否完整」判定能同时满足自愈与不越界。
- **修 DSH 的 `@deepseek-ai/dsh-subprocess` 清洗规则（不按 `KEY` 剥）**——不作为本次修复：那属于宿主侧，插件能装的宿主版本不可控；上游仍值得单独提（`GIT_CONFIG_KEY_*` 不是密钥，却是被误伤的合法变量），但插件必须能在现状宿主上自愈。
- **只在 `dispose()` 里清**——被否决：卸载时才清意味着从升级到卸载之间的每条 git 命令都是坏的。

## 影响

- 正面：1.0.10 → 1.1.0（及以后）热升级后，`apply()` 一跑，遗留的坏通道即被删除，宿主派生 shell 里的 `git` 立刻恢复，不再需要重启宿主或手工 `unset`。新增单元测试覆盖半注入清理、完整通道保留、非数字 `COUNT`、会话配置写失败路径。
- 反面：无。判定只作用于「已经被剥坏的」通道，完整通道与无关变量（如 `PATH`）不动。
- 依赖：清理只在 `apply()` / `dispose()` 被调用时发生（插件加载与每次凭据变更都会调 `apply()`）；若某个宿主进程从未加载本插件，遗留变量仍需重启宿主或手工清理。
