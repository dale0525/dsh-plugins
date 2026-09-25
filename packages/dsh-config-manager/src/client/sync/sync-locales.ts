/**
 * 远程同步设置区块（config-manager-sync）表面文案：zh 为源语言，en 镜像每个键。
 * 独立命名空间、独立文件：不触碰共享的 locales.ts（并行会话已改），零冲突。
 * 键集合经 `SyncKey` 类型在 client/index.ts 注册处做编译期校验。
 */

export const zh = {
  // 入口
  'section.label': '远程同步',
  'section.description': '通过私有 Git / WebDAV 通道在设备间同步 DSH 配置（明文，私有通道自用）',
  // 私有仓库强制提示（常驻警示横幅）
  'privateRepoHint': '安全要求：同步仓库必须为私有仓库（public 仓库会公开你的配置内容）。认证 token 仅用于仓库访问，绝不写入同步文件、提交内容或日志。',
  // 仓库配置表单
  'config.title': '仓库配置',
  'config.repoUrl': '仓库地址',
  'config.repoUrlHint': 'Git 私有仓库地址（https / ssh / 本地路径）。认证 token 请使用下方凭据字段，不要拼入地址。',
  'config.token': '认证 token',
  'config.tokenHint': '将安全写入 DSH credentials（引用名 {ref}），不会写入同步文件或日志。留空表示沿用已保存的凭据。',
  'config.tokenSaved': '凭据已配置',
  'config.tokenPlaceholder': 'ghp_…（可选）',
  // 配置保存（自动保存 + 显式保存按钮）
  'config.save': '保存配置',
  'config.saving': '保存中…',
  'config.saveHint': '表单改动会自动保存（密码/token 安全写入 DSH credentials，不会写入同步文件或日志）；也可点击按钮立即保存。',
  // 通道选择器
  'channel.title': '同步通道',
  'channel.git': 'Git 私有仓库',
  'channel.webdav': 'WebDAV 服务器',
  'channel.perChannelHint': 'GitHub 与 WebDAV 通道的配置各自独立保存。',
  // 通道入口卡（弹窗驱动：点按钮 → 弹窗内配置通道）
  'channel.open': '配置同步通道',
  'channel.openHint': '远程同步通过「同步通道」进行：Git 私有仓库或 WebDAV 服务器。点击按钮在弹窗中配置或修改。',
  'channel.configured': '已配置',
  'channel.notConfigured': '未配置',
  'channel.currentUrl': '当前地址',
  'syncStatus.lastSync': '上次同步',
  'syncStatus.sections': '可同步分区',
  'syncStatus.state': '配置状态',
  // WebDAV 配置表单
  'webdav.title': 'WebDAV 配置',
  'webdav.url': '服务器地址',
  'webdav.urlHint': 'WebDAV 服务器根地址（https://…）。同步快照与索引存放于该地址的 dsh-config-manager/ 子目录下。请勿在地址中包含用户名/密码。',
  'webdav.username': '用户名',
  'webdav.usernameHint': 'HTTP Basic 认证用户名（非敏感，可回显）。',
  'webdav.password': '密码',
  'webdav.passwordHint': '将安全写入 DSH credentials（引用名 {ref}），不会写入同步文件或日志。留空表示沿用已保存的凭据。',
  'webdav.passwordSaved': '凭据已配置',
  'webdav.passwordPlaceholder': '密码（可选）',
  'webdav.presetHint': '选择常见 WebDAV 服务器可快速填入地址；含 <占位符> 的模板请替换为你的真实服务器/用户名。',
  // GitHub OAuth 登录（device flow，无需手动输入 token）
  'github.title': 'GitHub 登录',
  'github.description': '通过 GitHub OAuth 设备码流程授权：无需手动输入 token，在浏览器中确认授权后，token 自动写入 DSH credentials。',
  'github.login': '使用 GitHub 登录',
  'github.retry': '重新登录',
  'github.cancel': '取消',
  'github.tokenInvalid': 'GitHub 登录已失效，请重新登录。',
  'github.userCode': '一次性授权代码',
  'github.openAuth': '打开 GitHub 授权页面',
  'github.clientIdHint': '需要插件配置 githubClientId（GitHub OAuth App 的 client_id）才能使用 GitHub 登录。',
  // 状态
  'status.title': '同步状态',
  'status.never': '从未同步',
  // 报告
  // 同步范围（固定，无模式选择）
  'scope.title': '同步范围',
  'scope.hint': '推送与拉取恒同步全部支持的分区（settings、providers、plugins、prompts、skills、mcp、credentials 等），无需配置。',
  'scope.excludedHint': 'workspaces（含本机绝对路径）与 sessions（历史会话，体积大且含敏感内容）不参与同步。快照为明文，仅同步到你自己配置的私有通道。',
  'history.title': '同步历史',
  'history.empty': '尚无同步历史',
  'history.emptyHint': '完成首次推送或拉取后，这里会显示记录。',
  'history.colTime': '时间',
  'history.colKind': '类型',
  'history.colDetail': '详情',
  'history.kindSnapshot': '快照',
  'history.sectionCount': '分区',
  'history.column.snapshot': '快照',
  // 触发通道（同步历史「由哪个通道触发」）
  'history.channelGit': 'GitHub',
  'history.channelWebdav': 'WebDAV',
  // 列表头部统计摘要（需求 4F）
  'history.stats.total': '共 {count} 条',
  'history.stats.snapshots': '快照 {count}',
  'history.stats.summary': '同步历史统计',
  // —— Toast 操作回执（R-20：按动作分文案） ——
  // 原先 10+ 个动作的失败共用同一个 state.error；机械替换成 Toast 后，同 kind+text
  // 会被 store 的去重逻辑合并（互相顶掉），故此处为每个动作单独给出可区分文案。
  'toast.configSaveFailed': '保存通道配置失败',
  'toast.configSaved': '通道配置已保存',
  'toast.configNothingToSave': '请先填写通道地址再保存',

  'toast.pushFailed': '推送失败',
  'toast.pushDone': '推送完成（快照 {id}，{count} 个分区）',
  'toast.pushWarnings': '推送完成，但有 {count} 条分区告警',
  'toast.pullFailed': '拉取失败',
  'toast.pullDone': '拉取完成（快照 {id}，写入 {count} 个分区）',
  'toast.pullEmpty': '拉取完成：远端快照与本地一致（无变更）',
  'toast.pullWarnings': '拉取完成，但有 {count} 条分区告警',
  'toast.rollbackDone': '已撤销本次覆盖，本地配置恢复为拉取前状态',
  'toast.rollbackPartial': '撤销部分完成，部分项目可能需人工恢复',
  'toast.rollbackFailed': '撤销失败',
  'toast.lockRecoverFailed': '回收残留锁失败',
  'toast.recoveryDismissFailed': '解除保护失败',
  // —— 撤销本次覆盖（同步页上的危险操作：danger + 二次确认） ——
  'pull.undo': '撤销本次覆盖',
  'rollback.title': '撤销本次覆盖',
  'rollback.body': '将把本地配置恢复为本次拉取之前的状态（应用前自动落下的回滚快照）。此操作会覆盖当前的本地配置。',
  'rollback.confirm': '确认撤销',
  'rollback.running': '正在撤销…',
  // 页面级加载失败（M-16：就地错误态标题；loadError 此前无任何渲染点）
  'load.failed': '加载同步状态失败',
  // 公共
  'common.close': '关闭',
  'common.retry': '重试',
  'common.loading': '加载中…',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'section.label': 'Remote Sync',
  'section.description': 'Sync DSH configuration across devices via a private Git / WebDAV channel (plaintext, for your own private channel)',
  'privateRepoHint': 'Security requirement: the sync repository MUST be private (a public repo would expose your configuration). The auth token is only used for repository access and is never written into sync files, commit content, or logs.',
  'config.title': 'Repository',
  'config.repoUrl': 'Repository URL',
  'config.repoUrlHint': 'Private Git repository URL (https / ssh / local path). Use the credential field below for the auth token; never embed it in the URL.',
  'config.token': 'Auth token',
  'config.tokenHint': 'Securely written into DSH credentials (ref {ref}); never written into sync files or logs. Leave blank to reuse the saved credential.',
  'config.tokenSaved': 'Credential configured',
  'config.tokenPlaceholder': 'ghp_… (optional)',
  // Config save (auto-save + explicit save button)
  'config.save': 'Save config',
  'config.saving': 'Saving…',
  'config.saveHint': 'Form changes are saved automatically (password/token written securely into DSH credentials, never into sync files or logs); you can also save explicitly with the button.',
  'channel.title': 'Sync Channel',
  'channel.git': 'Git private repo',
  'channel.webdav': 'WebDAV server',
  'channel.perChannelHint': 'The GitHub and WebDAV channel settings are stored independently.',
  // Channel entry card (dialog-driven: click the button → configure the channel in the dialog)
  'channel.open': 'Configure sync channel',
  'channel.openHint': 'Remote sync runs through a sync channel: a private Git repository or a WebDAV server. Click the button to configure or change it in the dialog.',
  'channel.configured': 'Configured',
  'channel.notConfigured': 'Not configured',
  'channel.currentUrl': 'Current URL',
  'syncStatus.lastSync': 'Last sync',
  'syncStatus.sections': 'Syncable sections',
  'syncStatus.state': 'State',
  'webdav.title': 'WebDAV Configuration',
  'webdav.url': 'Server URL',
  'webdav.urlHint': 'WebDAV server root URL (https://…). Sync snapshots and the index are stored under a dsh-config-manager/ subdirectory of that URL. Do not include a username/password in the URL.',
  'webdav.username': 'Username',
  'webdav.usernameHint': 'HTTP Basic auth username (not sensitive, may be shown).',
  'webdav.password': 'Password',
  'webdav.passwordHint': 'Securely written into DSH credentials (ref {ref}); never written into sync files or logs. Leave blank to reuse the saved credential.',
  'webdav.passwordSaved': 'Credential configured',
  'webdav.passwordPlaceholder': 'Password (optional)',
  'webdav.presetHint': 'Pick a common WebDAV server to prefill the URL; templates containing <placeholders> need to be replaced with your real server/username.',
  'github.title': 'GitHub Sign-in',
  'github.description': 'Authorize via the GitHub OAuth device flow: no manual token entry — after you approve in the browser, the token is written into DSH credentials automatically.',
  'github.login': 'Sign in with GitHub',
  'github.retry': 'Sign in again',
  'github.cancel': 'Cancel',
  'github.tokenInvalid': 'GitHub sign-in is no longer valid — please sign in again.',
  'github.userCode': 'One-time code',
  'github.openAuth': 'Open GitHub authorization page',
  'github.clientIdHint': 'Requires the githubClientId plugin config (the client_id of your GitHub OAuth App).',
  'status.title': 'Sync Status',
  'status.never': 'Never synced',
  // Sync mode (default quick export / advanced custom export)
  'scope.title': 'Sync Scope',
  'scope.hint': 'Push and pull always sync every supported section (settings, providers, plugins, prompts, skills, mcp, credentials, etc.) — no configuration needed.',
  'scope.excludedHint': 'workspaces (contain absolute local paths) and sessions (chat history: large and sensitive) are excluded. Snapshots are plaintext and go only to the private channel you configure.',
  'history.title': 'Sync History',
  'history.empty': 'No sync history yet',
  'history.emptyHint': 'Records appear here after your first push or pull.',
  'history.colTime': 'Time',
  'history.colKind': 'Kind',
  'history.colDetail': 'Detail',
  'history.kindSnapshot': 'Snapshot',
  'history.sectionCount': 'sections',
  'history.column.snapshot': 'Snapshot',
  // Trigger channel (which channel triggered this history entry)
  'history.channelGit': 'GitHub',
  'history.channelWebdav': 'WebDAV',
  // List header stats summary (requirement 4F)
  'history.stats.total': '{count} total',
  'history.stats.snapshots': '{count} snapshots',
  'history.stats.summary': 'Sync history statistics',
  // Toast receipts (R-20: per-action wording; identical kind+text would be de-duplicated)
  'toast.configSaveFailed': 'Failed to save channel config',
  'toast.configSaved': 'Channel config saved',
  'toast.configNothingToSave': 'Enter a channel URL before saving',

  'toast.pushFailed': 'Push failed',
  'toast.pushDone': 'Push completed (snapshot {id}, {count} section(s))',
  'toast.pushWarnings': 'Push completed with {count} section warning(s)',
  'toast.pullFailed': 'Pull failed',
  'toast.pullDone': 'Pull completed (snapshot {id}, {count} section(s) written)',
  'toast.pullEmpty': 'Pull completed: remote snapshot matches local (no changes)',
  'toast.pullWarnings': 'Pull completed with {count} section warning(s)',
  'toast.rollbackDone': 'Overwrite undone — local config restored to its pre-pull state',
  'toast.rollbackPartial': 'Undo partially completed; some items may need manual recovery',
  'toast.rollbackFailed': 'Undo failed',
  'toast.lockRecoverFailed': 'Failed to recover the stale lock',
  'toast.recoveryDismissFailed': 'Failed to remove protection',
  // —— Undo this overwrite (dangerous action inside the pull report: danger + confirm) ——
  'pull.undo': 'Undo this overwrite',
  'rollback.title': 'Undo this overwrite',
  'rollback.body': 'Restores local configuration to the state before this pull (the rollback snapshot taken automatically before applying). This overwrites your current local configuration.',
  'rollback.confirm': 'Confirm undo',
  'rollback.running': 'Undoing…',
  // Page-level load failure (M-16: inline error state; loadError had no render point before)
  'load.failed': 'Failed to load sync status',
  'common.close': 'Close',
  'common.retry': 'Retry',
  'common.loading': 'Loading…',
};

/** 字典键联合（注册处 compile-time 校验） */
export type SyncKey = keyof typeof zh;
