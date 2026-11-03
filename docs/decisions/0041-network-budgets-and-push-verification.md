# 0041 — 网络预算分级、写前探测与超时后核验

- 状态：已接受
- 日期：2026-11-03

## 背景

插件的网络命令原先共用一个 120s 预算（`NETWORK_TIMEOUT_MS`），`git.ts` 的注释自己写着「被杀掉的推送可能已经更新了远端 ref」：超时后只报一个错误，用户既不知道推送到底有没有生效，也不知道该不该重试。更糟的是失败现场——`git push` 直连被重置、镜像站要求登录、代理连不上，三种情况的报错都是一句 `fatal:`，插件既不分类也不建议。

调研 `gitport-github` 与实测（见 `docs/design/network-reliability.md`）确认了几件事：

- 公网镜像只有 `upload-pack`，没有 `receive-pack`：推送永远不能走镜像。
- 代理是 TCP 隧道，可以承载推送；git 的 libcurl 不读 Windows 系统代理/PAC。
- 「TCP 443 能连」不等于「git 能用」：8 个 GitHub 边缘 IP 里 7 个 TCP 可连，真实 `ls-remote` 只有 4 个成功，其中两个耗时 88s、211s。
- 直连推送实测被 `Connection was reset` 打断；同一时刻 pin 到可用 IP 后 1.16s 完成。

所以 P0 先不引入任何新通道，只把现有链路做得「可诊断、可判定」：预算按操作分级、写之前先探测、超时之后去核验、失败按语义分类。

## 决策

1. **预算分级**（`src/network.ts`）：探测 10s、读取（fetch/update）300s、写入（push/push-tag）600s、超时后的核验 10s。探测单独用短预算，是因为它的职责就是快速失败；用一个 600s 的预算去探测死主机，等于把「不可达」卖成「还要再等十分钟」。写入预算比读取宽，是因为被杀掉的推送带来的是不确定性，而不是一次便宜的重试。
2. **写前探测**：`pushBranch` 先解析 `@{u}` 的远程与其 **push URL**（`git remote get-url --push`，尊重单独的 `pushurl`），再用 `ls-remote --heads <url>` 探一次，带 `GIT_TERMINAL_PROMPT=0` ——探测必须失败，不能卡在一个用户看不见的凭据窗口上。没有 upstream 的分支跳过探测，把 `git push` 自己的报错原样留给用户。
3. **超时后核验**：推送被预算杀掉时，用 `rev-parse HEAD` 与一次 `ls-remote --refs <终点> refs/heads/<分支>` 比对；相等则返回 `pushed: true` 并附 `note: 'timed-out-but-landed'`，不再把一次已经落地的推送报成失败。推送**从不自动重试**：远端状态未知时，重试是用户的决定。
4. **失败分类**（`classifyGitFailure`）：把 stderr 归为 timeout / unreachable / reset / proxy / tls / credentials / diverged / protected / unknown，并附一句处置建议；`withHint` 把建议追加在 git 原始诊断之后（原文在前，方便贴进 issue）。只有可达性类失败标为可重试，凭据、TLS、分叉、受保护分支一律不重试——重试也不会凭空变出令牌或权限。
5. **预留通道参数**：`pushBranch`/`pushTag` 接受 `NetworkOptions.channelArgs`（`-c` 对），探测与写入走同一个通道；P0 里它恒为空，P2 的代理配置直接填进来即可，不需要再改调用约定。

被否决的备选：

- 只把 120s 改成 600s：解决不了「超时后不知道有没有生效」，反而让死主机的等待更长。
- 超时后自动重试推送：可能把一次已经成功的推送重放，遇到钩子或受保护分支时错误信息还会覆盖真正的结果。
- 写前探测直接用 `git push --dry-run`：它仍会走 receive-pack 协商，慢且可能触发服务端钩子；`ls-remote` 是纯读，几秒就能判定。
- 把分类结果做成 HTTP 状态码（比如 503）：客户端只渲染错误字符串，先做最小可用的是消息，分级留给 UI 之后按需消费。

## 影响

正面：

- 死主机在 10 秒内失败，而不是让用户对着 120s 的转圈猜。
- 被杀掉的推送有了权威判定：落地了就说落地了，没落地才报错。
- 每类失败的报错都带一句人话建议，用户不必自己解读 `Recv failure` 与 `terminal prompts disabled` 的区别。
- `pushTag` 复用同一个 ref 读取：存在性检查、探测、超时核验三合一，没有多一次往返。

负面：

- 每次推送多一次 `ls-remote` 往返（约 1–2s），换取的是失败诊断与超时判定。
- 探测与推送之间仍有时间窗口：探测通过不代表推送一定成功，这里只是把「明显不可达」提前拦掉。
- `classifyGitFailure` 依赖英文报错文本，git 的措辞变化会让某条规则失效；未知文本落到 `unknown`，行为与改造前一致（不倒退）。
