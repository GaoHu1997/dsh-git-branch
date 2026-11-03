# 推送 / 拉取网络可靠性方案（三级处理）

状态：设计提案，未实现。参考项目：[zhidian-cmd/gitport-github](https://github.com/zhidian-cmd/gitport-github)。

## 1. 目标与非目标

**目标**：插件里的网络 git 操作（`fetch` / `update` / `push` / `pushTag`）在大陆网络下成功率更高、失败更快、原因可读、成功判定可信。

**非目标**：不内嵌代理进程，不做 MITM，不改系统代理/证书，不改全局 git config，不自动强推，不自动重试写操作。

**前提**：代理只能是可选增强，不能是唯一出路——大多数用户机器上没有代理。

## 2. 事实基线（2026-11-03 本机实测，git 2.56.0.windows.2）

| 场景 | 结果 |
| --- | --- |
| 直连 `ls-remote --heads` | 一次 1.03s 成功；另一次 `Recv failure: Connection was reset` |
| 直连 `push --dry-run` | `Everything up-to-date`，2.9s |
| 镜像 `push --dry-run` | `fatal: could not read Username for 'https://gh-proxy.com'`，45s 被杀 |
| IP 140.82.112.3 | 失败，耗时 **88s** |
| IP 140.82.113.3 | 失败，耗时 **211s** |
| IP 20.27.177.113 | `push --dry-run` 成功，**1.16s** |
| 8 个候选 IP 的 TCP:443 | 7 个可连 |
| 本地 CONNECT 代理承载 `push --dry-run` | 3 次 1 成功（17s），2 次 `ECONNRESET` |

三条结论：

1. **失败是概率性的、与具体 IP 相关**，不是"全网封死"。所以优选 IP 有实际收益。
2. **TCP 可连 ≠ git 可用**：7/8 端口通，真正能用的只有 4 个。探测判据必须是真实 `ls-remote`，不能是 ping / tcping / 端口探测。
3. **失败的代价不对称**：一个坏 IP 可能吃掉 88–211 秒。所以探测必须并发 + 硬预算，串行试遍候选比现状还慢。

## 3. 三级模型

三级自上而下，任一级成功即停止；**每一级都必须"探测通过才用"**，不允许静默跳到下一级。

```text
写操作（push / pushTag）   一级 直连 → 二级 IP 优选 → 三级 代理
读操作（fetch / update）   一级 直连 → 二级 镜像 或 IP 优选 → 三级 代理
```

| 级别 | 需要用户准备 | 副作用 | 典型收益 |
| --- | --- | --- | --- |
| 一级 直连 | 无 | 无 | 治住"假失败"与"慢链路被杀" |
| 二级 IP 优选 / 镜像 | 无 | 镜像会看到仓库内容；IP 优选无 | 治住"DNS 给到坏 IP" |
| 三级 代理 | 有代理（显式或系统级） | 无（TCP 隧道，TLS 端到端） | 通路彻底改变，成功率最高 |

**为什么写操作排除镜像**：镜像是应用层终结，只实现 `upload-pack`，没有 `receive-pack`；且必然看到推送内容。这是协议事实，不是策略开关。

## 4. 一级：直连（默认路径，对所有人生效）

这一级不改任何路径选择，只改"怎么等、怎么判"。

### 4.1 预算分级

| 操作 | 现状 | 新预算 |
| --- | --- | --- |
| 本地操作（status/log/commit） | 20s | 20s 不变 |
| `ls-remote` 探测 | — | **10s** |
| `fetch` / `update` | 120s | **300s** |
| `push` | 120s | **600s** |
| 推送后核验 | — | 10s |

现状 `src/git.ts` 的 `NETWORK_TIMEOUT_MS = 120_000` 由 fetch 与 push 共用，代码注释本身就承认"被杀掉的推送可能已经更新了远端 ref"。

### 4.2 超时后核验（治"假失败"）

推送超时后不直接报错，先确认远端状态：

```bash
git rev-parse HEAD
git ls-remote <remote> refs/heads/<branch>
```

- 相等 → `pushed: true`，附 `note: 'timed-out-but-landed'`。
- 不等 → 真失败，进入分类。

`pushTag` 同理，核验 `refs/tags/<name>`。现状 `pushBranch` 靠比较 `@{u}` 前后值判断，超时场景下不可靠。

### 4.3 写前探测

`push` / `pushTag` 执行前，用**推送地址**（`git remote get-url --push`，可能不同于 fetch 地址）跑一次：

```bash
GIT_TERMINAL_PROMPT=0 git [-c <通道参数>] ls-remote --heads <remote>
```

探测通过才执行写操作；失败则降级到下一级，**全级失败则一次写请求都不发**。

`fetch` 不做前置探测（多一个 RTT 不值得），失败后直接分类。

### 4.4 不重试

| 操作 | 失败后可否自动重试 |
| --- | --- |
| `fetch` / `update` | 可以（幂等，一次） |
| `push` / `pushTag` | **不可以**（可能已落地、hook/CI 会被重复触发） |

推送的唯一"补救"是核验，不是重试。

## 5. 二级：IP 优选（无代理用户的主力）

### 5.1 触发

一级直连失败（`unreachable` / `reset` / `timeout`）后触发；**不默认抢在一级前面**，除非用户显式开启"总是优选"。

### 5.2 取 IP：运行时解析，不内置表

```text
https://dns.alidns.com/resolve?name=github.com&type=A
https://1.1.1.1/dns-query?name=github.com&type=A   # 兜底
```

内置静态表的失败形态是"连到已不属于 GitHub 的边缘节点"，比现在的错误更难解释，且必须跟随 GitHub 调度漂移维护。运行时解析永不过期。

### 5.3 并发探测

```bash
git -c http.curloptResolve=github.com:443:<ip> ls-remote --heads <remote>
```

- 并发 4 路，**每路 5s 硬杀进程树**。
- 只认 `ls-remote` 成功（拿到 refs），不认端口连通。
- 首选地址替换 `github.com:443`，SNI 与证书校验**保持不变**，绝不 `http.sslVerify=false`。

依据：实测两个坏 IP 分别耗 88s / 211s，串行探测不可接受；并发 8 个候选约 10s 出结果。

### 5.4 缓存与失效

- 成功结果按 `(remote, 网络指纹)` 缓存 **10 分钟**。
- 后续一级直连仍按正常顺序，只有失败才用缓存 IP。
- 缓存命中但探测失败 → 立即清缓存并重新解析。

### 5.5 边界

- 只对 `github.com` 生效，不碰 `codeload`、`raw`、企业域名。
- 若阻断发生在 SNI/指纹层（非 IP 层），本级别无效，直接进三级。

## 6. 三级：代理

### 6.1 两个来源

1. **显式配置** `networkProxy`（`http://` / `https://` / `socks5://` / `socks5h://`）。
2. **系统代理探测**：读 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyEnable` / `ProxyServer`，发现候选地址后**用真实 `ls-remote` 验证**，通过才建议启用。

来源 2 的意义：Clash / v2rayN 的"系统代理"只写 WinINET，**git 的 libcurl 不读它**——用户以为自己在用代理，实际 `git push` 是裸连。只读注册表，绝不修改系统设置。

### 6.2 注入方式

```bash
git -c http.proxy=http://127.0.0.1:7890 push
```

- 逐命令注入，不写全局 config，退出即失效。
- 代理与镜像互斥：同一条命令不会同时出现 `http.proxy` 与 `url.*.insteadOf`。
- 需要 `CONNECT` 能力；纯 SOCKS5 用 `socks5h://`（DNS 交给代理解析）。

### 6.3 安全性

代理是 TCP 隧道，TLS 在 GitHub 端终结，代理只看到密文与 SNI，**看不到代码内容**。这与镜像有本质区别，也是写操作可以走代理的依据。

### 6.4 边界

- SSH 远端（`git@github.com:`）不受 `http.proxy` 影响，需提示改用 HTTPS 或配置 `ProxyCommand`。
- 三级失败时如实说明"此网络下推送需要代理"，不静默降级到必然失败的路径。

## 7. 读操作：镜像作为二级的另一条支路

`cnAccelerate` 开启且是读操作时，二级优先走镜像（保持 0040 的完整 URL 语义）：

```bash
git -c url.<prefix>https://github.com/.insteadOf=https://github.com/ fetch --all --prune
```

- 私有仓库可能 401：识别后**显式**回一级直连，并在结果里标注"镜像不可用于私有仓库"。
- 镜像失败一次后，本次操作内不再尝试（轻量熔断）。
- 镜像与代理互斥：代理可用时，镜像不再叠加。

## 8. 失败分类与降级决策

| 分类 | 典型文本 | 是否降级 | 给用户的话 |
| --- | --- | --- | --- |
| `credentials` | `could not read Username`、`401`、`terminal prompts disabled` | 否（换通道无用） | 去凭据面板补该主机的 token |
| `unreachable` | `Failed to connect`、`Connection refused`、`over proxy` | 是 | 代理没开/端口错 |
| `reset` | `Connection was reset`、`curl 56` | 是 | 链路被干扰，换通道再试 |
| `timeout` | 达到预算 | 是（写操作先核验） | 见 §4.2 |
| `tls` | `SSL certificate problem`、`schannel` | 否 | 证书/中间盒问题，不要关校验 |
| `diverged` | `non-fast-forward`、`fetch first` | 否 | 先更新再推 |
| `protected` | `protected branch`、`hook declined` | 否 | 服务端策略拒绝 |
| `proxy-misconfigured` | `Proxy CONNECT aborted`、`407` | 否 | 代理不可用，检查地址 |

原则：**只有网络类失败才降级；业务类失败降级只会浪费用户时间。**

## 9. 可见性

- 每次操作结果带上 `channel`：`direct` / `ip-pinned:<ip>` / `mirror` / `proxy:<host:port>` / `system-proxy`。
- Toast 与历史记录标注本次通道，失败时附带"已尝试：直连 → IP 优选 → 代理"。
- 新增 `POST /network-probe`：给定 `{ cwd, proxyUrl? }`，返回 `{ ok, channel, elapsedMs }`，供设置面板「检测」按钮使用。

## 10. 配置

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `networkProxy` | `Volatile<string> \| string` | `''` | 显式代理；空 = 不启用 |
| `networkAutoProxy` | `Volatile<boolean> \| boolean` | `true` | 允许探测系统代理作为三级候选 |
| `networkIpOptimize` | `Volatile<boolean> \| boolean` | `true` | 允许二级 IP 优选 |
| `networkIpOptimizeAlways` | `Volatile<boolean> \| boolean` | `false` | 跳过一级，直接用优选 IP |

`networkProxy` 不接受用户名密码（会落盘、进日志、被截图）。

## 11. 代码落点

| 文件 | 改动 |
| --- | --- |
| `src/network.ts`（新） | `networkPlan`、`classifyGitFailure`、`proxyUrlError`、`parseDohAnswer` |
| `src/normalize.ts` | `proxyUrlError` 复用 |
| `src/git.ts` | 预算常量拆分；`probeRemote`；`pushBranch` / `pushTag` 加探测与超时核验；通道参数贯穿 |
| `src/routes.ts` | `handlePush` / `handlePushTag` / `handleUpdate` / `handleFetch` 接线；`/network-probe` |
| `src/index.ts` | 四个配置键、`SectionConfig`、`sectionOf`、`RouteDeps` |
| `src/client/accel-form.ts` 等 | 代理输入 + 检测按钮 + 通道标注 |
| `src/client/locales.ts` | 错误建议与提示词条（zh/en） |

## 12. 测试矩阵

| # | 场景 | 期望 |
| --- | --- | --- |
| 1 | 无配置，网络正常 | 一级直连成功，标注 `direct` |
| 2 | 无配置，断网 | 10s 内给出 `unreachable`，不挂满 600s |
| 3 | 一级失败、二级 IP 可用 | 自动优选，写操作成功 |
| 4 | 所有 IP 都被 RST | 降三级；无代理则如实报告"需要代理" |
| 5 | 镜像开启，公开仓库拉取 | 走镜像，标注 `mirror` |
| 6 | 镜像 401（私有仓库） | 显式回直连，不重试镜像 |
| 7 | 代理可用 | 读写都走代理 |
| 8 | 代理填错 | 10s 内 `proxy-misconfigured` |
| 9 | 大包推送超 120s | 不误杀；超时后核验远端 ref |
| 10 | 推送被 hook 拒绝 | `protected` 分类，不降级、不重试 |
| 11 | 远端有新提交 | `diverged`，提示先更新 |
| 12 | SSH 远端 | 提示本方案不覆盖 SSH |

## 13. 分阶段落地

| 阶段 | 内容 | 风险 |
| --- | --- | --- |
| P0 | §4 一级：预算拆分、写前探测、超时核验、失败分类 | 低（不改路径选择） |
| P1 | §5 二级 IP 优选 + §6.1 系统代理探测 | 中（新增网络探测） |
| P2 | §6 显式代理配置与 UI、`/network-probe` | 中（新增配置面） |
| P3 | 镜像回落策略、SSH 443 引导、`postBuffer` 提示、实测矩阵脚本 | 低 |

## 14. 待决策

1. `networkIpOptimize` 默认开还是关？（建议开：无代理用户的唯一自愈手段；代价是首次失败后多 10s 探测）
2. `networkIpOptimizeAlways` 是否提供？（建议不提供：每一次操作都多花 10s 探测，收益不抵成本）
3. 二级 IP 优选与镜像同时可用时，读操作优先走哪个？（建议镜像优先：零探测成本；但涉及隐私，需保留开关语义）
4. 写操作三级全失败时的文案与出口（建议引导用户配置代理，不自动改远端为 SSH）。
