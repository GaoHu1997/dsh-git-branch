# 0004 — Release 步骤打印最终状态并在草稿时告警

状态: 已接受

## 背景

v1.0.1 的发布 run `37713334297` 里，`Create GitHub Release` 步骤结论是 success，但日志除脚本回显外没有任何输出，`gh release list` 也只看到 v1.0.0，一度让人以为这次发布没有生成 GitHub Release。

真因是仓库里早已存在一个 `v1.0.1` 的草稿 Release（`createdAt 2026-10-07T16:20:23Z`，`isDraft=true`，附件的 tarball 与 npm 上完全同 sha1）。工作流的 `gh release view "$tag"` 命中真分支，走 `gh release upload … --clobber` —— 该命令成功时不打印任何内容、退出 0，所以步骤成功而日志空白。草稿 Release 对没有写权限的凭据不可见（本机 fine-grained PAT 缺 `Contents: write` 时就是如此），进一步把"静默上传到草稿"误判成"Release 不存在"。

## 决策

在 `gh release create|upload` 之后读取 `gh release view "$tag" --json isDraft,url,assets`，把 Release 的最终状态打进日志：

- 打印 `Release <url>`、`draft=<bool> assets=<n>`，以及每个附件的名字与字节数。
- `isDraft` 为 `true` 时输出 `::warning::`，并给出 `gh release edit <tag> --draft=false` 的补救命令。

被否决的备选：

- **上传后自动把草稿转正式**（`gh release edit --draft=false`）——草稿是人工写 release notes 的中间态，公开与否必须是人的决定，工作流不应替用户做。
- **硬断言附件必须含本次打包的 tgz，否则 `exit 1`**——本次按"只记录状态"处理；附件名单已经打印在日志里，是否失败留给后续按需再加。

## 影响

- 正面：日志自证。任何一次发布都能从 Actions 日志读到 Release 的 URL、可见性与附件清单，不会再出现"步骤成功但不知道发生了什么"；草稿状态以告警显形在 Actions 摘要里。
- 正面：把"Release 存在与否"的判断从凭据权限里解耦——有无草稿、是否公开都由日志陈述，不依赖调用方有没有写权限。
- 负面：多一次 API 调用，并依赖 `jq`（ubuntu-latest 预装 1.6+）；Release 状态多打 3–4 行日志。
- 负面：若 `gh release view` 在创建成功后因 API 抖动失败，步骤会失败——此时 Release 实际已创建，重跑是幂等的（`--clobber` / `--verify-tag`）。

## 验证

本机没有 `jq`，也没有可用的 tag，因此以两种方式验证未上真机：

- `bash -n` 检查该步骤 `run` 块（把 `${{ … }}` 占位替换后）语法通过。
- 用桩 `gh`/`jq` 跑真实抽取出来的日志块：`draft=true` 的 fixture 打印告警，`draft=false` 的 fixture 不打印告警，两者都打印附件的名字与字节数。
- `js-yaml` 解析 `.github/workflows/release.yml` 通过；该步骤仍为最后一个步骤（共 12 个步骤）。
- 真机效果要等下一次 tag 发布才会出现。
