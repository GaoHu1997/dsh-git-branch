/**
 * Locale dictionaries for the git-worktree plugin. zh is the key source; en
 * is `Record<GitWorktreeKey, string>`, so a missing translation fails the
 * build instead of surfacing a raw key.
 */

/** Every copy key the plugin surfaces (chip, dialogs, settings card). */
export type GitWorktreeKey =
  | 'menuBranches'
  | 'menuLocalBranches'
  | 'menuWorktrees'
  | 'menuRemoteBranches'
  | 'menuSearchPlaceholder'
  | 'menuNoMatches'
  | 'menuNoBranches'
  | 'menuLocate'
  | 'menuExpandAll'
  | 'menuCollapseAll'
  | 'menuNewBranchPlaceholder'
  | 'menuNewBranchBad'
  | 'menuNewBranchExists'
  | 'menuFetch'
  | 'menuUpdate'
  | 'menuPush'
  | 'menuPushUnavailable'
  | 'ctxCheckout'
  | 'ctxHop'
  | 'ctxWorktree'
  | 'ctxWorktreeCut'
  | 'ctxCreate'
  | 'ctxCreateCheckout'
  | 'ctxRename'
  | 'ctxDelete'
  | 'ctxCopyName'
  | 'ctxCopyPath'
  | 'renameBranchTitle'
  | 'renameBranchBusy'
  | 'createFlyAsk'
  | 'createFlyAskFrom'
  | 'cutoutFlyAsk'
  | 'createCheckoutConfirm'
  | 'deleteBranchAsk'
  | 'deleteBranchBusy'
  | 'fetchDone'
  | 'updateDone'
  | 'updateUpToDate'
  | 'pushDone'
  | 'pushUpToDate'
  | 'aheadTitle'
  | 'behindTitle'
  | 'worktreeAskNew'
  | 'worktreeAskRemote'
  | 'worktreeAskReuse'
  | 'worktreeBusy'
  | 'createBranchBusy'
  | 'actionCancel'
  | 'actionConfirm'
  | 'errorGeneric'
  | 'cardDescription'
  | 'cardReadOnly'
  | 'cardRootDirLabel'
  | 'cardLegacyUnused'
  | 'cardRootDirHint'
  | 'cardOverridden'
  | 'cardSaveFailed'
  | 'cardDiscard'
  | 'cardSave'
  | 'cardSaving'
  | 'cardSwitchFailed'
  | 'cardManageWorktrees'
  | 'cardManageHint'
  | 'cardFetchBeforeCreateLabel'
  | 'cardFetchBeforeCreateHint'
  | 'cardAutoPruneLabel'
  | 'cardAutoPruneHint'
  | 'cardKeepWorktreesLabel'
  | 'cardKeepWorktreesHint'
  | 'cardKeepWorktreesBad'
  | 'cardPostCreateCopyFilesLabel'
  | 'cardPostCreateCopyFilesPlaceholder'
  | 'cardPostCreateCopyFilesHint'
  | 'cardPruneHistoryLabel'
  | 'cardPruneHistoryEmpty'
  | 'cardPruneHistoryRun'
  | 'cardPruneHistoryNone'
  | 'cardPruneHistorySkipped'
  | 'cardPruneHistoryFailed'
  | 'cardPruneHistoryMore'
  | 'cardPruneHistoryLess'
  | 'manager.title'
  | 'manager.loading'
  | 'manager.loadFailed'
  | 'manager.empty'
  | 'manager.count'
  | 'manager.truncated'
  | 'manager.countOrphans'
  | 'manager.orphans'
  | 'manager.sourceProject'
  | 'manager.sourceLegacy'
  | 'manager.activityNever'
  | 'manager.dirty.one'
  | 'manager.dirty.other'
  | 'manager.running'
  | 'manager.purgeMenu'
  | 'manager.purgeAria'
  | 'worktreePurge.title'
  | 'worktreePurge.desc'
  | 'worktreePurge.busy'
  | 'manager.removeAria'
  | 'fetchWarning'
  | 'excludeWarning'
  | 'pruneDone'
  | 'pruneFailed'
  | 'worktreeRemove.menu'
  | 'worktreeRemove.title'
  | 'worktreeRemove.desc'
  | 'worktreeRemove.descBranch'
  | 'worktreeRemove.inspecting'
  | 'worktreeRemove.dirty.one'
  | 'worktreeRemove.dirty.other'
  | 'worktreeRemove.clean'
  | 'worktreeRemove.ahead'
  | 'worktreeRemove.sessions.one'
  | 'worktreeRemove.sessions.other'
  | 'worktreeRemove.busy'
  | 'hover.copied'
  | 'time.now'
  | 'time.minutes'
  | 'time.hours'
  | 'time.days'
  | 'time.months'
  | 'time.years'
  | 'copy'
  | 'close'
  | 'cancel'
  | 'panel.nav'
  | 'panel.description'
  | 'panel.notARepo'
  | 'panel.noSession'
  | 'panel.loadFailed'
  | 'panel.retry'
  | 'panel.refresh'
  | 'panel.uncommitted'
  | 'panel.staged'
  | 'panel.unstaged'
  | 'panel.stageAll'
  | 'panel.unstageAll'
  | 'panel.stageHint'
  | 'panel.unstageHint'
  | 'panel.clean'
  | 'panel.changesTruncated'
  | 'panel.commitPlaceholder'
  | 'panel.commit'
  | 'panel.commitPush'
  | 'panel.commitMoreAria'
  | 'panel.commitBusy'
  | 'panel.commitDone'
  | 'panel.commitPushDone'
  | 'panel.commitNeedsStaged'
  | 'panel.commitNeedsMessage'
  | 'panel.aiGenerate'
  | 'panel.aiBusy'
  | 'panel.aiNeedsChanges'
  | 'panel.aiDone'
  | 'panel.aiFailed'
  | 'panel.branches'
  | 'panel.branchNew'
  | 'panel.branchLocals'
  | 'panel.branchRemotes'
  | 'panel.branchCheckout'
  | 'panel.branchCheckoutRemote'
  | 'panel.branchNewFrom'
  | 'panel.branchRename'
  | 'panel.branchDelete'
  | 'panel.branchCopy'
  | 'panel.branchCurrent'
  | 'panel.checkoutDone'
  | 'panel.renameDone'
  | 'panel.deleteDone'
  | 'panel.createDone'
  | 'panel.history'
  | 'panel.historySearch'
  | 'panel.historyBranch'
  | 'panel.historyAllRefs'
  | 'panel.historyAuthor'
  | 'panel.historyTime'
  | 'panel.rangeAll'
  | 'panel.rangeDay'
  | 'panel.rangeWeek'
  | 'panel.rangeCustom'
  | 'panel.rangeSince'
  | 'panel.rangeUntil'
  | 'panel.commitCopyHash'
  | 'panel.commitCopySubject'
  | 'panel.branchTag'
  | 'panel.tagTitle'
  | 'panel.tagName'
  | 'panel.tagMessage'
  | 'panel.tagDone'
  | 'panel.tagPush'
  | 'panel.tagPushDone'
  | 'panel.tagPushUpToDate'
  | 'panel.noCommits'
  | 'panel.noMatches'
  | 'panel.loadMore'
  | 'panel.filesTitle'
  | 'panel.binary'
  | 'panel.stAdd'
  | 'panel.stMod'
  | 'panel.stDel'
  | 'panel.stRen'
  | 'panel.stCopy'
  | 'panel.stType'
  | 'panel.stUntrack'
  | 'panel.stUnmerged'
  | 'panel.cnAccelerate'
  | 'accel.enable'
  | 'accel.hint'
  | 'accel.urlLabel'
  | 'accel.restoreDefault'
  | 'accel.urlInvalid'
  | 'accel.urlEmpty'
  | 'accel.saveFailed'
  | 'accel.savedOn'
  | 'accel.savedOff'
  | 'accel.mirrorDownHint'
  | 'panel.credentials'
  | 'cred.title'
  | 'cred.hint'
  | 'cred.empty'
  | 'cred.hostLabel'
  | 'cred.hostPlaceholder'
  | 'cred.presets'
  | 'cred.customPreset'
  | 'cred.usernameLabel'
  | 'cred.usernamePlaceholder'
  | 'cred.secretTokenLabel'
  | 'cred.secretPasswordLabel'
  | 'cred.secretKeep'
  | 'cred.secretPlaceholder'
  | 'cred.method'
  | 'cred.methodToken'
  | 'cred.methodPassword'
  | 'cred.getToken'
  | 'cred.add'
  | 'cred.edit'
  | 'cred.save'
  | 'cred.saving'
  | 'cred.delete'
  | 'cred.deleting'
  | 'cred.confirmDelete'
  | 'cred.cancel'
  | 'cred.saved'
  | 'cred.deleted'
  | 'cred.loadFailed'
  | 'cred.hostInvalid'
  | 'cred.hostEmpty'
  | 'cred.usernameEmpty'
  | 'cred.secretEmpty'
  | 'panel.remotes'
  | 'remotes.title'
  | 'remotes.hint'
  | 'remotes.empty'
  | 'remotes.add'
  | 'remotes.nameLabel'
  | 'remotes.namePlaceholder'
  | 'remotes.urlLabel'
  | 'remotes.urlPlaceholder'
  | 'remotes.fetchUrl'
  | 'remotes.pushUrl'
  | 'remotes.save'
  | 'remotes.saving'
  | 'remotes.edit'
  | 'remotes.remove'
  | 'remotes.confirmRemove'
  | 'remotes.cancel'
  | 'remotes.saved'
  | 'remotes.removed'
  | 'remotes.loadFailed'
  | 'remotes.nameEmpty'
  | 'remotes.nameInvalid'
  | 'remotes.urlEmpty'
  | 'remotes.urlInvalid'

/** English dictionary — complete by construction. */
export const en: Record<GitWorktreeKey, string> = {
  menuBranches: 'Branches',
  menuLocalBranches: 'Local branches',
  menuWorktrees: 'Worktrees',
  menuRemoteBranches: 'Remote branches',
  menuSearchPlaceholder: 'Search branches',
  menuNoMatches: 'No matching branches',
  menuNoBranches: 'No branches yet',
  menuLocate: 'Locate current branch',
  menuExpandAll: 'Expand all',
  menuCollapseAll: 'Collapse all',
  menuNewBranchPlaceholder: 'New branch name',
  menuNewBranchBad: 'Git will not accept this name',
  menuNewBranchExists: 'A branch with this name already exists',
  menuFetch: 'Fetch',
  menuUpdate: 'Update current branch from upstream',
  menuPush: 'Push current branch to upstream',
  menuPushUnavailable: 'No upstream or commits to push',
  ctxCheckout: 'Check out',
  ctxHop: 'Go to this worktree',
  ctxWorktree: 'Create worktree',
  ctxWorktreeCut: 'New branch and worktree',
  ctxCreate: 'New branch',
  ctxCreateCheckout: 'New branch and check out',
  ctxRename: 'Rename branch',
  ctxDelete: 'Delete branch',
  ctxCopyName: 'Copy branch',
  ctxCopyPath: 'Copy path',
  renameBranchTitle: 'Rename {branch}',
  renameBranchBusy: 'Renaming…',
  createFlyAsk: 'Enter a new branch name',
  createFlyAskFrom: 'New branch from {branch}',
  cutoutFlyAsk: 'Cut a new branch from {branch} into a worktree',
  createCheckoutConfirm: 'Create and check out',
  deleteBranchAsk: 'Delete branch {branch}? Unmerged branches are refused.',
  deleteBranchBusy: 'Deleting…',
  fetchDone: 'Remote branches synced',
  updateDone: '{branch} fast-forwarded to its upstream',
  updateUpToDate: 'Already up to date',
  pushDone: '{branch} pushed to its upstream',
  pushUpToDate: 'Remote already up to date',
  aheadTitle: '{n} commits ahead of upstream',
  behindTitle: '{n} commits behind upstream',
  worktreeAskNew: 'Create a worktree from {branch}?',
  worktreeAskRemote: 'Create a worktree from this remote branch?',
  worktreeAskReuse: 'Switch to the {branch} worktree?',
  worktreeBusy: 'Creating…',
  createBranchBusy: 'Creating…',
  actionCancel: 'Cancel',
  actionConfirm: 'Confirm',
  errorGeneric: 'Git worktree: {message}',
  cardDescription: 'Branch visibility and git worktree isolation for sessions; new worktrees are created inside their repository.',
  cardReadOnly: 'The settings document is read-only; edits cannot be saved.',
  cardRootDirLabel: 'Legacy storage folder',
  cardLegacyUnused: 'not in use (empty historical location)',
  cardRootDirHint: 'Historical central location, kept only for the worktrees already living there. New worktrees are created at <repo>/.dsh/gitworktree/<branch> inside their repository and locally ignored through .git/info/exclude.',
  cardOverridden: '(custom location)',
  cardSaveFailed: 'The change did not save. Check the path is absolute and try again.',
  cardDiscard: 'Discard',
  cardSave: 'Save',
  cardSaving: 'Saving…',
  cardSwitchFailed: 'This switch did not save. Try again.',
  cardManageWorktrees: 'Manage worktrees…',
  cardManageHint: 'Browse and remove worktrees across repositories — including directories never registered as workspaces.',
  cardFetchBeforeCreateLabel: 'Fetch upstream before creating',
  cardFetchBeforeCreateHint: 'Runs fetch --all --prune before each worktree creation. A failed sync never blocks the creation.',
  cardAutoPruneLabel: 'Auto-remove stale worktrees',
  cardAutoPruneHint: 'Over the cap, creating a worktree removes the least recently used ones (folders only — branches are kept). Uncommitted changes or a running session are never removed.',
  cardKeepWorktreesLabel: 'Worktrees to keep',
  cardKeepWorktreesHint: 'Global cap across all repositories, minimum 1.',
  cardKeepWorktreesBad: 'Enter an integer of at least 1',
  cardPostCreateCopyFilesLabel: 'Inherit configuration files (global fallback)',
  cardPostCreateCopyFilesPlaceholder: 'e.g.:\n.env\nconfig/secrets.json',
  cardPostCreateCopyFilesHint: 'One relative path per line. Only used when .worktreeinclude is absent from repository root; if present, .worktreeinclude takes precedence.',
  cardPruneHistoryLabel: 'Prune history',
  cardPruneHistoryEmpty: 'No prune runs yet',
  cardPruneHistoryRun: 'Removed {n}:',
  cardPruneHistoryNone: 'Nothing to remove this round',
  cardPruneHistorySkipped: '{n} skipped (uncommitted changes)',
  cardPruneHistoryFailed: '{n} failed',
  cardPruneHistoryMore: 'Show all {n}',
  cardPruneHistoryLess: 'Show less',
  'manager.title': 'Manage worktrees',
  'manager.loading': 'Scanning worktrees…',
  'manager.loadFailed': 'Scan failed: {message}',
  'manager.empty': 'The worktree storage root is empty.',
  'manager.count': '{n} worktree(s)',
  'manager.truncated': 'Too many directories to scan; showing the first batch. Check that the storage folder is set correctly.',
  'manager.countOrphans': ', {n} unrecognized',
  'manager.orphans': 'Unrecognized directories',
  'manager.sourceProject': 'in project',
  'manager.sourceLegacy': 'legacy location',
  'manager.activityNever': 'no sessions',
  'manager.dirty.one': '{n} uncommitted file',
  'manager.dirty.other': '{n} uncommitted files',
  'manager.running': 'A session is running here; removal is unavailable',
  'manager.purgeMenu': 'Delete folder',
  'manager.purgeAria': 'Delete the leftover folder “{path}”',
  'worktreePurge.title': 'Delete leftover folder',
  'worktreePurge.desc': 'This directory has no git record anymore. It will be deleted along with everything in it. This cannot be undone.',
  'worktreePurge.busy': 'Deleting folder…',
  'manager.removeAria': 'Remove the worktree “{path}”',
  fetchWarning: 'Upstream sync failed; created from the local state: {message}',
  excludeWarning: 'The ignore rule for the repository could not be written; `.dsh/` will show as untracked: {message}',
  pruneDone: 'Auto-removed {n} stale worktree(s)',
  pruneFailed: '{n} worktree(s) could not be auto-removed',
  'worktreeRemove.menu': 'Remove worktree',
  'worktreeRemove.title': 'Remove worktree',
  'worktreeRemove.desc': 'This removes the worktree from git and deletes the folder “{path}”.',
  'worktreeRemove.descBranch': 'The branch {branch} is kept.',
  'worktreeRemove.inspecting': 'Inspecting worktree…',
  'worktreeRemove.dirty.one': '{n} uncommitted file will be deleted with the folder.',
  'worktreeRemove.dirty.other': '{n} uncommitted files will be deleted with the folder.',
  'worktreeRemove.clean': 'No uncommitted changes.',
  'worktreeRemove.ahead': '{n} commits ahead of upstream, kept on the branch.',
  'worktreeRemove.sessions.one': '{n} session in this workspace will be archived too.',
  'worktreeRemove.sessions.other': '{n} sessions in this workspace will be archived too.',
  'worktreeRemove.busy': 'Removing…',
  'hover.copied': 'Copied',
  'time.now': 'now',
  'time.minutes': '{n}min',
  'time.hours': '{n}h',
  'time.days': '{n}d',
  'time.months': '{n}mo',
  'time.years': '{n}y',
  copy: 'Copy',
  close: 'Close',
  cancel: 'Cancel',
  'panel.nav': 'Git panel',
  'panel.description': 'Uncommitted changes, branches, and commit history',
  'panel.notARepo': 'The current session is not inside a git repository.',
  'panel.noSession': 'Open a session in a repository to see its git panel.',
  'panel.loadFailed': 'Git panel failed to load: {message}',
  'panel.retry': 'Retry',
  'panel.refresh': 'Refresh',
  'panel.uncommitted': 'Uncommitted changes',
  'panel.staged': 'Staged',
  'panel.unstaged': 'Unstaged',
  'panel.stageAll': 'Stage all',
  'panel.unstageAll': 'Unstage all',
  'panel.stageHint': 'git add',
  'panel.unstageHint': 'git reset',
  'panel.clean': 'No uncommitted changes',
  'panel.changesTruncated': 'Too many changes — showing only the first 500 rows',
  'panel.commitPlaceholder': 'Commit message (feat: …)',
  'panel.commit': 'Commit',
  'panel.commitPush': 'Commit and push',
  'panel.commitMoreAria': 'More commit actions',
  'panel.commitBusy': 'Committing…',
  'panel.commitDone': 'Committed: {subject}',
  'panel.commitPushDone': 'Committed and pushed: {subject}',
  'panel.commitNeedsStaged': 'Tick files to stage them first',
  'panel.commitNeedsMessage': 'Enter a commit message',
  'panel.aiGenerate': 'AI message',
  'panel.aiBusy': 'Generating…',
  'panel.aiNeedsChanges': 'Stage some changes first, then generate',
  'panel.aiDone': 'AI drafted a message — review and edit before committing',
  'panel.aiFailed': 'AI message failed: {message}',
  'panel.branches': 'Branches',
  'panel.branchNew': 'New branch',
  'panel.branchLocals': 'local',
  'panel.branchRemotes': 'remote',
  'panel.branchCheckout': 'Check out',
  'panel.branchCheckoutRemote': 'Check out (create local tracking branch)',
  'panel.branchNewFrom': 'New branch from here…',
  'panel.branchRename': 'Rename…',
  'panel.branchDelete': 'Delete',
  'panel.branchCopy': 'Copy name',
  'panel.branchCurrent': 'current branch',
  'panel.checkoutDone': 'Checked out {branch}',
  'panel.renameDone': 'Renamed to {branch}',
  'panel.deleteDone': 'Deleted branch {branch}',
  'panel.createDone': 'Created branch {branch}',
  'panel.history': 'Commit history',
  'panel.historySearch': 'Search commits / authors',
  'panel.historyBranch': 'Branch',
  'panel.historyAllRefs': 'All branches',
  'panel.historyAuthor': 'Author',
  'panel.historyTime': 'Time',
  'panel.rangeAll': 'All time',
  'panel.rangeDay': 'Last 24 hours',
  'panel.rangeWeek': 'Last 7 days',
  'panel.rangeCustom': 'Custom range',
  'panel.rangeSince': 'From',
  'panel.rangeUntil': 'To',
  'panel.commitCopyHash': 'Copy hash',
  'panel.commitCopySubject': 'Copy message',
  'panel.branchTag': 'Tag this commit…',
  'panel.tagTitle': 'New tag at {branch}',
  'panel.tagName': 'Tag name',
  'panel.tagMessage': 'Message (optional)',
  'panel.tagDone': 'Tagged {tag}',
  'panel.tagPush': 'Push tag {tag}',
  'panel.tagPushDone': 'Pushed tag {tag} to {remote}',
  'panel.tagPushUpToDate': 'Tag {tag} is already on {remote}',
  'panel.noCommits': 'This repository has no commits yet',
  'panel.noMatches': 'No matching commits',
  'panel.loadMore': 'Load more',
  'panel.filesTitle': 'Changed files ({n}) · {author} · {date}',
  'panel.binary': 'binary',
  'panel.stAdd': 'added',
  'panel.stMod': 'modified',
  'panel.stDel': 'deleted',
  'panel.stRen': 'renamed',
  'panel.stCopy': 'copied',
  'panel.stType': 'type changed',
  'panel.stUntrack': 'untracked',
  'panel.stUnmerged': 'conflict',
  'panel.cnAccelerate': 'China acceleration',
  'accel.enable': 'Enable acceleration',
  'accel.hint': 'Accelerates https github.com remotes for fetch/update only; push is never proxied. The mirror sees repository content — do not use it for private or sensitive repositories.',
  'accel.urlLabel': 'Acceleration URL',
  'accel.restoreDefault': 'Restore default',
  'accel.urlInvalid': 'Enter an http(s):// URL',
  'accel.urlEmpty': 'Enter an acceleration URL',
  'accel.saveFailed': 'The change did not save. Try again.',
  'accel.savedOn': 'China acceleration enabled: {url}',
  'accel.savedOff': 'China acceleration disabled',
  'accel.mirrorDownHint': 'If the mirror is down, disable acceleration or change the URL',
  'panel.credentials': 'Credentials',
  'cred.title': 'Git credentials',
  'cred.hint': 'Global, one entry per host: a token saved for github.com serves every repository. Stored only on this machine in git-credentials.json.',
  'cred.empty': 'No credentials saved yet',
  'cred.hostLabel': 'Host',
  'cred.hostPlaceholder': 'github.com',
  'cred.presets': 'Common hosts',
  'cred.customPreset': 'Custom host',
  'cred.usernameLabel': 'Username',
  'cred.usernamePlaceholder': 'Account name or e-mail',
  'cred.secretTokenLabel': 'Token',
  'cred.secretPasswordLabel': 'Password',
  'cred.secretKeep': 'A secret is already saved — leave blank to keep it',
  'cred.secretPlaceholder': 'Paste a token or password',
  'cred.method': 'Authentication',
  'cred.methodToken': 'Token',
  'cred.methodPassword': 'Username and password',
  'cred.getToken': 'Get a token',
  'cred.add': 'Add credential',
  'cred.edit': 'Edit',
  'cred.save': 'Save',
  'cred.saving': 'Saving…',
  'cred.delete': 'Delete',
  'cred.deleting': 'Deleting…',
  'cred.confirmDelete': 'Delete for good',
  'cred.cancel': 'Cancel',
  'cred.saved': 'Saved the credential for {host}',
  'cred.deleted': 'Deleted the credential for {host}',
  'cred.loadFailed': 'Could not read the credential store',
  'cred.hostInvalid': 'Enter a host such as github.com',
  'cred.hostEmpty': 'Enter a host',
  'cred.usernameEmpty': 'Enter a username',
  'cred.secretEmpty': 'Enter a token or password for a new host',
  'panel.remotes': 'Remotes',
  'remotes.title': 'Remote addresses',
  'remotes.hint': 'Remotes belong to the whole repository and apply to every worktree of it.',
  'remotes.empty': 'No remote is configured',
  'remotes.add': 'Add remote',
  'remotes.nameLabel': 'Name',
  'remotes.namePlaceholder': 'origin',
  'remotes.urlLabel': 'Address',
  'remotes.urlPlaceholder': 'https://github.com/user/repo.git',
  'remotes.fetchUrl': 'Fetch',
  'remotes.pushUrl': 'Push',
  'remotes.save': 'Save',
  'remotes.saving': 'Saving…',
  'remotes.edit': 'Change address',
  'remotes.remove': 'Remove',
  'remotes.confirmRemove': 'Remove for good',
  'remotes.cancel': 'Cancel',
  'remotes.saved': 'Updated the remote {name}',
  'remotes.removed': 'Removed the remote {name}',
  'remotes.loadFailed': 'Could not read the remotes',
  'remotes.nameEmpty': 'Enter a name',
  'remotes.nameInvalid': 'Only letters, digits, ".", "_" and "-" are allowed',
  'remotes.urlEmpty': 'Enter an address',
  'remotes.urlInvalid': 'Enter a valid remote address',
}

/** 中文词典。 */
export const zh: Record<GitWorktreeKey, string> = {
  menuBranches: '分支',
  menuLocalBranches: '本地分支',
  menuWorktrees: '工作树',
  menuRemoteBranches: '远程分支',
  menuSearchPlaceholder: '搜索分支',
  menuNoMatches: '没有匹配的分支',
  menuNoBranches: '暂无分支',
  menuLocate: '定位当前分支',
  menuExpandAll: '全部展开',
  menuCollapseAll: '全部折叠',
  menuNewBranchPlaceholder: '新分支名称',
  menuNewBranchBad: 'Git 不接受该名称',
  menuNewBranchExists: '同名分支已存在',
  menuFetch: '提取',
  menuUpdate: '更新当前分支',
  menuPush: '推送当前分支',
  menuPushUnavailable: '没有上游或没有可推送的提交',
  ctxCheckout: '签出',
  ctxHop: '跳到此工作树',
  ctxWorktree: '创建工作树',
  ctxWorktreeCut: '新建分支并创建工作树',
  ctxCreate: '新建',
  ctxCreateCheckout: '新建并检出',
  ctxRename: '重命名分支',
  ctxDelete: '删除分支',
  ctxCopyName: '复制分支',
  ctxCopyPath: '复制路径',
  renameBranchTitle: '重命名 {branch}',
  renameBranchBusy: '重命名中…',
  createFlyAsk: '输入新分支名称',
  createFlyAskFrom: '从 {branch} 新建分支',
  cutoutFlyAsk: '从 {branch} 切出新分支并创建工作树',
  createCheckoutConfirm: '新建并检出',
  deleteBranchAsk: '是否删除分支 {branch}？未合并的分支会被拒绝。',
  deleteBranchBusy: '删除中…',
  fetchDone: '远程分支已同步',
  updateDone: '{branch} 已快进到远程最新',
  updateUpToDate: '已是最新',
  pushDone: '{branch} 已推送到远程',
  pushUpToDate: '远程已是最新',
  aheadTitle: '领先上游 {n} 个提交',
  behindTitle: '落后上游 {n} 个提交',
  worktreeAskNew: '是否从 {branch} 新建工作树？',
  worktreeAskRemote: '从该远程分支新建工作树？',
  worktreeAskReuse: '是否切到 {branch} 工作树？',
  worktreeBusy: '创建中…',
  createBranchBusy: '创建中…',
  actionCancel: '取消',
  actionConfirm: '确认',
  errorGeneric: 'Git 工作树：{message}',
  cardDescription: '为会话提供分支可见性与 git 工作树隔离；新建工作树落在各仓库内。',
  cardReadOnly: '设置文档为只读，修改无法保存。',
  cardRootDirLabel: '历史存放目录',
  cardLegacyUnused: '未使用（历史位置为空）',
  cardRootDirHint: '历史集中位置，仅为已有工作树保留。新建工作树落在各仓库内 <repo>/.dsh/gitworktree/<branch>，并通过 .git/info/exclude 本地忽略。',
  cardOverridden: '（已自定义位置）',
  cardSaveFailed: '保存未生效，请检查路径是否为绝对路径后重试。',
  cardDiscard: '放弃',
  cardSave: '保存',
  cardSaving: '保存中…',
  cardSwitchFailed: '该开关未保存，请重试。',
  cardManageWorktrees: '管理工作树…',
  cardManageHint: '跨仓库查看并删除全部工作树，包含从未注册为工作区的目录。',
  cardFetchBeforeCreateLabel: '创建工作树前同步上游',
  cardFetchBeforeCreateHint: '每次创建工作树前先执行 fetch --all --prune 同步远程引用；同步失败不会阻断创建。',
  cardAutoPruneLabel: '自动删除旧工作树',
  cardAutoPruneHint: '超出保留数量时，新建工作树后自动删除最久未用的（只删目录，保留分支）。有未提交改动或进行中会话的不会被删。',
  cardKeepWorktreesLabel: '保留工作树数量',
  cardKeepWorktreesHint: '所有仓库合计的全局上限，最小为 1。',
  cardKeepWorktreesBad: '请输入不小于 1 的整数',
  cardPostCreateCopyFilesLabel: '新建工作树配置文件继承（全局后备）',
  cardPostCreateCopyFilesPlaceholder: '例如：\n.env\nconfig/secrets.json',
  cardPostCreateCopyFilesHint: '每行一个相对路径。仅在仓库根目录不存在 .worktreeinclude 时生效；若仓库存在 .worktreeinclude，则优先使用该文件。',
  cardPruneHistoryLabel: '清理记录',
  cardPruneHistoryEmpty: '暂无清理记录',
  cardPruneHistoryRun: '清理了 {n} 个：',
  cardPruneHistoryNone: '本轮无需清理',
  cardPruneHistorySkipped: '{n} 个因未提交改动跳过',
  cardPruneHistoryFailed: '{n} 个失败',
  cardPruneHistoryMore: '展开全部 {n} 条',
  cardPruneHistoryLess: '收起',
  'manager.title': '管理工作树',
  'manager.loading': '正在扫描工作树…',
  'manager.loadFailed': '扫描失败：{message}',
  'manager.empty': '工作树存放目录暂无内容。',
  'manager.count': '{n} 个工作树',
  'manager.truncated': '目录过多，仅显示前一批。请检查存放目录是否设置正确。',
  'manager.countOrphans': '，{n} 个无法识别',
  'manager.orphans': '无法识别的目录',
  'manager.sourceProject': '项目内',
  'manager.sourceLegacy': '历史位置',
  'manager.activityNever': '无会话',
  'manager.dirty.one': '{n} 个未提交文件',
  'manager.dirty.other': '{n} 个未提交文件',
  'manager.running': '有进行中的会话，暂不能删除',
  'manager.purgeMenu': '删除文件夹',
  'manager.purgeAria': '删除残留文件夹“{path}”',
  'worktreePurge.title': '删除残留文件夹',
  'worktreePurge.desc': '该目录已无 git 记录，将连同全部内容一并删除，此操作不可恢复。',
  'worktreePurge.busy': '正在删除文件夹…',
  'manager.removeAria': '删除工作树“{path}”',
  fetchWarning: '上游同步失败，已按本地状态创建：{message}',
  excludeWarning: '仓库忽略规则写入失败，`.dsh/` 将显示为未跟踪目录：{message}',
  pruneDone: '已自动清理 {n} 个旧工作树',
  pruneFailed: '{n} 个工作树自动清理失败',
  'worktreeRemove.menu': '删除工作树',
  'worktreeRemove.title': '删除工作树',
  'worktreeRemove.desc': '将从 git 移除该工作树并删除目录“{path}”。',
  'worktreeRemove.descBranch': '分支 {branch} 将保留。',
  'worktreeRemove.inspecting': '正在检查工作树…',
  'worktreeRemove.dirty.one': '{n} 个未提交文件将随目录一并删除。',
  'worktreeRemove.dirty.other': '{n} 个未提交文件将随目录一并删除。',
  'worktreeRemove.clean': '无未提交改动。',
  'worktreeRemove.ahead': '分支领先上游 {n} 个提交，提交将保留在分支上。',
  'worktreeRemove.sessions.one': '该工作区下的 {n} 个会话将一并归档。',
  'worktreeRemove.sessions.other': '该工作区下的 {n} 个会话将一并归档。',
  'worktreeRemove.busy': '删除中…',
  'hover.copied': '已复制',
  'time.now': '刚刚',
  'time.minutes': '{n}分钟',
  'time.hours': '{n}小时',
  'time.days': '{n}天',
  'time.months': '{n}个月',
  'time.years': '{n}年',
  copy: '复制',
  close: '关闭',
  cancel: '取消',
  'panel.nav': 'Git 管理',
  'panel.description': '未提交变更、分支操作与提交历史',
  'panel.notARepo': '当前会话不在 git 仓库中。',
  'panel.noSession': '在 git 仓库中打开一个会话后，这里会显示它的 Git 面板。',
  'panel.loadFailed': 'Git 面板加载失败：{message}',
  'panel.retry': '重试',
  'panel.refresh': '刷新',
  'panel.uncommitted': '未提交变更',
  'panel.staged': '已暂存',
  'panel.unstaged': '未暂存',
  'panel.stageAll': '全部暂存',
  'panel.unstageAll': '全部取消暂存',
  'panel.stageHint': 'git add',
  'panel.unstageHint': 'git reset',
  'panel.clean': '没有未提交的变更',
  'panel.changesTruncated': '变更过多，仅显示前 500 行',
  'panel.commitPlaceholder': '提交信息（feat: …）',
  'panel.commit': '提交',
  'panel.commitPush': '提交并推送',
  'panel.commitMoreAria': '更多提交操作',
  'panel.commitBusy': '提交中…',
  'panel.commitDone': '已提交：{subject}',
  'panel.commitPushDone': '已提交并推送：{subject}',
  'panel.commitNeedsStaged': '先勾选文件加入暂存区',
  'panel.commitNeedsMessage': '填写提交信息后提交',
  'panel.aiGenerate': 'AI 生成',
  'panel.aiBusy': '生成中…',
  'panel.aiNeedsChanges': '先暂存一些变更再生成',
  'panel.aiDone': 'AI 已生成提交信息，请检查后提交',
  'panel.aiFailed': 'AI 生成失败：{message}',
  'panel.branches': '分支',
  'panel.branchNew': '新建分支',
  'panel.branchLocals': '本地',
  'panel.branchRemotes': '远程',
  'panel.branchCheckout': '检出',
  'panel.branchCheckoutRemote': '检出（新建本地跟踪分支）',
  'panel.branchNewFrom': '新建分支自此…',
  'panel.branchRename': '重命名…',
  'panel.branchDelete': '删除',
  'panel.branchCopy': '复制名称',
  'panel.branchCurrent': '当前分支',
  'panel.checkoutDone': '已检出 {branch}',
  'panel.renameDone': '已重命名为 {branch}',
  'panel.deleteDone': '已删除分支 {branch}',
  'panel.createDone': '已创建分支 {branch}',
  'panel.history': '提交历史',
  'panel.historySearch': '搜索提交 / 作者',
  'panel.historyBranch': '分支',
  'panel.historyAllRefs': '所有分支',
  'panel.historyAuthor': '提交人',
  'panel.historyTime': '时间',
  'panel.rangeAll': '全部',
  'panel.rangeDay': '近 24 小时',
  'panel.rangeWeek': '近 7 天',
  'panel.rangeCustom': '自定义范围',
  'panel.rangeSince': '从',
  'panel.rangeUntil': '到',
  'panel.commitCopyHash': '复制哈希',
  'panel.commitCopySubject': '复制消息',
  'panel.branchTag': '添加标签…',
  'panel.tagTitle': '在 {branch} 上新标签',
  'panel.tagName': '标签名称',
  'panel.tagMessage': '消息（可选）',
  'panel.tagDone': '已标记 {tag}',
  'panel.tagPush': '推送标签 {tag}',
  'panel.tagPushDone': '已推送标签 {tag} 到 {remote}',
  'panel.tagPushUpToDate': '标签 {tag} 已存在于 {remote}',
  'panel.noCommits': '仓库还没有提交',
  'panel.noMatches': '没有匹配的提交',
  'panel.loadMore': '加载更多',
  'panel.filesTitle': '变更文件（{n}）· {author} · {date}',
  'panel.binary': '二进制',
  'panel.stAdd': '新增',
  'panel.stMod': '修改',
  'panel.stDel': '删除',
  'panel.stRen': '重命名',
  'panel.stCopy': '复制',
  'panel.stType': '类型变更',
  'panel.stUntrack': '未跟踪',
  'panel.stUnmerged': '冲突',
  'panel.cnAccelerate': '国内加速',
  'accel.enable': '启用加速',
  'accel.hint': '仅加速 https 的 github.com 仓库地址，作用于提取/更新；推送不走加速。第三方加速站可看到仓库内容，请勿用于私有/敏感仓库。',
  'accel.urlLabel': '加速地址',
  'accel.restoreDefault': '恢复默认',
  'accel.urlInvalid': '请输入以 http(s):// 开头的地址',
  'accel.urlEmpty': '请输入加速地址',
  'accel.saveFailed': '保存未生效，请重试。',
  'accel.savedOn': '已启用国内加速：{url}',
  'accel.savedOff': '已关闭国内加速',
  'accel.mirrorDownHint': '若加速地址不可用，可停用国内加速或更换地址',
  'panel.credentials': '密钥配置',
  'cred.title': 'Git 密钥配置',
  'cred.hint': '全局生效：同一域名只需配置一次，该域名的所有仓库共用。密钥只保存在本机 git-credentials.json 中。',
  'cred.empty': '还没有配置任何密钥',
  'cred.hostLabel': '域名',
  'cred.hostPlaceholder': 'github.com',
  'cred.presets': '常用平台',
  'cred.customPreset': '自定义域名',
  'cred.usernameLabel': '用户名',
  'cred.usernamePlaceholder': '账号名或邮箱',
  'cred.secretTokenLabel': '令牌',
  'cred.secretPasswordLabel': '密码',
  'cred.secretKeep': '已保存密钥，留空表示不修改',
  'cred.secretPlaceholder': '粘贴令牌或密码',
  'cred.method': '认证方式',
  'cred.methodToken': '令牌',
  'cred.methodPassword': '账号密码',
  'cred.getToken': '获取令牌',
  'cred.add': '新增密钥',
  'cred.edit': '编辑',
  'cred.save': '保存',
  'cred.saving': '保存中…',
  'cred.delete': '删除',
  'cred.deleting': '删除中…',
  'cred.confirmDelete': '确认删除',
  'cred.cancel': '取消',
  'cred.saved': '已保存 {host} 的密钥',
  'cred.deleted': '已删除 {host} 的密钥',
  'cred.loadFailed': '读取密钥失败',
  'cred.hostInvalid': '请输入类似 github.com 的域名',
  'cred.hostEmpty': '请输入域名',
  'cred.usernameEmpty': '请输入用户名',
  'cred.secretEmpty': '新域名必须填写令牌或密码',
  'panel.remotes': '管理远程',
  'remotes.title': '远程地址',
  'remotes.hint': '远程地址属于整个仓库，对该仓库的所有工作树生效。',
  'remotes.empty': '还没有配置远程地址',
  'remotes.add': '添加远程',
  'remotes.nameLabel': '名称',
  'remotes.namePlaceholder': 'origin',
  'remotes.urlLabel': '地址',
  'remotes.urlPlaceholder': 'https://github.com/user/repo.git',
  'remotes.fetchUrl': '提取',
  'remotes.pushUrl': '推送',
  'remotes.save': '保存',
  'remotes.saving': '保存中…',
  'remotes.edit': '修改地址',
  'remotes.remove': '移除',
  'remotes.confirmRemove': '确认移除',
  'remotes.cancel': '取消',
  'remotes.saved': '已更新远程 {name}',
  'remotes.removed': '已移除远程 {name}',
  'remotes.loadFailed': '读取远程地址失败',
  'remotes.nameEmpty': '请输入名称',
  'remotes.nameInvalid': '仅允许字母、数字、"."、"_"、"-"',
  'remotes.urlEmpty': '请输入地址',
  'remotes.urlInvalid': '请输入有效的远程地址',
}
