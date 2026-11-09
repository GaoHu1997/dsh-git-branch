# 0047 — 发布正文随仓库提交，发布前校验

状态：已接受

## 背景

插件市场的「版本更新」弹窗直接渲染 GitHub Release 的 body（`dshmarket/lib/changelog.js` 的 `updateNotesFor` 优先取 release body，其次最近 5 条 commit，最后只给 npm 发布时间）。本仓库直推 main、不走 PR，`gh release create --generate-notes` 只能产出空壳小节或一行 compare 链接，用户看到的更新说明没有信息量。正文此前只存在于 `CHANGELOG.md`，而 Release 页不读它——素材写了也等于没写。

## 决策

- 每个 `vX.Y.Z` tag 必须提交 `.github/releases/vX.Y.Z.md`，文件名与 tag 完全一致。
- `release.yml` 在 `Refuse to republish an existing version` 之后、`Publish to npm` 之前新增 `Verify release notes`：文件存在、≥300 字节、≥8 个非空行、至少一个 `## ` 小节、含 `**Full Changelog**`，任一不满足即 `::error::` 退出。
- 创建 Release 一律 `--notes-file`；已存在时用 `gh release edit` 覆盖正文，不留 `--generate-notes` 兜底分支，避免规则被静默绕过。
- 已发布版本的正文补写走 `sync-release-notes.yml`（`workflow_dispatch`，读同名文件后 `gh release edit`），不重新发版、不动 tag 与 npm 版本。
- `.gitignore` 不得忽略 `.github/releases/`：CI 在 tag 上 checkout 时读不到文件，等同于没写。

## 影响

正文缺失的 tag 会在 npm 发布前失败——补好文件重推 tag 即可，不会出现「npm 有版本、Release 没有说明」的状态。`CHANGELOG.md` 保留为仓库内记录，Release 正文以 `.github/releases/` 为准，两者内容可以重叠但不必逐字一致。
