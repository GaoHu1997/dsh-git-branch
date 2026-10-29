# 0023 — 令牌免用户名与 AI 可读的密钥工具

状态：已接受  
日期：2026-10-29

## 背景

密钥配置落地后暴露两个问题：

1. 表单把「用户名」当成必填。但令牌（GitHub PAT、GitLab/Gitee 令牌）本身就是完整凭据，HTTP Basic 里的用户名只是个占位；强制用户再填一个账号名既反直觉，也容易让人误以为要填真实密码。
2. 密钥只有面板能看见，对话里的 AI 完全不知道用户配过哪些域名。用户要求「增加一个工具，让 AI 使用」——典型场景是让 AI 协助排查推送失败、或判断某个远程是否已有凭据，而不是让 AI 凭空猜。

## 决策

- **按认证方式区分用户名的必填性**：`credentialUsernameIssue(value, method)` 增加第二个参数；`method === 'token'` 时允许为空，`password` 仍要求非空。
  - 存储层不为空用户名做特殊编码：`GitCredential.username` 保持空串，真正发送 Basic 头时由新增的纯函数 `basicUsername(entry)` 兜底成占位名 `TOKEN_USERNAME = 'oauth2'`。GitHub / GitLab / Gitee 对 PAT 都接受任意非空用户名，`oauth2` 是通用约定。
  - 这样「用户填了什么」与「git 实际发什么」可以分别断言，列表也能诚实显示「没填用户名」。
  - 客户端同步：令牌模式下用户名标签换成「用户名（可选）」，只有账号密码模式才在前端拦截空用户名；服务端仍是最终裁决者。
- **新增模型可见的只读工具 `git_credentials`**，与 HTTP 路由读同一个凭据文件：
  - 定义写在 `src/tool.ts`，是普通对象（`name` / `description` / `parameters`（JSON Schema）/ `output.schema` / `output.render` / `execute`），通过 `ctx.inject(['tools'], …)` + `ctx.tools.register(...)` 注册，`effect` 负责卸载时反注册。**不 import `@deepseek-ai/dsh-tools`**：本插件不把 host 运行时当值依赖，`defineTool` 只是把同样的字段拼起来，普通对象走同一条注册路径。
  - 参数只有 `host`（可选过滤，大小写不敏感）与 `includeSecret`（默认 false）。默认只返回 `****` 掩码：工具的常规用途是「这个域名配了吗」，把密钥写进对话记录属于副作用很大的动作，必须由用户明确要求才发生。即使 `includeSecret: true`，描述里也写明值会进入会话记录。
  - 读文件失败不抛错，而是把错误折进返回值（`error` 字段，`credentials: []`）：AI 应当能回答「凭据文件坏了」，而不是收到一个无信息量的工具异常。
  - 工具不写、不删、不校验连通性，避免把一次误调用变成配置变更。
- 认证注入（`authConfigArgs`）随 `basicUsername` 一起改：空用户名的 token 条目生成的头部是 `oauth2:<secret>`。

## 影响

- 令牌模式少一个必填项，表单与「令牌/账号密码」的语义一致；已存的老数据（用户名非空）行为不变。
- AI 能直接回答「本机配了哪些域名的密钥、用的什么方式、尾号多少」。要真正看到明文仍需用户授权式地要求 `includeSecret`，并且会话记录会留下该值——这是有意的取舍：只读工具的价值在于减少来回确认，不在于绕过用户的知情。
- 工具只覆盖「凭据状态」。远程地址管理仍是面板/HTTP 路由的职责，AI 通过已有的 `remotes` 查询能力即可观察，不额外开写接口。
