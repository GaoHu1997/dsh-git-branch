# 0008 — 保留 Git 推送失败诊断

日期: 2026-10-01
状态: 已接受

## 背景

插件的 Git executor 在子进程失败时把所有错误压成退出码 `1`，并只把 `stderr` 传给 `GitError`。当 Git 或 Node 在该次失败中没有写入 `stderr`，前端只能显示 `git push failed (exit 1):`，用户无法判断是没有上游、远端拒绝、认证失败还是 Git 进程启动失败。

此外，`pushBranch` 先执行 `git rev-parse @{u}`。没有 upstream 的分支会在真正执行 `git push` 前失败，因此用户看不到 Git 针对 push 给出的完整提示。

## 决策

- `ExecResult` 保留可选的 Node 进程错误文本，并使用数字退出码（可用时保留真实码）。
- Git 命令失败时按 `stderr`、`stdout`、Node 错误文本的顺序选择诊断；三者都为空时使用明确的 `git produced no diagnostic output`，禁止生成空冒号错误。
- `pushBranch` 将 upstream 查询改为可选探测，始终让 `git push` 负责报告无 upstream 和远端拒绝。无法比较 upstream 时 `pushed` 为 `false`，不影响失败诊断。

## 理由

Git 的错误输出通常在 `stderr`，但不同 transport、hook、平台和 Node spawn 失败可能只留下 stdout 或进程错误。保留多个来源比在 UI 猜测具体失败类型可靠，也不改变 Git 命令本身的安全约束：仍然执行裸 `git push`，不自动选择 upstream，不传 `--force`。

## 验证

新增单元测试覆盖：

- upstream 探测失败后仍执行 `git push`，并显示 push 输出；
- 没有任何命令输出时显示 Node 进程错误，而不是空诊断。

## 影响

推送失败 Toast 会显示 Git 或 Node 的实际诊断，便于用户自行修复远端、认证、分支 upstream 或 hook 问题。成功推送和已有 upstream 的 `pushed` 判定保持原有语义。
