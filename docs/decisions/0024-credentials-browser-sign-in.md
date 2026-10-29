# 0024 — 凭据表单的 IDEA 式浏览器授权与令牌创建入口

状态：已接受  
日期：2026-10-29

## 背景

0021 落地了全局按域名的凭据配置，0023 让令牌可以免用户名。但用户仍要自己去 GitHub 网页创建 PAT，再回到面板粘贴。用户对照 IntelliJ IDEA 的体验提出两点：

1. 选择「账号密码」时，字段下方给一个「连接」按钮，点击打开浏览器完成登记，然后等回调自动完成配置；
2. 选择「令牌」时，在密钥输入框末尾放一个「创建」按钮，点击直接跳到对应站点的令牌创建页。

约束来自运行环境。插件跑在用户本机（DSH 由本机 `dsh` 进程服务），没有可登记的公网回调地址；OAuth 授权码 + 回环 redirect 虽然在本机可行，但需要固定端口与 OAuth App 登记，用户得多走一步。GitHub 为桌面/CLI 场景提供的 device flow（RFC 8628）不需要回调地址：host 拿一次性 code，用户去浏览器输入，host 轮询取 token。

另一个现实约束是网络：2026-10-29 实测本机到 `github.com` 的 TLS 连接被干扰（`TLS connect error: error:0A000126:SSL routines::unexpected eof while reading`），连 device-code 端点都会 20s 超时。因此浏览器授权路径当下无法真机联调，只能靠 mock fetch 的单元测试保证分支正确，网络恢复后再人工验证。

## 决策

- **新增 `src/oauth.ts`，用 GitHub OAuth 2.0 device flow 换取 token**：
  - `startDeviceFlow` POST `https://<host>/login/device/code`（form-urlencoded、`Accept: application/json`），取回 `device_code` / `user_code` / `verification_uri` / 可选 `verification_uri_complete` / `interval`（缺省 5s）/ `expires_in`（缺省 900s）。
  - `pollDeviceFlow` POST `https://<host>/login/oauth/access_token`，`grant_type=urn:ietf:params:oauth:grant-type:device_code`；`access_token` 即成功，`authorization_pending` / `slow_down` / `expired_token` / `access_denied` / 其它错误码分别映射为 pending / slow_down / expired / denied / failed。只有传输失败抛异常——token 端点用 `400` + OAuth error body 报告「还没批准」，那是正常答案而非故障，故 `postForm` 设有 `allowErrorStatus` 开关。
  - 每步 HTTP 用 `AbortSignal.timeout` 限时（缺省 15s），错误信息里带 URL，路由层再包成 502。
- **client id 内置 GitHub CLI 的公开 app id（`178c6fc778ccc68e1d6a`），并支持 `DSH_GITHUB_OAUTH_CLIENT_ID` 覆盖**。device flow 是 public client，不需要 client secret，所以内置一个公开 id 不产生密钥泄露；gh 的 app 已开启 device flow，`repo` scope 覆盖私有仓库读写。备选与否决理由：
  - 自建 OAuth App：需要用户先去开发者设置建应用、抄 id，与「点一下就能连」的目标冲突；留作环境变量覆盖路径。
  - GitHub App user-to-server token：需要 installation，device flow 不支持，否决。
  - 借用 gh 的 app 不是长期契约（gh 若关闭 device flow 或调整 scope 会失效），故 ADR 明确记录替换动作：设 `DSH_GITHUB_OAUTH_CLIENT_ID` 指向自建 OAuth App（需开启 device flow，scope 至少 `repo`）。
- **新增两条路由 `ROUTE_CREDENTIALS_OAUTH_START` / `ROUTE_CREDENTIALS_OAUTH_POLL`**（`POST /credentials-oauth-start`、`POST /credentials-oauth-poll`）：
  - host 必须先过 `normalizeCredentialHost`，且属于 `BROWSER_SIGN_IN_HOSTS`（当前只有 `github.com`）。该常量定义在 `wire.ts`，`oauth.ts` 直接复用，避免「界面给了按钮、host 却不支持」的漂移。
  - poll 拿到 `access_token` 后按 token 方式 upsert（`username: ''`、`method: 'token'`），套用既有的 `credentialSecretIssue` 校验、`sortCredentials` 排序与 `credentialView` 掩码；**token 只存在于 host 进程内，不再回传浏览器**。
  - `RouteDeps.fetchImpl` 作为 HTTP seam，测试注入假 fetch；缺省走全局 fetch。
- **对话框（`CredentialModal`）**：
  - 密码模式且 host 在 `BROWSER_SIGN_IN_HOSTS` 内：密钥字段下方渲染「连接」按钮；点击后 `requestOAuthStart` → `window.open(verificationUriComplete ?? verificationUri)` → 在表单内显示一次性验证码、验证页链接与「等待授权中」，随后按 `intervalSeconds` 轮询；`slow_down` 时把间隔翻倍（上限 60s）继续等；成功则刷新列表、关闭编辑器并提示已保存。
  - 用 `useRef` 代数计数器（`oauthRun`）在「取消、关闭、改为编辑另一条、组件卸载」时放弃在途轮询，防止迟到的答案复活已关闭的表单。
  - 令牌模式：密钥输入框末尾的「创建」按钮（替换原先 label 行上的「获取令牌」链接）直接 `window.open` 该 host 的 PAT 创建页（`TOKEN_PAGES`，github/gitlab/gitee 各有入口）。
- **保留原有「用户名 + 密钥」粘贴路径**：浏览器授权是增量入口，不是替代。密码凭据仍然可存（自建 GitLab/Gitea 可能仍接受密码），只是 GitHub 上的密码认证在 2021 年已废除，故「连接」按钮正好承担「用浏览器把密码换成交互式 token」的角色。

## 影响

- 用户配置 GitHub 凭据不再需要手动创建并粘贴 PAT：点「连接」→ 浏览器确认 → 凭据以 token 方式入库，存储、注入（`-c http.https://…extraHeader`）、掩码全部复用既有代码，行为与手填 token 完全同构。
- 「创建」按钮把令牌创建页放到了输入框末尾，符合 IDEA 的位置习惯，也少一次「先看提示再点链接」的往返。
- 引入对第三方 app id 的依赖：gh 的 app 若失效，用户会看到 502/400 错误，需设置 `DSH_GITHUB_OAUTH_CLIENT_ID` 指向自建 OAuth App。ADR 把这条运维动作固定下来，避免未来排查时重新推导。
- 安全边界：浏览器只看到 user code、验证页链接和最终掩码；token 交换发生在 host 进程，前端的 request/response 里不会出现明文 token。轮询请求本身是普通 HTTP POST，但只在用户点击「连接」后由表单发起，且随编辑器关闭而中止。
- 当前网络干扰下浏览器授权无法真机验证；`tests/oauth.spec.ts` 的 31 个用例覆盖 device flow 每条应答分支与两条路由的 400/502/存储/掩码行为。网络恢复后需人工走一遍完整流程，特别是 GitHub 对内置 client id 的 scope 授权页面。
