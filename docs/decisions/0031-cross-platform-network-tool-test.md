# 0031 — git_network 测试用绝对路径改为平台无关

状态：已接受

日期：2026-10-29

## 背景

0029 的测试 `tests/network-tool.spec.ts` 中 `accepts the four network subcommands` 用例断言 `gitNetworkRequestIssue('C:\repo', [...])` 通过校验。该校验用的是 `node:path` 的 `isAbsolute`，它是平台相关的：Windows 上 `C:\repo` 是绝对路径，POSIX 上不是。于是本地（Windows）575 个测试全过，而 Linux CI（ubuntu-latest）上该用例报 `'"repoPath" must be an absolute path' to be undefined`，Release 工作流在 Test 步骤失败，`v1.0.9` 的 npm 发布与 GitHub Release 全部 skipped。

工具行为本身是对的：`repoPath` 会作为 git 进程的 cwd，在哪个平台运行就该接受哪个平台的绝对路径。

## 决策

第二个路径形状改用 `resolve('repo')` 构造——在任何平台上它都是该平台的绝对路径，既保留了「盘符路径这类不同形状的绝对路径也能通过」的断言本意，又与校验器用的 `isAbsolute` 语义一致。用例内加注释说明为何不能硬编码 `C:\repo`。

被否决的备选：

- 用 `it.skip` 或按 `process.platform === 'win32'` 条件化该断言——被否决：Linux CI 上这条断言将不再执行，跨平台形状的覆盖在 CI 上丢失。
- 把工具的校验改成 `path.win32.isAbsolute || path.posix.isAbsolute`——被否决：POSIX 上接受 `C:\repo` 只会让 git 在 exec 阶段 ENOENT，校验器收紧在本平台是正确语义，不该为测试放宽。

## 影响

- 正面：Release 工作流在 Linux 上可跑通，npm 与 GitHub Release 的 1.0.9 得以发布。
- 反面：CI 上不再有「非本平台绝对路径形状」的断言；该形状的语义由 `node:path` 保证，属平台库行为，测试无需重复背书。
