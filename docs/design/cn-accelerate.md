# 「国内加速」按钮设计（Git 管理面板顶部）

状态：设计稿，未实现。HTML 视觉稿见 [cn-accelerate-mockup.html](./cn-accelerate-mockup.html)。

## 1. 需求

无代理环境下 GitHub 直连经常失败。在 Git 管理页面顶部增加「国内加速」按钮：

- 点击弹出配置浮层：**启用/禁用开关** + **加速地址输入框**（默认 `https://gh-proxy.com/`，可修改）；
- 启用后，插件的网络 git 读操作把 GitHub https 地址重写为「加速前缀 + 原地址」再访问（URL 重写方案）；
- 禁用（默认）时行为与现在完全一致。

## 2. 交互设计

### 2.1 入口（topbar）

位置：`GitPanelTab` 的顶栏操作区（`src/client/GitHistoryPanel.tsx:506` 的 `header.css.topbar` → `css.topbarActions`），在「刷新」按钮左侧。

按钮三态：

| 态 | 外观 |
|---|---|
| 未启用（默认） | 次要色图标+文字「国内加速」，与「刷新」同级的幽灵按钮 |
| 已启用 | 品牌色弱底（`rgba(76,107,245,.16)`）+ 品牌色文字 + 绿色小圆点，表示加速生效中 |
| hover | 同现有按钮 hover（`--dsw-alias-interactive-bg-hover`） |

按钮不依赖仓库状态（配置是全局的），无会话时也可点。

### 2.2 配置浮层（点击按钮弹出）

锚定按钮下方、右对齐；点外部或 Esc 关闭（未保存的修改丢弃，不做二次确认）。

内容自上而下：

1. 标题行：「国内加速」+ 启用开关（switch）。
2. 说明文字（tertiary 小字）：仅加速 https 的 github.com 地址，作用于提取/更新；推送不走加速。第三方加速站可看到仓库内容，请勿用于私有/敏感仓库。
3. 「加速地址」输入框 + 「恢复默认」小按钮（填回 `https://gh-proxy.com/`，不自动保存）。
4. 校验错误行（仅校验失败时出现）。
5. 底部按钮：「取消」（幽灵）/「保存」（品牌色实心）。

**生效规则：开关与输入框的修改统一随「保存」提交**（一次生效，避免半生效状态）。保存成功：

- 浮层关闭，toast：`已启用国内加速：{url}` / `已关闭国内加速`；
- 按钮切换到对应态。

### 2.3 设置卡片同步行

设置卡片（`src/client/GitWorktreeCard.tsx` 的卡片表单）新增一行「国内加速」：开关 + 地址输入 + 说明，与浮层共用同一配置键和校验。浮层是快捷入口，不是第二套配置。

## 3. 数据模型

沿用现有 volatile Config 模式（settings 服务投影 + profile patch 持久化，与 `fetchBeforeCreate` 同层）：

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `cnAccelerate` | `Volatile<boolean> \| boolean` | `false` | 启用开关，默认关闭 |
| `cnAccelerateUrl` | `Volatile<string> \| string` | `https://gh-proxy.com/` | 加速前缀地址 |

同步改动点：

- `src/index.ts:66` 的 `Config` z schema（两个 `.volatile()` 字段）；
- `src/index.ts:76` 的 `validateConfig`：unknown-key 白名单 + 类型校验 + URL 校验（见 §5）；
- `src/index.ts:126` 的 `SectionConfig` / `sectionOf`（开关默认值落默认，URL 缺省不落）；
- `src/index.ts:175` 的 `RouteDeps` 增加 `sectionCnAccelerate` / `sectionCnAccelerateUrl` getter；
- `src/client/locales.ts` 新增文案键（§6）；
- `src/client/card-form.ts` 新增字段与开关动作。

## 4. 后端实现：URL 重写

### 4.1 机制

对单次 git 命令注入 `-c` 参数（**不写用户全局 git config**，可回滚、与"本地有代理"的用户互不干扰）：

```
git -c url."https://gh-proxy.com/".insteadOf="https://github.com/" fetch --all --prune
```

`execFile` 的 argv 形式（无 shell 引号）：

```
['-c', 'url.https://gh-proxy.com/.insteadOf=https://github.com/', 'fetch', '--all', '--prune']
```

git 会把任何以 `https://github.com/` 开头的 remote URL 前缀替换成加速前缀：

```
https://github.com/GaoHu1997/dsh-git-branch.git
→ https://gh-proxy.com/https://github.com/GaoHu1997/dsh-git-branch.git
```

（gh-proxy.com 等加速站约定的即这种「前缀 + 原 URL」拼接形式。）

### 4.2 作用范围（关键决策）

| 操作 | 是否走加速 | 说明 |
|---|---|---|
| `fetchAll`（`src/git.ts:544`，/fetch、/update、worktree 创建前 fetch） | ✅ | 读操作，加速收益最大 |
| `updateBranch` 的 fetch 阶段 | ✅ | 同上 |
| `pushBranch`（`src/git.ts:597`） | ❌ 保持直连 | 见下 |
| SSH remote（`git@github.com:…`） | ❌ 不重写 | 加速站只代理 https |

**push 不走加速**：公共加速镜像基本不支持 receive-pack，重写只会把可诊断的直连失败变成镜像层的诡异失败；push 保持直连，失败时错误提示引导（提示可停用加速/换 SSH 443/换 Gitee 镜像仓库）。被否决的备选：所有网络命令统一重写——push 经第三方代理还有提交内容外泄风险。

### 4.3 失败表现

加速站挂掉时 fetch 直接失败（git stderr 现有 toast 机制照常展示），toast 文案追加提示：「若加速地址不可用，可停用国内加速或更换地址」。**不做自动降级回直连**（本期不做，见 §7）。

## 5. 地址校验与规范化（保存时）

1. trim 前后空白；
2. 必须 `http://` 或 `https://` 开头，且无空白字符 → 否则输入框红框 + 错误行「请输入以 http(s):// 开头的地址」，不保存；
3. 空串 → 错误行「请输入加速地址」，不保存；
4. 结尾缺 `/` 自动补上（`https://gh-proxy.com` → `https://gh-proxy.com/`）——前缀必须以 `/` 收尾，拼接结果才是合法 URL。

## 6. 文案（locales.ts，zh 为源）

| key | zh | en |
|---|---|---|
| `panel.cnAccelerate` | 国内加速 | China acceleration |
| `accel.title` | 国内加速 | China acceleration |
| `accel.enable` | 启用加速 | Enable acceleration |
| `accel.hint` | 仅加速 https 的 github.com 仓库地址，作用于提取/更新；推送不走加速。第三方加速站可看到仓库内容，请勿用于私有/敏感仓库。 | Accelerates https github.com remotes for fetch/update only; push is never proxied. The mirror sees repository content — do not use it for private or sensitive repositories. |
| `accel.urlLabel` | 加速地址 | Acceleration URL |
| `accel.restoreDefault` | 恢复默认 | Restore default |
| `accel.save` | 保存 | Save |
| `accel.cancel` | 取消 | Cancel |
| `accel.urlInvalid` | 请输入以 http(s):// 开头的地址 | Enter an http(s):// URL |
| `accel.urlEmpty` | 请输入加速地址 | Enter an acceleration URL |
| `accel.savedOn` | 已启用国内加速：{url} | China acceleration enabled: {url} |
| `accel.savedOff` | 已关闭国内加速 | China acceleration disabled |
| `accel.mirrorDownHint` | 若加速地址不可用，可停用国内加速或更换地址 | If the mirror is down, disable acceleration or change the URL |

## 7. 已知限制（文档化，本期不处理）

- **带内嵌凭据的 URL**（`https://<token>@github.com/…`）不匹配 `https://github.com/` 前缀，不会被重写（不常见形态）；
- 只匹配精确前缀，大小写变体（`https://GitHub.com/`）不重写；
- 不做"直连失败自动降级"与"连通性测试按钮"——保持本期改动面小；若后续要做，测试按钮复用 `/fetch` 路由跑一次 `git ls-remote` 即可，不需要新增路由。

## 8. 测试点

- URL 规范化/校验纯函数单测（补尾 `/`、trim、拒绝非法协议、拒绝空白内嵌）；
- 启用时 `fetchAll` 的 exec argv 含 `-c url.<prefix>.insteadOf=https://github.com/`，且 `-c` 在子命令前；禁用时不含；
- `pushBranch` 的 argv 永不携带该 `-c`（即使启用）；
- `validateConfig` 拒绝非法 `cnAccelerateUrl`；
- 设置卡片与浮层写同一配置键，互相可见。

## 9. 落地清单

- `src/git.ts`：网络读命令注入 `-c`（新增 helper，如 `accelArgs()`）；
- `src/index.ts`：schema / validateConfig / SectionConfig / RouteDeps；
- `src/wire.ts` + `src/routes.ts`：无需新路由；
- `src/client/GitHistoryPanel.tsx`：topbar 按钮 + 浮层组件（新文件建议 `src/client/panel/CnAcceleratePopover.tsx`）；
- `src/client/card-form.ts` + `GitWorktreeCard.tsx`：设置卡片同步行；
- `src/client/locales.ts`：§6 文案；
- 实现提交须按 AGENTS.md 同一提交内补 `docs/decisions/` 决策记录。
