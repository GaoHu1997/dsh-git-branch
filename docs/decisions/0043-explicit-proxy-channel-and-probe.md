# 0043 — 代理成为第三通道：显式 `networkProxy`、只读系统代理探测、通道链与 `/network-probe`

- 状态：已接受
- 日期：2026-11-03

## 背景

0041 给了预算与核验，0042 给了「换一个 IP」。两者都建立在同一个前提上：网络本身还能到达 GitHub 的某个边缘。用户提出的事实打破了这个前提——「不是所有人电脑上都有代理」，反过来说，有代理的机器上插件并没有利用它。本机验证的两件事决定了这一层的设计：

- `git` 链接的是 libcurl，它**不读** WinINET/PAC。系统里浏览器能上网，`git ls-remote` 依然直连失败。gitport 的 README 也把「浏览器 / git / 命令行把代理指向 127.0.0.1:7810」写成用户手动步骤，正是同一个原因。
- 反向验证：临时写了一个最小 HTTP CONNECT 代理（`scripts/probe-connect-proxy.mjs`），`git -c http.proxy=http://127.0.0.1:7899 push --dry-run` 三次里有一次成功（17.0s），另两次 21s 被重置。**写操作确实能穿过 CONNECT 隧道**——代理是 TCP 层的透传，TLS 端到端，代理看不到对象内容；这与镜像（应用层终结、只有 upload-pack、必然看到推送内容）性质不同，因此「写走代理」是安全的，「写走镜像」不是。

## 决策

1. **新增 `networkProxy` 配置，显式为空即关闭**：`Config.networkProxy`（volatile string，默认 `''`）。空串与未设置都表示「不启用代理通道」，`sectionOf` 不把空串投影出去，避免上层被一个假值覆盖。校验用 `proxyUrlError`：必须是 `http`/`https`/`socks5`/`socks5h` 之一、必须有显式端口（1–65535）、**不收用户名密码**（会被写进配置、显示在设置卡、出现在诊断里）、不带 path/query/fragment。
2. **显式代理优先于 IP 优选**：`deps().networkChannels` 的提供者顺序是「代理 → IP 优选」。用户明确配置的路径应当先被尝试；IP 优选是启发式，只在前一条路失败时补位。`firstWorkingChannel` 按序询问，某个提供者返回 `undefined` 表示「这条路现在不可用」，跳过而不是失败。
3. **系统代理只读、只建议**：`systemProxyUrl` 读取 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyEnable` / `ProxyServer`（`reg query`，3s 超时），解析 `host:port` 与 `http=…;https=…` 两种写法，再走同一个 `proxyUrlError`。**绝不自动启用**：git 本来就不认这个设置，插件擅自把系统代理接进 git 会改变用户的网络路径，而用户可能从没为 git 选过它。它只作为 `/network-probe` 结果里的一个建议值出现。
4. **单通道改为有序通道链**：`NetworkOptions.fallbackChannels?: readonly ChannelProvider[]` 取代 `fallbackChannel`。每个提供者拿 endpoint 给 argv（或 `undefined`）；`firstWorkingChannel` 对每个 argv 都做一次真实探测，失败继续下一个。
5. **链全失败时抛原始直连错误**：直连是用户预期里那条路，备用通道只是补位。把所有备用错误拼起来只会得到一个更长的错误，而用户要的是「你的网到不了 GitHub」，不是「第三个 IP 也不行」。
6. **`pushTag` 只在真的配置了链时才多查一次 URL**：`fallbackChannels` 非空才 `remote get-url --push`，否则调用序列逐字节保持 P0/P1 的形状——tag 推送本来只发一次，不该为了一个没配置的功能多一次往返。
7. **`/network-probe` 是诊断，不是写入**：`POST ROUTE_PREFIX/network-probe` 接受 `{ repoPath }`，探测目标取 upstream 的 push URL，退化到 `origin`，再退化到第一个远端；每个通道各自 `ls-remote --heads` 一次、各自 10s 预算，结果逐条返回 `{channel, ok, elapsedMs, detail}`。一条通道失败不影响其余通道，响应始终 200。`systemProxy` 字段只在插件自己没配代理时出现。
8. **失败是数据不是错误**：探测函数把非零退出码转成 `ok:false + detail`（首行、截断到 300 字符），而不是抛异常——用户需要看到「代理不通、IP 通」这种并排结论，而不是第一个通道就中断诊断。

被否决的备选：

- 自动接管系统代理（写 `http.proxy` 全局配置）：改变用户所有 git 操作的网络路径，且 WinINET 的值可能是给浏览器准备的 PAC/企业代理。
- 支持 `user:pass@` 的代理 URL：凭据会进入配置与日志；需要认证的代理留给后续版本单独设计（密钥存储 + 掩码显示）。
- 把探测结果自动应用为配置：探测成功只说明「此刻通」，不等于用户想长期走这条路。
- 探测失败直接返回 5xx：诊断的价值就在于失败也要有结论。

## UI

- 代理输入复用加速那一对字段的提交语义：`AccelForm` 里多了 `proxyText` / `proxyError` 与 `editNetworkProxy`，三份草稿（开关、加速地址、代理）由一个页脚按钮一起保存；只有真的改过代理才写第三个键，纯切开关的保存仍然只写两个键，和既有行为逐字节一致。
- 校验函数 `proxyUrlError` 放在 `normalize.ts`（host 与 client 共用），输入框边打边报错，错误存在时保存按钮直接禁用——与加速地址的错误处理同一条路。
- 面板浮层的「检测网络」按钮调 `POST /network-probe`，把每条通道渲染成 `✓/✗ 通道名 · 耗时 · 详情`。按钮是只读诊断：不保存、不自动套用、失败也是逐行结论而不是一个 toast。
- 设置卡与浮层的输入框显示同一个草稿状态（`AccelForm` 是唯一样本来源），两处不会各写各的。

## 影响

- 有代理的用户可以显式配置一次，之后 fetch/update/push/pushTag 在直连可重试失败时自动尝试它；没代理的用户行为完全不变（`networkProxy` 为空 → 通道链里只有 IP 优选）。
- 每次命令多出的成本只在失败路径上：直连探测 10s 失败 → 依次尝试通道（每个 10s 探测）→ 成功的通道直接用于命令本身。最坏情况比 0042 多一次探测时间。
- `/network-probe` 最多跑 1（直连）+ 有代理 1 + IP 1 = 3 次探测，串行，最坏约 30s；UI 侧按「检测中」呈现，不阻塞其他操作。
- 代理认证、PAC 文件解析、非 `github.com` 的 IP 优选仍然不做；`OPTIMIZABLE_HOSTS` 与 `PROXY_SCHEMES` 是后续扩展的两个开关。
