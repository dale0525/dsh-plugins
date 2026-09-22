/**
 * m-sync-ui：远程同步区块渲染模型单测（纯函数，node 可测，无需 DOM）。
 * 覆盖验收：报告渲染（push/pull）、按钮状态、私有仓库提示、状态行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import type { PullChange, SyncPullApplyReport, SyncPushReport } from '../../sync/sync-engine.ts'
import type { SectionId } from '../../schema/types.ts'
import type { GithubPollResponse, SyncSectionInfo, SyncStatusResponse } from './sync-api.ts'
import {
  channelTabModels, computeGithubLoginView, computeRemoteReady, computeSyncButtons, computeSyncStatus,
  defaultChannelSyncState, formatDateTime, formatLastSync, githubPollMessage, kindLabel, privateRepoHint,
  pullApplyReportView, pushReportView, presetById, presetIdForUrl, readStoredChannel, recommendedSyncSections,
  severityLabel, summarizePullChanges, syncSectionGroups, syncSectionOptions, WEBDAV_PRESETS, writeStoredChannel,
} from './sync-view.ts'

/* ---------------------------------------------------------------- 私有仓库提示 */

test('sync-view: 私有仓库强制提示文案存在且强调私有', () => {
  const hint = privateRepoHint()
  assert.match(hint, /私有/)
  assert.match(hint, /public/)
  assert.match(hint, /token/)
})

/* ---------------------------------------------------------------- 同步分区模式（默认/高级） */

const SYNC_CATALOG: SyncSectionInfo[] = [
  { id: 'settings', displayName: 'Settings', defaultIncluded: true },
  { id: 'providers', displayName: 'Providers & Models', defaultIncluded: true },
  { id: 'plugins', displayName: 'Plugins', defaultIncluded: true },
  { id: 'skills', displayName: 'Skills', defaultIncluded: true },
];

test('sync-view: syncSectionOptions 把 host 目录投影为勾选项（保 id 顺序 + 导出目录分组/描述补充）', () => {
  const opts = syncSectionOptions(SYNC_CATALOG)
  assert.deepEqual(opts.map((o) => o.id), ['settings', 'providers', 'plugins', 'skills'])
  assert.equal(opts[0]?.label, 'Settings')
  assert.equal(opts[0]?.defaultIncluded, true)
  // 分组/描述来自导出目录（单一事实源）：settings → general 组带描述；providers → ai 组
  assert.equal(opts[0]?.group, 'general')
  assert.match(opts[0]?.description ?? '', /DSH 全局设置/)
  assert.equal(opts[1]?.group, 'ai')
  assert.match(opts[1]?.description ?? '', /Provider/)
  assert.equal(opts[2]?.group, 'extensions')
  assert.equal(opts[3]?.group, 'customization')
});

test('sync-view: syncSectionOptions 未知分区 id → 兜底（description 空、group=general）', () => {
  const opts = syncSectionOptions([
    { id: 'nope' as SectionId, displayName: 'Nope', defaultIncluded: true },
  ])
  assert.equal(opts[0]?.label, 'Nope')
  assert.equal(opts[0]?.description, '')
  assert.equal(opts[0]?.group, 'general')
});

test('sync-view: syncSectionGroups 按导出分组投影（与「导出备份·自定义模式」同构，空组省略）', () => {
  const groups = syncSectionGroups(syncSectionOptions(SYNC_CATALOG))
  // settings(general) + providers(ai) + plugins(extensions) + skills(customization)
  assert.deepEqual(groups.map((g) => g.group), ['general', 'ai', 'extensions', 'customization'])
  assert.equal(groups[0]?.label, 'General')
  assert.deepEqual(groups[0]?.items.map((i) => i.id), ['settings'])
  assert.deepEqual(groups[2]?.items.map((i) => i.id), ['plugins'])
});

test('sync-view: recommendedSyncSections 只取默认包含的分区（默认模式）', () => {
  const rec = recommendedSyncSections(SYNC_CATALOG)
  assert.deepEqual(rec, ['settings', 'providers', 'plugins', 'skills'])
});

test('sync-view: recommendedSyncSections 排除非默认包含分区', () => {
  const catalog: SyncSectionInfo[] = [
    { id: 'settings', displayName: 'Settings', defaultIncluded: true },
    { id: 'credentialsStatus', displayName: 'Credentials', defaultIncluded: true },
    { id: 'mcp', displayName: 'MCP', defaultIncluded: true },
    { id: 'pluginFiles', displayName: 'Plugin Files', defaultIncluded: false },
  ];
  assert.deepEqual(recommendedSyncSections(catalog), ['settings', 'credentialsStatus', 'mcp'])
});

test('sync-view: 空/缺省目录 → 推荐分区为空数组（UI 显示「至少选一个」场景）', () => {
  assert.deepEqual(recommendedSyncSections([]), [])
  assert.deepEqual(syncSectionOptions([]), [])
});

/* ---------------------------------------------------------------- 按钮状态 */

test('sync-view: 空闲 + 活动通道地址未就绪 → 两个按钮都禁用', () => {
  const b = computeSyncButtons(null, false)
  assert.equal(b.canPush, false)
  assert.equal(b.canPull, false)
  assert.equal(b.pushLabel, '推送（覆盖远端）')
  assert.equal(b.pullLabel, '拉取（覆盖本地）')
})

test('sync-view: 空闲 + 活动通道地址就绪 → 两个按钮可用', () => {
  const b = computeSyncButtons(null, true)
  assert.equal(b.canPush, true)
  assert.equal(b.canPull, true)
})

test('sync-view: push 进行中 → 按钮禁用且文案切换为正在推送（防并发）', () => {
  const b = computeSyncButtons('push', true)
  assert.equal(b.canPush, false)
  assert.equal(b.canPull, false)
  assert.equal(b.pushLabel, '正在推送…')
  assert.equal(b.pullLabel, '拉取（覆盖本地）')
})

test('sync-view: pull 进行中 → 两个按钮都禁用，pull 文案切换', () => {
  const b = computeSyncButtons('pull', true)
  assert.equal(b.canPush, false)
  assert.equal(b.canPull, false)
  assert.equal(b.pullLabel, '正在拉取…')
})

test('sync-view: computeRemoteReady 按活动通道判断地址就绪（git=repoUrl，webdav=url）', () => {
  assert.equal(computeRemoteReady('git', 'https://github.com/u/r.git', ''), true)
  assert.equal(computeRemoteReady('git', '  ', 'https://dav.example.com/dav'), false, 'git 通道不看 webdav 地址')
  assert.equal(computeRemoteReady('webdav', '', 'https://dav.example.com/dav'), true)
  assert.equal(computeRemoteReady('webdav', 'https://github.com/u/r.git', ''), false, 'webdav 通道不看 git 地址')
  assert.equal(computeRemoteReady('webdav', '', '   '), false)
})

/* ---------------------------------------------------------------- 变更摘要 */

function change(overrides: Partial<PullChange>): PullChange {
  return { id: 'x', adapter: 'settings', kind: 'Update', description: 'd', severity: 'info', ...overrides }
}

test('sync-view: summarizePullChanges 按 severity 计数', () => {
  const summary = summarizePullChanges([
    change({ severity: 'info' }),
    change({ severity: 'info' }),
    change({ severity: 'warning' }),
    change({ severity: 'error' }),
  ])
  assert.equal(summary.total, 4)
  assert.equal(summary.info, 2)
  assert.equal(summary.warning, 1)
  assert.equal(summary.error, 1)
  assert.equal(summary.needsReview, false)
})

test('sync-view: summarizePullChanges 对冲突/密钥/依赖项标记 needsReview（安装插件不算）', () => {
  // 插件安装随同步自动采用（product requirement），不标记 needsReview
  const summary = summarizePullChanges([
    change({ kind: 'Conflict' }),
    change({ kind: 'Install' }),
    change({ kind: 'Install' }),
  ])
  assert.equal(summary.needsReview, true)
  // 仅 Install 项 → 不作为需人工决策项
  const onlyInstall = summarizePullChanges([change({ kind: 'Install' })])
  assert.equal(onlyInstall.needsReview, false)
})

test('sync-view: summarizePullChanges 空数组 → total 0 且不需决策', () => {
  const summary = summarizePullChanges([])
  assert.equal(summary.total, 0)
  assert.equal(summary.needsReview, false)
})

test('sync-view: kindLabel / severityLabel 覆盖关键类型', () => {
  assert.equal(kindLabel('Conflict'), '冲突')
  assert.equal(kindLabel('Install'), '安装')
  assert.equal(kindLabel('MissingSecret'), '缺密钥')
  assert.equal(severityLabel('error'), '错误')
  assert.equal(severityLabel('warning'), '警告')
  assert.equal(severityLabel('info'), '信息')
})

/* ---------------------------------------------------------------- push 报告渲染 */

test('sync-view: push 成功报告 → ok 头部含快照 id + 分区透传', () => {
  const report: SyncPushReport = { ok: true, snapshotId: 'sync-1', sections: ['settings', 'plugins'], warnings: [] }
  const view = pushReportView(report)
  assert.notEqual(view, null)
  assert.equal(view?.kind, 'ok')
  assert.match(view?.headline ?? '', /sync-1/)
  assert.deepEqual(view?.sections, ['settings', 'plugins'])
})

test('sync-view: push 失败报告 → error 显示引擎 message', () => {
  const report: SyncPushReport = { ok: false, snapshotId: '', sections: [], warnings: [], message: '全部导出失败' }
  const view = pushReportView(report)
  assert.equal(view?.kind, 'error')
  assert.equal(view?.headline, '全部导出失败')
})

test('sync-view: null 报告 → null（不渲染卡片）', () => {
  assert.equal(pushReportView(null), null)
  assert.equal(pullApplyReportView(null), null)
})

/* ---------------------------------------------------------------- pull 报告渲染 */

/** 拉取结果报告构造（直接覆盖语义）。 */
function pullReport(overrides: Partial<SyncPullApplyReport> = {}): SyncPullApplyReport {
  return {
    ok: true,
    snapshotId: 'sync-1',
    applied: [],
    changes: [],
    restoreId: '',
    rolledBack: false,
    warnings: [],
    failed: [],
    needsRestart: false,
    ...overrides,
  }
}

test('sync-view: pull 未写入任何分区 → empty 渲染', () => {
  const view = pullApplyReportView(pullReport())
  assert.equal(view?.kind, 'empty')
  assert.equal(view?.summary, null)
  assert.deepEqual(view?.applied, [])
})

test('sync-view: pull 覆盖成功 → ok + 写入分区 + 变更摘要 + 回滚入口提示', () => {
  const report = pullReport({
    snapshotId: 'sync-9',
    applied: ['settings', 'plugins'],
    restoreId: 'restore-42',
    changes: [
      change({ id: 'settings:a', kind: 'Update', description: '更新设置 a', severity: 'info' }),
      change({ id: 'plugin:x', kind: 'Conflict', adapter: 'plugins', description: '插件 x 冲突', severity: 'warning' }),
    ],
  })
  const view = pullApplyReportView(report)
  assert.equal(view?.kind, 'ok')
  assert.match(view?.headline ?? '', /sync-9/)
  assert.deepEqual(view?.applied, ['settings', 'plugins'])
  assert.equal(view?.summary?.total, 2)
  assert.equal(view?.summary?.items[0]?.description, '更新设置 a')
  assert.equal(view?.summary?.items[1]?.kind, 'Conflict')
  assert.notEqual(view?.restoreHint, '', 'restoreId 非空 → 给出回滚入口提示')
})

test('sync-view: pull 失败 → error 渲染（含是否已整体回滚）', () => {
  const view = pullApplyReportView(pullReport({ ok: false, message: '认证失败', rolledBack: true }))
  assert.equal(view?.kind, 'error')
  assert.equal(view?.headline, '认证失败')
  assert.equal(view?.rolledBack, true)
})

/* ---------------------------------------------------------------- 状态行 */

test('sync-view: 加载中 → loading 状态', () => {
  const s = computeSyncStatus(null, true, null)
  assert.equal(s.kind, 'loading')
})

test('sync-view: 加载失败 → error 状态带消息', () => {
  const s = computeSyncStatus(null, false, '网络错误')
  assert.equal(s.kind, 'error')
  assert.equal(s.text, '网络错误')
})

test('sync-view: 未配置仓库 → unconfigured 提示', () => {
  const s = computeSyncStatus(null, false, null)
  assert.equal(s.kind, 'unconfigured')
  assert.match(s.text, /尚未配置/)
})

test('sync-view: 已配置但缺凭据 → ready 文案提示未配置凭据', () => {
  const info: SyncStatusResponse = {
    ok: true, configured: true, repoUrl: 'https://github.com/u/r.git',
    credentialConfigured: false, credentialWritable: true, lastSyncAt: undefined, sectionCount: 0,
  }
  const s = computeSyncStatus(info, false, null)
  assert.equal(s.kind, 'ready')
  assert.match(s.text, /未配置凭据/)
})

test('sync-view: 已配置 + 凭据就绪 + 上次同步 → ready 文案含日期与通道', () => {
  const info: SyncStatusResponse = {
    ok: true, configured: true, repoUrl: 'https://github.com/u/r.git',
    credentialConfigured: true, credentialWritable: true,
    lastSyncAt: '2026-08-16T10:30:00.000Z', sectionCount: 3,
    transport: { type: 'git', ref: 'main' },
  }
  const s = computeSyncStatus(info, false, null)
  assert.equal(s.kind, 'ready')
  assert.match(s.text, /凭据已配置/)
  assert.match(s.text, /上次同步/)
  assert.match(s.text, /git\/main/)
})

test('sync-view: webdav 通道 → ready 文案回显通道类型（webdav + 服务器地址 ref）', () => {
  const info: SyncStatusResponse = {
    ok: true, configured: true, repoUrl: undefined,
    credentialConfigured: false, credentialWritable: true,
    webdav: { url: 'https://dav.example.com/dav/config', usernameConfigured: true, passwordConfigured: true },
    lastSyncAt: '2026-08-16T10:30:00.000Z', sectionCount: 2,
    transport: { type: 'webdav', ref: 'https://dav.example.com/dav/config' },
  }
  const s = computeSyncStatus(info, false, null)
  assert.equal(s.kind, 'ready')
  assert.match(s.text, /凭据已配置/)
  assert.match(s.text, /webdav/)
  assert.match(s.text, /https:\/\/dav\.example\.com\/dav\/config/)
})

/* ---------------------------------------------------------------- 时间格式化 */

test('sync-view: formatLastSync 空值 → 从未同步', () => {
  assert.equal(formatLastSync(undefined), '从未同步')
  assert.equal(formatLastSync(''), '从未同步')
})

test('sync-view: formatLastSync / formatDateTime 合法 ISO → 本地可读格式', () => {
  const text = formatLastSync('2026-08-16T10:30:00.000Z')
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(formatDateTime('not-a-date'), 'not-a-date')
})

/* ------------------------------------------------ GitHub 登录视图模型 */

test('sync-view: github 登录 idle → 可开始、不展示代码区块、无错误', () => {
  const v = computeGithubLoginView('idle', '', '', null)
  assert.equal(v.phase, 'idle')
  assert.equal(v.canStart, true)
  assert.equal(v.canCancel, false)
  assert.equal(v.showCode, false)
  assert.match(v.startLabel, /GitHub/)
})

test('sync-view: github 登录 starting → 不可重复发起、显示进行中文案', () => {
  const v = computeGithubLoginView('starting', '', '', null)
  assert.equal(v.canStart, false)
  assert.equal(v.canCancel, true)
  assert.match(v.statusText, /发起/)
})

test('sync-view: github 登录 waiting → 展示设备码与授权链接、可取消', () => {
  const v = computeGithubLoginView('waiting', 'ABCD-EFGH', 'https://github.com/login/device', null)
  assert.equal(v.showCode, true)
  assert.equal(v.canCancel, true)
  assert.equal(v.userCode, 'ABCD-EFGH')
  assert.equal(v.verificationUri, 'https://github.com/login/device')
  assert.match(v.statusText, /ABCD-EFGH/)
})

test('sync-view: github 登录 polling → 仍展示代码区块且可取消', () => {
  const v = computeGithubLoginView('polling', 'ABCD-EFGH', 'https://github.com/login/device', null)
  assert.equal(v.showCode, true)
  assert.equal(v.canCancel, true)
  assert.equal(v.canStart, false)
  assert.match(v.statusText, /确认 GitHub 授权状态/)
})

test('sync-view: github 登录 success → 成功文案、代码区块隐藏', () => {
  const v = computeGithubLoginView('success', 'ABCD-EFGH', 'https://github.com/login/device', null)
  assert.equal(v.showCode, false)
  assert.equal(v.canStart, false)
  assert.match(v.statusText, /已安全写入/)
})

test('sync-view: github 登录 error → 展示错误 + 重新登录入口', () => {
  const v = computeGithubLoginView('error', '', '', '授权被拒绝')
  assert.equal(v.canStart, true)
  assert.equal(v.canCancel, false)
  assert.equal(v.error, '授权被拒绝')
  assert.match(v.statusText, /授权被拒绝/)
  assert.match(v.startLabel, /重新登录/)
})

test('sync-view: githubPollMessage 映射轮询终止态（denied/expired/error/success）', () => {
  const denied: GithubPollResponse = { status: 'denied' }
  assert.match(githubPollMessage(denied), /拒绝/)
  const expired: GithubPollResponse = { status: 'expired' }
  assert.match(githubPollMessage(expired), /过期/)
  const error: GithubPollResponse = { status: 'error', errorCode: 'incorrect_device_code', message: '设备码不匹配' }
  assert.match(githubPollMessage(error), /设备码不匹配/)
  const success: GithubPollResponse = { status: 'success', credentialConfigured: true }
  assert.match(githubPollMessage(success), /已安全写入/)
  const pending: GithubPollResponse = { status: 'pending', pollDelayMs: 5000 }
  assert.equal(githubPollMessage(pending), '', 'pending 不是终止态，不应产生消息')
})

/* ---------------------------------------------------------------- WebDAV 预设 */

test('sync-view: WEBDAV_PRESETS 含自定义与 6 个常见服务器,首项为自定义', () => {
  assert.equal(WEBDAV_PRESETS[0]?.id, 'custom')
  assert.ok(WEBDAV_PRESETS.length >= 6)
  const ids = WEBDAV_PRESETS.map((p) => p.id)
  assert.ok(ids.includes('jianguoyun'))
  assert.ok(ids.includes('nextcloud'))
  assert.ok(ids.includes('box'))
})

test('sync-view: presetById 已知 id → 对应预设；未知 → 自定义兜底', () => {
  assert.equal(presetById('jianguoyun').url, 'https://dav.jianguoyun.com/dav/')
  assert.equal(presetById('nextcloud').url, 'https://<server>/remote.php/dav/files/<user>/')
  assert.equal(presetById('unknown-xyz').id, 'custom', '未知 id 回退自定义')
})

test('sync-view: presetIdForUrl 空/自定义 → custom；匹配常见前缀 → 对应预设', () => {
  assert.equal(presetIdForUrl(''), 'custom')
  assert.equal(presetIdForUrl('https://anything.example/x'), 'custom')
  assert.equal(presetIdForUrl('https://dav.jianguoyun.com/dav/'), 'jianguoyun')
  assert.equal(presetIdForUrl('https://dav.box.com/dav/my-config/'), 'box')
})

/* ---------------------------------------------------------------- 通道选择持久化 */

/** 内存 mock storage（node 无 localStorage） */
function makeStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v) },
  }
}

test('sync-view: readStoredChannel 无值/非法 → null；git/webdav → 对应通道', () => {
  const s = makeStorage()
  assert.equal(readStoredChannel(s), null, '无记录 → null')
  s.setItem('dsh.configManager.syncChannel', 'webdav')
  assert.equal(readStoredChannel(s), 'webdav')
  s.setItem('dsh.configManager.syncChannel', 'git')
  assert.equal(readStoredChannel(s), 'git')
  s.setItem('dsh.configManager.syncChannel', 'garbage')
  assert.equal(readStoredChannel(s), null, '非法值 → null')
})

test('sync-view: writeStoredChannel 写回 localStorage,可被 readStoredChannel 读回', () => {
  const s = makeStorage()
  writeStoredChannel('webdav', s)
  assert.equal(readStoredChannel(s), 'webdav')
  writeStoredChannel('git', s)
  assert.equal(readStoredChannel(s), 'git')
})

/* ---------------------------------------------------------------- 通道子 tab（每通道独立） */

test('sync-view: channelTabModels git 激活 → git active / webdav 未激活；busy 全禁用', () => {
  const tabs = channelTabModels('git', false)
  assert.equal(tabs.length, 2)
  assert.deepEqual(tabs[0], { channel: 'git', active: true, disabled: false })
  assert.deepEqual(tabs[1], { channel: 'webdav', active: false, disabled: false })
  const busy = channelTabModels('webdav', true)
  assert.equal(busy[0]?.active, false)
  assert.equal(busy[1]?.active, true)
  assert.ok(busy.every((b) => b.disabled), 'busy 时两个子 tab 都禁用（防并发操作切换）')
})

test('sync-view: defaultChannelSyncState 每通道独立缺省值', () => {
  const git = defaultChannelSyncState()
  assert.equal(git.syncMode, 'default')
  assert.deepEqual(git.syncSections, [])
  // 两通道缺省互不影响（同一默认工厂，调用即得独立实例）
  const webdav = defaultChannelSyncState()
  webdav.syncMode = 'advanced'
  assert.equal(git.syncMode, 'default', '修改一个通道缺省不影响另一个')
})
