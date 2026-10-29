# 0026 — 凭据表单以浏览器登录为主路径，轮询网络抖动不再终止登录

状态：已接受  
日期：2026-10-29

## 背景

0024 上线了 device flow 浏览器授权。真机使用时暴露出两个问题：

1. **一次网络抖动就毁掉整次登录**。用户点「连接」，浏览器页面打开、用户完成授权，但插件随后的一次轮询失败，表单立刻显示 `could not poll the browser sign-in: https://github.com/login/oauth/access_token could not be reached (fetch failed)`。0024 已经记录本机到 github.com 的 TLS 连接会被干扰；`postForm` 把任何传输失败都抛成异常，而 `handleCredentialsOAuthPoll` 把它翻成 502，客户端收到 `!polled.ok` 就 `setFormError` 并结束循环。设备码有效期 900 秒，一次 keep-alive 连接被重置就把一次已批准的授权作废了。
2. **界面还在教用户填已经没用的东西**。认证方式是「账号密码 / 令牌」两个 tab；选「账号密码」时给出用户名、密码输入框，`连接` 按钮藏在字段下方。GitHub 2021 年已废除密码认证，GitLab/Gitee 也要求 PAT，这块表单实际只会收到域名拒绝的凭据。用户要求：把「连接」改名「点击跳转登录」，并去掉用户名和密码的输入框。

## 决策

- **轮询把「连不上」与「授权结果」分开**：
  - `src/oauth.ts` 新增 `DeviceFlowTransportError`，`postForm` 的 catch 抛它而不是泛型 `Error`；`pollDeviceFlow` 捕获它并返回新的 `{ status: 'network', message }`，其余失败（非 JSON 响应、HTTP 5xx）仍抛异常。
  - `CredentialOAuthPollResult`（`src/wire.ts`）增加 `{ status: 'network'; message: string }`；`handleCredentialsOAuthPoll` 遇到 network 返回 **200**，让客户端继续轮询，而不是 502 终止。
  - 客户端 `CredentialModal` 的轮询循环对 `network` 计数，连续 `OAUTH_NETWORK_RETRY_LIMIT = 5` 次才放弃并显示 `cred.deviceNetwork`（「无法连接 {host}，请检查网络或代理后重试」）；任何一次成功应答把计数清零。这样单次 TLS 抖动自动恢复，持续断网约 25 秒后仍会给出可读错误，而不是静默转到验证码过期。
  - 否决「无限重试到设备码过期」：彻底断网时用户要等 15 分钟才见到错误。
  - 否决「在插件里接系统代理/`HTTPS_PROXY`」：Node 24 的 undici 不自动读这类变量，引入 `ProxyAgent` 或打开 `NODE_USE_ENV_PROXY` 都属于改宿主的网络行为，超出本插件的职责；本次只做「不因抖动丢授权」。
- **认证方式收敛为「浏览器登录 / 令牌」两项**：
  - `AuthMode = 'browser' | 'token'`。`browser` 只对 `BROWSER_SIGN_IN_HOSTS`（当前 `github.com`）出现；其它 host 不渲染方式切换，只给令牌输入框（用户确认「非 GitHub 只给令牌」）。
  - 浏览器登录模式下不再有密钥/用户名输入，也没有「保存」按钮：登录成功由 host 侧写入 token，编辑器自动收起。令牌模式保留令牌输入与「创建」按钮，保存按钮只在令牌模式出现。
  - `save()` 固定以 `method: 'token'`、`username: ''` 落库；`cred.usernameEmpty` / `usernameLabel` / `usernamePlaceholder` / `secretPasswordLabel` 文案删除。
  - 「连接」文案改为「点击跳转登录」（英文 `Sign in with browser`），新增 `cred.methodBrowser`「浏览器登录」与 `cred.browserHint`。
  - 编辑既有凭据时：`method === 'token'` 落到令牌方式；历史的 `password` 凭据落到浏览器登录方式（其密码已无法在此编辑）。列表仍把历史 `password` 记为「密码」，但不再能新建。
  - 切换方式或重新 seed 会 `oauthRun.current += 1`，放弃在途轮询，避免迟到的应答改写用户当前看到的表单。
- **不抽公共组件**：与 0025 同理，凭据表单与远程表单的差异（预设域名、两种认证路径、OAuth 状态机）远大于共性；复用止于交互约定与 CSS 类。

## 影响

- 正面：浏览器授权在真实网络下可用——用户批准后的一次连接重置不再作废登录；界面只保留两条真正能走通的路径，GitHub 用户打开编辑器点预设后直接看到「点击跳转登录」。
- 行为变化：不再能新建「用户名 + 密码」凭据。仍需要密码的极端场景（自建 Gitea 老版本）只能走令牌；这是有意的取舍，密码认证在三大平台均已不可用或即将关闭。
- 历史数据兼容：存储层 `CredentialMethod` 仍是 `'token' | 'password'`，老条目照常注入 `-c http.https://…extraHeader`；列表显示不变，只是编辑入口指向浏览器登录。
- 测试：`tests/oauth.spec.ts` 的两条网络失败用例由「抛错 / 502」改为「`network` 状态 / 200」；展开态的 UI 仍无法在 node 环境的 vitest 里点击，靠 typecheck 与真机验证。
- 遗留：`handleCredentialsOAuthStart` 的网络失败仍是 502 加英文原文（`could not start the browser sign-in: …`），该路径失败时用户尚未授权，直接报错是合理的；若以后要统一文案，可在路由层复用 `cred.deviceNetwork`。
