# 0040 — 加速前缀保留完整 GitHub URL

状态: 已接受

日期: 2026-11-03

## 背景

0018 的预期是在完整 GitHub URL 前拼接加速站前缀，但实际 `accelArgs` 把 `https://github.com/` 直接替换成站点根路径，丢掉了上游域名。已有测试仅比较参数字符串，复制了同一错误。用户指出 `git.tangbai.cc/https://github.com/…` 的格式，要求调整并实测。

## 决策

- `cnAccelerateUrl` 保持“加速站前缀”的语义。输入 `https://gh-proxy.com/` 时，注入 `url.https://gh-proxy.com/https://github.com/.insteadOf=https://github.com/`，得到 `<prefix>https://github.com/owner/repo.git`。已包含末尾 `/https://github.com/` 的配置直接作为改写基址，不重复添加。只在单次提取命令生效，推送保持直连。
- 不依据域名猜测另一种替换模式，也不自动尝试多个站点；实测证明默认站的前缀模式可用，当前没有替换模式可用的证据。默认地址仍为 `https://gh-proxy.com/`，不修改用户已保存的地址或版本号。
- 添加真实 Git 的 `remote get-url` 回归检查，验证最终 URL 而非只验证 argv。更新中英文表单说明。
- 提供 `scripts/probe-acceleration.mjs`：在临时目录中禁用系统/全局 Git 配置、清理 Git 注入环境、禁用凭据助手和交互，用公开仓库对比两种格式。`--fetch` 用构建后的 `fetchAll` 执行真实提取；网络结果不作为离线单元测试的依赖。

2026-11-03 本机 `git ls-remote … HEAD` 实测（不带凭据）：

| 地址 | 仓库 | 结果 | 耗时 |
| --- | --- | --- | --- |
| `https://git.tangbai.cc/<owner>/<repo>.git` | `git/git`、`zhidian-cmd/gitport-github` | 两者均 repository not found | 各约 0.75 秒 |
| `https://git.tangbai.cc/https://github.com/<owner>/<repo>.git` | 同上 | 两者均 repository not found | 各约 0.75 秒 |
| `https://gh-proxy.com/git/git.git` | `git/git` | repository not found | 1.96 秒 |
| `https://gh-proxy.com/https://github.com/git/git.git` | `git/git` | 成功 | 5.94 秒 |
| `https://github.com/git/git.git` | `git/git` | 成功 | 19.96 秒 |

后两项均返回 HEAD `ebdc087dc99d68bb340c282b2ba5f722def28d19`。据此选用“前缀 + 完整上游 URL”；不能把 tangbai 的失败归因于仓库不存在，也不能仅修正路径就宣称该站可用。单次耗时不构成稳定加速承诺。

补充验证：构建后通过实际 `fetchAll` 从 `https://gh-proxy.com/https://github.com/octocat/Hello-World.git` 提取成功；远端 HEAD 与本地 `refs/remotes/origin/master` 均为 `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`，查询和提取共 17.10 秒。全部 34 个测试文件、639 项测试通过，后端编译、前端类型检查及客户端构建通过。

## 影响

- 正面：默认加速站的请求路径符合真实 Git 服务支持的格式，根地址和带 GitHub 基址的配置都能正确生成请求；回归测试覆盖此前遗漏的 Git 实际改写行为。
- 负面：依赖“替换 GitHub 域名”语义的自定义站点不属于本次支持范围；第三方站点可用性会变化，tangbai 目前两种格式均失败。镜像仍只适用于公开且非敏感的仓库。
- 不新增配置键、自动切换、全局 Git URL 改写或发布动作。
