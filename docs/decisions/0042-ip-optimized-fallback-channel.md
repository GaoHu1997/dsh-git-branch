# 0042 — 直连失败时按 IP 优选换路（运行时 DoH、并发竞速、可重试失败才启用）

- 状态：已接受
- 日期：2026-11-03

## 背景

0041 让网络失败变得可诊断，但没有给它任何出路：分类完 `reset` 之后，用户能看到的仍然只是「直连不通」。本机实测给出的现象很具体（见 `docs/design/network-reliability.md`）：

- 同一时刻、同一域名，裸 DNS 解析出的地址会让 `ls-remote` 等上 21s/40s/20s 然后被重置，而换一个 GitHub 边缘 IP 能在 1–2.5s 内完成。
- 系统 DNS 只返回一个地址（223.5.5.5 当时只给 `20.205.243.166`），好坏全凭运气。
- 8 个候选 IP 里 7 个 TCP 443 可连，真实 `ls-remote` 只有 4 个成功，其中两个慢到 88s、211s。**TCP 连通不能当作可用判据。**

`gitport-github` 的做法是内置一张 GitHub IP 表。这对一个自更新的常驻代理是合理的，对一个插件不是：GitHub 的边缘地址随调度与地域漂移，写死在仓库里的表迟早会指向一批已经不带这个域名的机器，而用户看到的错误会从「连不上」变成「连上一个假 GitHub」。

## 决策

1. **不内置静态 IP 表，运行时解析**：`resolveHostIps` 并行查询 `dns.alidns.com`、`doh.pub`、`doh.360.cn` 三个 DoH JSON 接口并取并集，只接受 `type === 1` 且形状合法的 IPv4；每个查询 3s 超时，失败的解析器只是少一份答案。实测 `cloudflare-dns.com` 与 `dns.google` 在本机 4s 内不可达，故不列入；解析器全部不可用时放弃优选，退化成直连，不报错。
2. **候选来自多个来源，并发竞速**：`candidateIpsFor` 并行查询 `github.com` 与同族服务 `api.github.com`、`codeload.github.com` 的 A 记录并去重——实测 `dns.alidns.com` 对 `github.com` 只回一个地址（20.205.243.166）而 `doh.pub` 回的是另一个（140.82.112.3），单一解析器的答案不足以构成候选池。`racePinnedChannels` 用 `Promise.all` 同时探前 6 个候选，每个 5s 硬超时。串行探测的代价已经实测过——两个坏地址就能吃掉 5 分钟，而它们通常成对出现。
3. **判据是真实 git 往返**：每个候选都用 `git -c http.curloptResolve=github.com:443:<ip> ls-remote --heads <endpoint>` 探一次，带 `GIT_TERMINAL_PROMPT=0`。探测成功才认为该 IP 可用；TCP 层、TLS 层都不算。
4. **只在可重试失败后启用**：`chooseChannel` 先直连探测，失败后交给 `classifyGitFailure`；只有 `retryable`（timeout / unreachable / reset）才去要备用通道。凭据、TLS、分叉、受保护分支直接返回原错误——换 IP 换不出令牌，重试只会把精确的诊断变成模糊的第二次失败。
5. **备用通道也要再探一次**：`chooseChannel` 拿到 `-c http.curloptResolve=…` 后先探该通道，探测失败就抛通道自己的错误，不把一个没验证过的 argv 交给 push。
6. **只优化 `github.com`**：`isOptimizableEndpoint` 限定 https + host 在名单内。镜像前缀（`gh-proxy.com/...`）、企业域名、SSH 一律不重写；`curloptResolve` 只影响 DNS，不改 SNI 与证书校验，因此不引入任何 MITM 语义。
7. **缓存 10 分钟**：成功结果按 endpoint 缓存（`IP_CACHE_TTL_MS`），避免每次 fetch/update 都做一轮 DNS + 6 路探测；`resetIpChannelCache` 供测试清理。
8. **读操作可重跑，写操作只换通道**：`fetchAll` 失败后取端点并整条重跑一次（fetch 幂等）；`pushBranch`/`pushTag` 只在探测阶段换通道，写本身仍然只发一次。`pushTag` 仅当调用方真的提供了 `fallbackChannel` 才去查 push URL，否则逐字节保持原有调用序列。
9. **依赖注入而非全局副作用**：`RouteDeps.networkChannel` 是可选的通道提供者，`index.ts` 的 `deps()` 才把它接到 `pinnedChannelFor` + `pinnedProbe`。测试与嵌入式使用不传即退化为「仅直连」，不会在单元测试里真的发 DoH 请求。

被否决的备选：

- 内置 GitHub IP 表（gitport 方式）：会腐坏，且腐坏后的失败模式比直连更难解释。
- 串行探测候选：最坏情况与直连超时同量级，救不回来。
- 用 TCP 握手或 TLS 握手判可用：实测 7/8 可连但只有一半真能用。
- 对所有失败都换通道：凭据错误换 IP 后仍会失败，只会把「你缺令牌」变成「连不上」。

## 影响

- 直连被重置的场景从「失败」变成「多花约 1–6s 后成功」；最坏情况（DoH 全被墙、6 路探测全失败）多花约 8s 才回到直连的错误。
- 插件不会因为一个坏 IP 就把用户的推送发到错误的主机：`curloptResolve` 只替换地址，SNI、证书、URL 全部不变，失败时仍由原通道报错。
- 每个 endpoint 每 10 分钟最多一轮 DoH + 6 路探测；没有后台轮询，也没有常驻连接。
- 只覆盖 `github.com`；其他域名（企业自建、GitLab、镜像站）维持 0041 的行为。若以后要扩名单，改 `OPTIMIZABLE_HOSTS` 即可，但每个新域名都值得先做一次同样的实测。
- 对 DoH 提供方产生少量明文查询（域名本身）；不使用 ECS，也不携带仓库路径。
