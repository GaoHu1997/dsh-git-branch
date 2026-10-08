# 0007 — 插件展示名称与描述使用 locale 词典

日期: 2026-09-30
状态: 已接受

## 背景

插件管理器卡片原先只有技术标识：包名 `@gaohu9712/dsh-git-branch` 和 `package.json.description`。用户要求为插件增加中文名称「git 分支管理」与中文描述「在对话框提供 git 分支管理以及代码推送、拉取功能」，因此需要确认 DSH 读取展示元信息的机制并按其约定提供文案。

`readPluginMeta(specifier, parentURL)`（`@deepseek-ai/dsh-app-boot`）的行为决定了文案位置：

- 先解析 `${specifier}/locale/en.json`；**该文件解析不到时词典直接为空**，同目录其它语言文件全部被忽略。因此缺少 `locale/en.json` 时只放 `locale/zh.json` 不会生效。
- 词典目录取 `locale/en.json` 解析后的所在目录，逐个读取其中所有 `*.json`（文件名即语言 ID，需匹配 `/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u`），每个文件仍按 `${specifier}/locale/<name>` 走 Node exports 解析。
- 每个文件读取 `meta.title` / `meta.description`；非字符串、空串或纯空白会抛出并转为 `error` 诊断，而不是回退文本。
- 标题在各语言都未提供时回退 `package.json.name`，描述回退 `package.json.description`；一旦任一语言提供，返回值即 `{ en: <回退文本>, ...各语言 }` 形式的翻译映射，由客户端按当前语言选择。

## 决策

新增 `locale/en.json` 与 `locale/zh.json`，各自只声明 `meta.title` 与 `meta.description`；`package.json` 增加 export `"./locale/*.json": "./locale/*.json"` 并把 `locale/*.json` 列入 `files`。

- `locale/zh.json`：`title` = `git 分支管理`，`description` = `在对话框提供 git 分支管理以及代码推送、拉取功能`（用户指定原文）。
- `locale/en.json`：`title` = `git branch management`，`description` = `Git branch management in the composer, plus code push and pull.`

## 理由

- DSH 只通过 exports 解析资源，不发布到 `files` 或在 `exports` 中放行 `./locale/*.json` 都会让 `readPluginMeta` 解析失败，文案静默退回包名。
- `locale/en.json` 是必需的基础设施而非英文翻译需求：没有它，`locale/zh.json` 完全不生效。
- 英文侧同时提供 `title`，是因为 `localizedText` 的 `en` 回退值是 `package.json.name`；若英文只提供描述，英文界面下标题会显示为完整的 scoped 包名 `@gaohu9712/dsh-git-branch`。
- 保留 `package.json.description` 原文不动：它是 npm 层面的详细说明，locale 词典是卡片展示用的短文案，与 `dsh-model-think-level` 的既有做法一致。
- 未声明 `package.json.icon`：仓库根目录的 `icon.svg` 尚未纳入版本控制也未列入 `files`，一旦声明而文件不存在，`iconOf` 会让整张卡片带上 `error` 诊断。

## 验证

在 Web profile 目录（`$env:USERPROFILE\.dsh\profiles\web`，其 `node_modules/@gaohu9712/dsh-git-branch` 为指向本仓库的 junction）内以 Node ESM 解析器复刻 `readPluginMeta` 的读取流程，实测：

```
resolved en.json : D:\github\dsk-plugin\dsh-git-branch\locale\en.json
locale languages : en, zh
title           : {"en":"git branch management","zh":"git 分支管理"}
description     : {"en":"Git branch management in the composer, plus code push and pull.","zh":"在对话框提供 git 分支管理以及代码推送、拉取功能"}
```

补充确认 `pnpm pack --dry-run` 的产物清单包含 `locale/en.json` 与 `locale/zh.json`。

## 影响

插件管理器卡片、bundle 详情与设置页插件清单在中文界面下显示「git 分支管理」及其描述，英文界面显示对应英文文案；包名、entry id、路由与设置命名空间等技术标识不变。新增 `locale/` 目录需要在后续语言增删时保持与 `locale/en.json` 同目录、同语言 ID 规则。
