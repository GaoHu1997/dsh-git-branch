# 0021 — 全局按域名的 Git 密钥配置

状态：已接受  
日期：2026-10-29

## 背景

插件此前只会调用本机的 `git`，fetch / update / push / 推送标签这些网络动作能否成功，完全取决于用户事先在命令行里配好的 credential helper。面板里没有任何地方能录入 GitHub / GitLab / Gitee 的令牌，所以一旦凭据没配好，用户只会看到一串 `Authentication failed`，而那个错误并没有指向「去哪儿配」。

需求同时明确了两条约束：

- 密钥是**全局**的，不属于某个项目。同一个 `github.com` 下可能有多个仓库、多个工作树，用户不该为每个仓库重复录入一次。
- 同一个域名只应保存一条记录，且支持两种形态：令牌（personal access token）与账号密码。令牌还需要一个「跳到对应页面去生成」的入口——用户通常并不知道令牌页面的位置。

## 决策

- 凭据存放在独立的全局文件 `<DSH_HOME>/git-credentials.json`（`DSH_HOME` 为空时回落 `~/.dsh`），而不是写进插件配置（settings / profile patch）。
  - 配置 patch 会被同步、被导出、被其它插件读到；密钥混在里面等于把凭据放进了可分享的文本。独立文件可以单独设权限（写入 `mode 0600`，先写临时文件再 `rename`），删除插件配置也不会顺手删掉密钥。
  - 文件是版本化文档（`{version: 1, credentials: [...]}`），每条记录 `{host, username, secret, method, updatedAt}`，host 为唯一键；`upsertCredential` 保证同一域名只有一条。
- 认证注入用 `git -c http.https://<host>/.extraHeader=AUTHORIZATION: basic <base64>`，而不是：
  - 写全局 `git config`：会污染用户所有仓库，且插件卸载后残留，用户无从得知是谁改的。
  - 改写或临时覆盖 credential helper：helper 是用户级配置，插件不该在别人的机制里插一脚。
  - `http.<url>.extraHeader` 由 git 自己按 URL 前缀匹配，只有 `https://<host>` 的远程会带上这个头；一次注入全部已存域名也不会串号（ssh 与 http 明文都不会命中）。这也是 `authConfigArgs` 可以安全地「无脑注入全部 host」的原因。
- 注入点收敛在 `src/routes.ts` 的 `authArgsFor`，只对网络动作生效（fetch / update / push / push-tag / 建工作树前的 fetch）。它读 store 失败时返回空数组：**凭据文件损坏不能阻断 git**，此时退化为「没有插件凭据」的既有行为，而不是让所有网络按钮变成 500。
- 路由是 POST 的 `credentials` / `credentials-save` / `credentials-delete`（与仓库无关，body 里没有 `repoPath`），列表接口只回显 `secretMask`（`****` + 末四位），secret 永不出网：
  - 保存时省略 `secret` 表示「保留原值」，这样编辑用户名或方法不需要重新粘贴令牌；新域名则必须给出 secret。
  - 删除是不可逆动作，UI 用「删除 → 确认删除」两段式，服务端只校验该 host 是否存在。
- 弹窗默认是「已配置清单」：新增表单藏在提示行右侧的「+」图标后面，点开才出现（编辑某一行时也复用它并预填）。空清单时同样只显示提示与图标。
- 域名归一化（`normalizeCredentialHost`）接受用户直接粘贴的 URL：去 scheme、去 userinfo、去路径与查询、小写、去尾点，端口仅保留数字形式。用户从浏览器地址栏复制 `https://github.com/owner/repo` 是最自然的输入。
- 客户端不 import `src/credentials.ts`（它依赖 `node:fs` / `node:path`，会污染浏览器 bundle）。客户端只做空值提示，域名合法性以服务端错误文本回显为准。
- 「获取令牌」链接按域名内置：github.com、gitlab.com、gitee.com 各自指向其 token 创建页；其它域名不显示该链接（不猜第三方站点的路径）。

## 影响

- 配好一次，该域名下所有仓库、所有工作树、所有面板实例共享；不需要重启 DSH，下一次网络动作即生效。
- 明文密钥落在 `~/.dsh/git-credentials.json`（0600）。这是「插件替用户记住令牌」无法回避的代价；不走系统钥匙串是因为 DSH 插件没有跨平台密钥库依赖，且引入一个原生依赖会破坏插件的纯 Node 安装体验。
- `extraHeader` 只对 `https://` 远程生效：ssh 远程仍由 ssh key 负责，http 明文远程不会被注入（避免明文传输密钥）。这是刻意的保护，不是遗漏。
- 令牌页链接只是方便入口，插件不校验令牌权限/过期时间——git 的报错仍是最终裁判。
- 凭据文件被手工改坏时，列表接口会返回 500 说明路径与原因，而网络动作降级为匿名执行；两处行为不一致是刻意的：读列表要如实报告坏文件，跑 git 不该因为坏文件而瘫痪。
