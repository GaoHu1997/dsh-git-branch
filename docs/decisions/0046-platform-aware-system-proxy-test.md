# 0046 — 系统代理用例按平台分派，CI 与 release 恢复绿灯

状态：已接受

日期：2026-11-04

## 背景

v1.3.0 的 CI（run 41790670975）与 tag 触发的 release 工作流（run 41790929358）都停在 Test 步骤，失败用例是 `tests/network-proxy.spec.ts > systemProxyUrl > reads an enabled proxy from the registry`，报错 `AssertionError: expected undefined to be 'http://127.0.0.1:7890'`。根因是 0043 引入的 `src/network-proxy.ts:58` 中 `systemProxyUrl(exec: Exec, cwd: string): Promise<string | undefined>` 在非 Windows 平台直接 `return undefined`，而该用例无条件假设读取 Windows 注册表。CI 跑在 ubuntu-latest，于是必然失败；这不是 v1.3.0 引入的回归，main 分支此前的红灯（run 41666881270 等）同因，只是本次发布被它挡住。

## 决策

把 `tests/network-proxy.spec.ts` 中的 `systemProxyUrl` 用例按平台分派，而不是放宽实现：

- 三条依赖注册表读数的用例（读取已启用代理、开关关闭/读取失败/取值不可用、只允许只读 `reg query`）加 `it.skipIf(process.platform !== 'win32')`，只在 Windows 执行。
- 新增一条 `it.skipIf(process.platform === 'win32')` 的非 Windows 用例，断言返回 `undefined` 且完全不调用 `exec`，把「非 Windows 不读注册表」这一契约固定下来。

被否决的备选：

- 在 `systemProxyUrl` 里为非 Windows 平台伪造一个代理返回值——被否决：实现上的平台短路是有意设计，测试应跟随契约而不是反向放宽实现。
- 删掉或长期 `skip` 掉这条用例——被否决：会丢失 Windows 下的真实行为覆盖；按平台分派能同时保住两侧覆盖。
- 只在 release 工作流里跳过该用例——被否决：CI 与 release 共用同一批测试，改工作流只会把红灯藏起来。

## 影响

- 正面：Windows 侧仍覆盖注册表读取的三类行为，非 Windows 侧新增「不触碰注册表」的断言；CI 与 release 工作流的 Test 步骤可在 ubuntu-latest 通过，v1.3.0 的 npm 发布与 GitHub Release 能够继续。
- 负面：测试覆盖依赖运行平台，Windows-only 用例在 Linux CI 上不执行；若将来 `systemProxyUrl` 改变平台行为，需要同时更新两侧用例。
- 本次改动只涉及测试文件，不改变任何运行时行为，也不影响 npm 包的对外 API。
