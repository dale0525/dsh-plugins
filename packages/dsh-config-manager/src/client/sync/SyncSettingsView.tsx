/**
 * 远程同步面板（设置页唯一页面）。
 *
 * 独立设置页壳（sectionHeader/close/自身 tab）与顶部导航条均已移除 ——
 * ConfigManagerSection 只输出本组件的内容体，本组件也只输出内容体：
 * - **同步通道入口卡**：展示当前通道 + 配置状态 + 凭据徽章；点「配置同步通道」
 *   → 弹出**通道配置弹窗**（弹窗体系与市场操作弹窗一致，DESIGN.md §8.12：
 *   dialogMask + dialogCard dialogWide + dialogHeaderRow + dialogClose +
 *   dialogBodyScroll，零新增样式）；
 * - **通道配置弹窗**：通道子 tab（GitHub（git）/ WebDAV）切换，两个通道的
 *   配置表单**各自独立**；关闭弹窗
 *   = 放弃本次操作（GitHub 登录流程进行中则一并取消，§8.12 约定）；
 * - GitHub 子 tab：repoUrl（必填）+ 认证 token（可选，写入 DSH credentials 的提示）
 *   + **GitHub OAuth device flow 登录**（登录块跟随 git 通道配置放在弹窗内：
 *   未登录/失效时显示；git 可执行文件固定使用系统 PATH 中的 git）；
 * - WebDAV 子 tab：url + username + password（密码写入 DSH credentials）+ 常见服务器预设；
 * - 私有仓库强制提示横幅（仅 git 子 tab 常驻）；
 * - **两个同步按钮**：拉取（直接覆盖本地，应用前落回滚快照）/ 推送（直接覆盖远端）；
 *   两者都不弹确认：勾选即同步是本插件的产品语义；
 * - 状态行：凭据配置 + 上次同步时间 + 通道（来自 GET /sync/status，组件挂载时加载）。
 *
 * 全部渲染模型来自 ./sync-view.ts 纯函数（node 单测覆盖），组件只做装配；
 * 状态组件内自持（useState），同时经 toSyncStoreSlice() 镜像进模块级 runStore：
 * 模块级单例保证「切 tab 不丢」，sessionStorage 白名单保证「刷新恢复」；
 * token/webdav 密码仅内存（state），成功后清空（已写入 DSH
 * credentials），持久化白名单硬性剔除（含 byChannel 内密码类字段），刷新后
 * 清空、需要时重新输入。
 */
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { SyncPullApplyReport, SyncPushReport } from '../../sync/sync-engine.ts'
import type { UiT } from '../../ui/i18n.ts'
import type { SectionId } from '../../schema/types.ts'
import { Badge, Banner, Button, Card, Checkbox, SectionTitle, Spinner } from '../common/ui.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import { toast } from '../common/toast-store.ts'
import { redact } from '../../security/redaction.ts'
import { Modal } from '../common/Modal.tsx'
import { runStore, toSyncStoreSlice, type SyncStoreSlice } from '../run-store.ts'
import { SYNC_CREDENTIAL_REF, SYNC_WEBDAV_CREDENTIAL_REF } from './sync-api.ts'
import type {
  SyncApi, SyncPushPayload, SyncStatusResponse,
} from './sync-api.ts'
import {
  channelTabModels, computeGithubLoginView, computeRemoteReady, computeSyncButtons,
  githubPollMessage, kindLabel, lockPanelModel, presetById,
  presetIdForUrl, privateRepoHint, pullApplyReportView, pushReportView, readStoredChannel,
  severityLabel, WEBDAV_PRESETS, writeStoredChannel,
} from './sync-view.ts'
import type {
  GithubLoginPhase, SyncChannel,
} from './sync-view.ts'
import { SyncHistoryView } from './SyncHistoryView.tsx'
import css from '../config-manager.module.css'

export interface SyncSettingsViewProps {
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
}

interface SyncUiState {
  loading: boolean
  loadError: string | null
  statusInfo: SyncStatusResponse | null
  /** 当前激活通道子 tab（git 默认；webdav 切换显示 WebDAV 表单） */
  channel: SyncChannel
  /** git 通道表单 */
  repoUrl: string
  /** 仅内存：成功后清空（已写入 DSH credentials），绝不持久化 */
  token: string
  /** webdav 通道表单 */
  webdavUrl: string
  webdavUsername: string
  /** 仅内存：成功后清空（已写入 DSH credentials），绝不持久化/回显 */
  webdavPassword: string
  /** 通道配置保存中（「保存配置」按钮 spinner；自动保存同用） */
  savingConfig: boolean
  busy: 'push' | 'pull' | 'rollback' | null
  pushReport: SyncPushReport | null
  pullReport: SyncPullApplyReport | null
  /** 最近一次拉取执行的回滚快照 id（回滚入口；成功且实际写入时非空） */
  lastRestoreId: string | null
  /**
   * 动作失败文案（R-20 后**不再作为展示通道**）。
   * 保留该字段仅因 run-store 的 SyncStoreSlice 结构契约要求（toSyncStoreSlice 读取它，
   * 而 run-store.ts 不在本任务改动范围）；失败反馈已全部改走 Toast（见下方各 catch 分支），
   * 因此不再写入消息，页面也没有对应渲染点。
   */
  error: string | null
  /** GitHub OAuth device flow 状态（flowId/userCode 仅内存，token 只存宿主） */
  github: GithubUiState
  /**
   * GitHub token 是否有效（「已登录」判定：token 存在且 GitHub API 接受）。
   * null = 尚未校验（不显示登录块，避免已登录用户看到闪烁）；true = 已登录
   * （隐藏 GitHub 登录块）；false = 未配置或已失效（显示登录块）。
   * 仅内存瞬态（不进 store 切片）：切 tab/刷新后重新校验，保证新鲜。
   */
  githubSignedIn: boolean | null
  /** 「回收残留锁」请求在途（防重入；瞬态，不进 store 切片） */
  recovering: boolean
}

interface GithubUiState {
  phase: GithubLoginPhase
  flowId: string
  userCode: string
  verificationUri: string
  /** GitHub 建议轮询间隔秒数（pending 重排时兜底用） */
  interval: number
  error: string | null
}

const initialGithub: GithubUiState = {
  phase: 'idle', flowId: '', userCode: '', verificationUri: '', interval: 5, error: null,
}

const initial: SyncUiState = {
  loading: true,
  loadError: null,
  statusInfo: null,
  // 用户最近选择的通道优先（localStorage 记住）；无则缺省 git，由 loadStatus 按配置回填
  channel: readStoredChannel() ?? 'git',
  repoUrl: '',
  token: '',
  webdavUrl: '',
  webdavUsername: '',
  webdavPassword: '',
  savingConfig: false,
  busy: null,
  pushReport: null,
  pullReport: null,
  lastRestoreId: null,
  error: null,
  github: initialGithub,
  githubSignedIn: null,
  recovering: false,
}

/**
 * 从 runStore 恢复上次的同步 UI 状态（切 tab 回 / 刷新后挂载）。
 * 敏感字段（token/webdav 密码）只在内存切片里保留：切 tab 保留；
 * 刷新后已被持久化白名单清空（applyPersisted 强制归零）→ 需要时重新输入。
 * busy/savingConfig 为瞬态：切 tab 由模块级单例保留（切回仍显示进行中）；
 * 刷新后白名单剔除 → 回复空闲。
 */
function initFromStore(): SyncUiState {
  const s: SyncStoreSlice = runStore.getSnapshot().sync
  return {
    ...initial,
    // 通道：store 切片缺省为 'git'，无法区分「持久化过 git」与「从未持久化」；
    // 无明确记录（== 'git'）时回退 localStorage 记住的选择（initial.channel），
    // 避免升级后把用户此前记住的 webdav 通道冲掉
    channel: s.channel !== 'git' ? s.channel : initial.channel,
    repoUrl: s.repoUrl,
    token: s.token,
    webdavUrl: s.webdavUrl,
    webdavUsername: s.webdavUsername,
    webdavPassword: s.webdavPassword,
    busy: s.busy,
    savingConfig: s.savingConfig,
    pushReport: s.pushReport,
    pullReport: s.pullReport,
    lastRestoreId: s.lastRestoreId,
    error: s.error,
    loadError: s.loadError,
  }
}

export function SyncSettingsView({ api, t }: SyncSettingsViewProps) {
  const [state, setState] = useState<SyncUiState>(initFromStore)
  const uiT = api.t // 客户端展示层翻译器（zh/en，见 ui/i18n.ts）
  /** 最新 state 镜像（commit/自动保存 flush 读取，避免闭包过期值） */
  const stateRef = useRef<SyncUiState>(state)
  /** 挂载守卫：卸载后不再 setState（store 镜像仍执行，异步结果照常落库） */
  const mountedRef = useRef(true)
  /** 通道配置弹窗开关（瞬态 UI：切 tab/刷新不持久化，弹窗不自动重开；DESIGN.md §8.12 约定） */
  const [channelOpen, setChannelOpen] = useState(false)
  /** 撤销本次覆盖的二次确认弹窗（DESIGN.md §6：回滚属危险操作，恒 danger + 二次确认） */
  const [rollbackOpen, setRollbackOpen] = useState(false)

  /**
   * 统一提交入口：更新 stateRef → 挂载时 setState → **总是**镜像进 runStore。
   * 关键：镜像不依赖 effect flush —— 异步操作（push/pull/sync）完成回调在组件
   * 已卸载（切走 tab）时也能把结果写进 store，切回 tab 时 initFromStore 恢复。
   */
  const commit = (next: SyncUiState): void => {
    stateRef.current = next
    if (mountedRef.current) setState(next)
    runStore.patch({ sync: toSyncStoreSlice(next) })
  }
  const patch = (p: Partial<SyncUiState>): void => commit({ ...stateRef.current, ...p })
  /** GitHub 流程态（不进 store 切片；commit 的镜像写幂等无害）。 */
  const patchGithub = (p: Partial<GithubUiState>): void => commit({
    ...stateRef.current,
    github: { ...stateRef.current.github, ...p },
  })
  /** GitHub 轮询定时器（卸载/取消时清理，防止泄漏与跨流程串扰） */
  const githubPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 通道配置自动保存：防抖 timer + 待发 payload（关闭设置页前 flush，不丢输入） */
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSave = useRef<SyncPushPayload | null>(null)
  /** 保存请求在途（防重入：保存中又排入新改动 → 完成后补发最新 payload） */
  const savingRef = useRef(false)
  /** 挂载时读取同步状态（配置回填 + 上次同步时间 + 凭据状态 + 两通道 selection） */
  const loadStatus = async (): Promise<void> => {
    patch({ loading: true, loadError: null })
    try {
      const info = await api.status()
      // 通道回填：优先磁盘持久化的选择（status.lastSyncChannel，ui-prefs.json）；未记录过则
      // 回退 localStorage 记忆（升级前遗留）→ 最后按配置（sync-config.transport）
      const savedChannel: SyncChannel = info.transport?.type === 'webdav' ? 'webdav' : 'git'
      const remembered = info.lastSyncChannel ?? readStoredChannel()
      patch({
        loading: false,
        statusInfo: info,
        channel: remembered ?? savedChannel,
        repoUrl: info.repoUrl ?? '',
        webdavUrl: info.webdav?.url ?? '',
        webdavUsername: info.webdav?.username ?? '',
      })
      // 校验 GitHub token 有效性：已登录（有效）→ 隐藏 GitHub 登录块；未配置/失效 → 显示
      void validateGithub()
    } catch (err) {
      patch({ loading: false, loadError: err instanceof Error ? err.message : String(err) })
    }
  }

  useEffect(() => {
    void loadStatus()
    // api 为注入单例（注册时创建），生命周期内稳定；仅挂载时加载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 卸载时置挂载守卫 + 清理轮询定时器 + 补发未落盘的通道配置改动 + 最后镜像一次状态
   *  （组件销毁后不得再 setState/发请求；store 镜像为纯内存/白名单写，安全）。
   *  异步操作完成回调仍会走 commit 写 store（见 commit 注释），结果不丢。 */
  useEffect(() => () => {
    mountedRef.current = false
    if (githubPollTimer.current !== null) clearTimeout(githubPollTimer.current)
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    // 关闭设置页前若还有未保存的改动：立即补发（host 侧落盘；此路径只发请求不 setState）
    const pending = pendingSave.current
    if (pending !== null) {
      void api.saveConfig(pending).catch(() => { /* 已卸载：静默，不打扰用户 */ })
    }
    // 最后镜像一次（防止「最后一次改动后立即切 tab」时 commit 之前的瞬态丢失）
    runStore.patch({ sync: toSyncStoreSlice(stateRef.current) })
  }, [])

  /** 表单快照 → 请求体（按当前通道构建；空串不携带；password 仅内存不发回显） */
  const payload = (): SyncPushPayload => {
    if (state.channel === 'webdav') {
      return {
        transport: 'webdav',
        url: state.webdavUrl.trim() !== '' ? state.webdavUrl.trim() : undefined,
        username: state.webdavUsername.trim() !== '' ? state.webdavUsername.trim() : undefined,
        password: state.webdavPassword !== '' ? state.webdavPassword : undefined,
      }
    }
    return {
      transport: 'git',
      repoUrl: state.repoUrl.trim(),
      token: state.token.trim() !== '' ? state.token : undefined,
    }
  }

  /* ------------------------------------------------ 通道配置持久化（自动保存 + 显式保存） */

  /** 按给定 state 构建「保存配置」请求体；当前通道远端地址未就绪（webdav url / git repoUrl 为空）
   *  → 返回 null（无可保存内容，自动保存跳过）。password/token 仅非空携带（空 = 沿用已保存凭据）。 */
  const buildConfigPayload = (s: SyncUiState): SyncPushPayload | null => {
    if (s.channel === 'webdav') {
      const url = s.webdavUrl.trim()
      if (url === '') return null
      return {
        transport: 'webdav',
        url,
        username: s.webdavUsername.trim() !== '' ? s.webdavUsername.trim() : undefined,
        password: s.webdavPassword !== '' ? s.webdavPassword : undefined,
      }
    }
    const repoUrl = s.repoUrl.trim()
    if (repoUrl === '') return null
    return {
      transport: 'git',
      repoUrl,
      token: s.token.trim() !== '' ? s.token.trim() : undefined,
    }
  }

  /** 实际发送保存请求：成功清空已入库的 password/token（与 push 一致）并刷新凭据徽章；
   *  失败保留表单值以便重试。防重入：保存中又排入新改动 → 完成后自动补发最新 payload。
   *  announce：仅「手动点保存」为 true —— 自动保存（输入防抖）成功时不弹 Toast，
   *  否则每次停顿改字段都会刷一条通知；但**失败必须始终提示**（用户的改动没落盘）。 */
  const doSaveConfig = async (payloadToSave: SyncPushPayload, announce = false): Promise<void> => {
    if (savingRef.current) {
      pendingSave.current = payloadToSave
      return
    }
    savingRef.current = true
    patch({ savingConfig: true })
    try {
      const saved = await api.saveConfig(payloadToSave)
      // 基于 stateRef 计算（同步权威），经 commit 落库：即使保存完成时组件已卸载
      // （切走 tab），savingConfig 复位与凭据清空仍会镜像进 store，切回后一致
      const s = stateRef.current
      const next: SyncUiState = { ...s, savingConfig: false }
      // 只清空「本次已写入的」password/token：若保存期间用户已改输入则保留新值
      next.webdavPassword = s.webdavPassword !== '' && s.webdavPassword !== payloadToSave.password
        ? s.webdavPassword
        : ''
      next.token = s.token !== '' && s.token !== payloadToSave.token ? s.token : ''
      // 凭据徽章合并（响应只含布尔，无 secret 值）
      if (s.statusInfo !== null) {
        const info: SyncStatusResponse = {
          ...s.statusInfo,
          configured: true,
          credentialConfigured: saved.credentialConfigured,
        }
        if (saved.webdav !== undefined) {
          info.webdav = {
            url: s.statusInfo.webdav?.url,
            username: s.statusInfo.webdav?.username,
            usernameConfigured: saved.webdav.usernameConfigured,
            passwordConfigured: saved.webdav.passwordConfigured,
          }
        }
        next.statusInfo = info
      }
      commit(next)
      // M-17：手动保存成功给出回执（自动保存静默，避免输入防抖刷屏）
      if (announce) toast.ok(t('toast.configSaved'))
      // 手动填入的 git token 保存成功 → 校验有效性（有效则隐藏 GitHub 登录块）
      if (payloadToSave.transport !== 'webdav' && saved.credentialConfigured) {
        void validateGithub()
      }
    } catch (err) {
      // R-20：保存失败**始终**提示（无论手动还是自动）——用户的改动没有落盘
      toast.error(`${t('toast.configSaveFailed')}：${redact(err instanceof Error ? err.message : String(err))}`)
      patch({ savingConfig: false })
    } finally {
      savingRef.current = false
      // 保存期间又排入的新改动 → 立即补发（保底，不丢输入）
      if (pendingSave.current !== null) {
        const p = pendingSave.current
        pendingSave.current = null
        void doSaveConfig(p, announce)
      }
    }
  }

  /** 表单改动 → 防抖 600ms 自动保存（取最新 state；地址未就绪时跳过）。 */
  const scheduleConfigSave = (): void => {
    const payloadToSave = buildConfigPayload(stateRef.current)
    pendingSave.current = payloadToSave
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    if (payloadToSave === null) {
      saveTimer.current = null
      return
    }
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      flushConfigSave()
    }, 600)
  }

  /** 立即保存（「保存配置」按钮 / 防抖到点）：优先待发改动，否则按当前表单值。
   *  announce：仅手动点按钮为 true —— 自动保存成功不弹回执（见 doSaveConfig）。 */
  const flushConfigSave = (announce = false): void => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const pending = pendingSave.current
    pendingSave.current = null
    const payloadToSave = pending ?? buildConfigPayload(stateRef.current)
    if (payloadToSave === null) {
      // M-17：手动点保存但地址未填写 → 此前直接 return（按钮看起来无反应），现给出明确提示
      if (announce) toast.info(t('toast.configNothingToSave'))
      return
    }
    void doSaveConfig(payloadToSave, announce)
  }

  /* ------------------------------------------------ GitHub OAuth device flow */

  /** 发起 GitHub 登录：取设备码 → 展示一次性用户码 + 授权页 → 开始轮询 */
  const runGithubStart = async (): Promise<void> => {
    patchGithub({ phase: 'starting', error: null })
    try {
      const info = await api.githubStart()
      patchGithub({
        phase: 'waiting',
        flowId: info.flowId,
        userCode: info.userCode,
        verificationUri: info.verificationUri,
        interval: info.interval,
      })
      scheduleGithubPoll(info.flowId, Math.max(info.interval, 1) * 1000)
    } catch (err) {
      patchGithub({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 排定一次 GitHub 轮询（先清旧定时器，避免重复轮询） */
  const scheduleGithubPoll = (flowId: string, delayMs: number): void => {
    if (githubPollTimer.current !== null) clearTimeout(githubPollTimer.current)
    githubPollTimer.current = setTimeout(() => { void runGithubPoll(flowId) }, delayMs)
  }

  /** 轮询 GitHub 授权结果：pending 继续等；success 刷新凭据状态；终止态展示结果 */
  const runGithubPoll = async (flowId: string): Promise<void> => {
    patchGithub({ phase: 'polling' })
    try {
      const poll = await api.githubPoll(flowId)
      if (poll.status === 'pending') {
        patchGithub({ phase: 'waiting' })
        scheduleGithubPoll(flowId, poll.pollDelayMs ?? Math.max(state.github.interval, 1) * 1000)
        return
      }
      const message = githubPollMessage(poll, uiT)
      if (poll.status === 'success') {
        // token 已由宿主写入 DSH credentials：标记已登录（隐藏登录块）+ 刷新状态/凭据徽章
        patch({ githubSignedIn: true, github: { ...stateRef.current.github, phase: 'success', error: null } })
        void loadStatus()
      } else {
        patchGithub({ phase: 'error', error: message })
      }
    } catch (err) {
      patchGithub({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 取消登录：停轮询 + 通知宿主丢弃设备码登记 + 复位 UI */
  const runGithubCancel = async (): Promise<void> => {
    if (githubPollTimer.current !== null) {
      clearTimeout(githubPollTimer.current)
      githubPollTimer.current = null
    }
    const flowId = state.github.flowId
    patchGithub(initialGithub)
    if (flowId !== '') {
      try { await api.githubCancel(flowId) } catch { /* 取消失败无需打扰用户 */ }
    }
  }

  /**
   * 校验 GitHub token 是否有效（「已登录」判定 → 决定登录块显隐）。
   * 挂载 / 登录成功 / 保存凭据后调用；已确认登录（githubSignedIn===true）时跳过
   * （避免反复网络调用）。401 → 未登录：显示登录块并提示重新登录；网络等其余
   * 错误 → 保持现状（不误判登出，已登录用户不被打扰；下次进入页面会再校验）。
   */
  const validateGithub = async (): Promise<void> => {
    if (stateRef.current.githubSignedIn === true) return
    try {
      const res = await api.githubValidate()
      patch({ githubSignedIn: res.configured && res.valid })
    } catch {
      // 校验失败（网络/限流等）：不可知 → 维持现状（null 隐藏 / 既有值不变）
    }
  }

  /* ------------------------------------------------ 通道配置弹窗（弹窗驱动，DESIGN.md §8.12 同体系） */

  /** 打开通道配置弹窗：登录态尚未校验时补一次校验（决定 Git 子 tab 登录块显隐）。 */
  const openChannelDialog = (): void => {
    setChannelOpen(true)
    if (stateRef.current.githubSignedIn === null) void validateGithub()
  }

  /**
   * 关闭通道配置弹窗 = 放弃本次操作（§8.12 约定）：GitHub 登录流程进行中则取消
   * （停轮询 + 通知宿主丢弃设备码登记），保存中（savingConfig）时禁止关闭。
   */
  const closeChannelDialog = (): void => {
    if (stateRef.current.savingConfig) return
    const phase = stateRef.current.github.phase
    if (phase === 'starting' || phase === 'waiting' || phase === 'polling') {
      void runGithubCancel()
    }
    setChannelOpen(false)
  }

  /** 组装 push 的公共载荷（分区选择；快照恒为明文） */
  // 推送范围由 Host 固定（除 workspaces / sessions 外的全部分区），请求体不再携带分区选择。
  const buildPushPayload = (): SyncPushPayload => payload()

  /** 推送：直接覆盖远端（无预览、无确认）。 */
  const runPush = async (): Promise<void> => {
    patch({ busy: 'push', pushReport: null, pullReport: null })
    try {
      const report = await api.push(buildPushPayload())
      // 成功即清空 token/webdavPassword（已安全使用完；绝不持久化）；失败保留以便重试
      patch({
        busy: null, pushReport: report,
        ...(report.ok ? { token: '', webdavPassword: '' } : {}),
      })
      if (report.ok) {
        toast.ok(t('toast.pushDone'))
      } else {
        // 失败保留结果弹窗（含告警明细）；同时给出不依赖弹窗的回执
        toast.error(t('toast.pushFailed'))
      }
    } catch (err) {
      patch({ busy: null })
      toast.error(`${t('toast.pushFailed')}：${redact(err instanceof Error ? err.message : String(err))}`)
    }
  }

  /** 拉取：直接覆盖本地（宿主应用前已落回滚快照；失败整体回滚）。 */
  const runPull = async (): Promise<void> => {
    patch({ busy: 'pull', pullReport: null, pushReport: null })
    try {
      const report = await api.pull({ ...payload() })
      patch({
        busy: null, pullReport: report, token: '', webdavPassword: '',
        lastRestoreId: report.restoreId !== '' ? report.restoreId : null,
      })
      if (report.ok) toast.ok(t('toast.pullDone'))
      else toast.error(t('toast.pullFailed'))
    } catch (err) {
      patch({ busy: null })
      toast.error(`${t('toast.pullFailed')}：${redact(err instanceof Error ? err.message : String(err))}`)
    }
  }

  /**
   * 撤销本次覆盖：用拉取前落下的回滚快照（lastRestoreId）恢复本地。
   * 危险操作 —— 入口在拉取结果弹窗内，先经二次确认弹窗（DESIGN.md §6）。
   */
  const runRollback = async (): Promise<void> => {
    const restoreId = stateRef.current.lastRestoreId
    if (restoreId === null) return
    setRollbackOpen(false)
    patch({ busy: 'rollback' })
    try {
      const report = await api.rollback({ restoreId })
      // 已恢复 → 快照消费完毕，入口关闭（避免对同一快照重复撤销）
      patch({ busy: null, pullReport: null, lastRestoreId: null })
      if (report.full) toast.ok(t('toast.rollbackDone'))
      else toast.warn(t('toast.rollbackPartial'))
    } catch (err) {
      patch({ busy: null })
      toast.error(`${t('toast.rollbackFailed')}：${redact(err instanceof Error ? err.message : String(err))}`)
    }
  }

  /* ------------------------------------------------ 残留环境锁（issue #27/#31） */

  /**
   * 显式回收 stale 残留锁。Host 侧刻意不经 mutation gate（要回收的正是挡住 acquire 的那把锁），
   * 且活锁/无法证明 stale 一律拒绝 —— 故 ok=false 是**正常结果**，如实提示而非报成功。
   * 成功后重拉 status：锁摘要由 Host 计算，UI 不自造结论。
   */
  const recoverStaleLock = async (): Promise<void> => {
    if (stateRef.current.recovering) return
    patch({ recovering: true })
    try {
      const res = await api.recoverStaleLock()
      if (res.ok) toast.ok(uiT('sync.lock.recovered'))
      else toast.warn(res.reason !== undefined ? `${uiT('sync.lock.refused')}（${redact(res.reason)}）` : uiT('sync.lock.refused'))
      await loadStatus()
    } catch (err) {
      toast.error(`${t('toast.lockRecoverFailed')}：${redact(err instanceof Error ? err.message : String(err))}`)
    } finally {
      patch({ recovering: false })
    }
  }

  /* ------------------------------------------------ 通道子 tab 切换 */

  /** 切换通道子 tab：记录偏好。busy 时禁用切换（防并发操作）。 */
  const switchChannel = (ch: SyncChannel): void => {
    if (ch === state.channel || state.busy !== null) return
    patch({ channel: ch })
    writeStoredChannel(ch) // 同步写 localStorage 立即生效（status 未带回填时的兜底）
    // 异步持久化到磁盘（ui-prefs.json，随 self 分区进导出备份）；失败静默降级
    void api.saveUiPrefs({ lastSyncChannel: ch }).catch(() => { /* 保存失败不阻断切换 */ })
  }

  /** 活动通道的远端地址是否就绪（git=repoUrl 非空；webdav=webdavUrl 非空） */
  const remoteReady = computeRemoteReady(state.channel, state.repoUrl, state.webdavUrl)
  const buttons = computeSyncButtons(state.busy, remoteReady, uiT)
  const pushView = pushReportView(state.pushReport, uiT)
  const pullView = pullApplyReportView(state.pullReport, uiT)
  const githubView = computeGithubLoginView(
    state.github.phase, state.github.userCode, state.github.verificationUri, state.github.error, uiT,
  )
  /** GitHub 流程进行中（请求设备码 / 等待授权 / 轮询）：禁用 push/pull，避免无凭据操作 */
  const githubBusy =
    state.github.phase === 'starting' || state.github.phase === 'waiting' || state.github.phase === 'polling'

  /** 残留锁面板模型（可见性/徽章/可点判据全来自纯函数，组件只装配）。 */
  const lockPanel = lockPanelModel(state.statusInfo?.lock, state.recovering, uiT)

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('section.label')} subtitle={t('section.description')} />

          {/* M-16：页面级加载失败就地提示（此前 loadError 只写不读，宿主不可达时整页显示
              「未配置」假象）。此处保留可就地重试的 ErrorBanner —— 它是**页面是否可用**
              的前提条件，必须常驻到用户重试成功，不能交给会自动消失的 Toast。 */}
          {state.loadError !== null && (
            <ErrorBanner
              error={`${t('load.failed')}：${redact(state.loadError)}`}
              onRetry={() => { void loadStatus() }}
              retrying={state.loading}
              t={api.t}
            />
          )}

          {/* 同步通道入口卡：通道配置改为弹窗驱动（点按钮 → 弹窗内配置 Git/WebDAV 通道；
              弹窗样式复用市场操作弹窗体系，DESIGN.md §8.12） */}
          <Card>
            <span className={css.groupLabel}>{t('channel.title')}</span>
            <span className={css.hint}>{t('channel.openHint')}</span>
            <div className={css.statRow}>
              <Badge kind="info">{state.channel === 'webdav' ? t('channel.webdav') : t('channel.git')}</Badge>
              <Badge kind={remoteReady ? 'ok' : 'warn'}>
                {remoteReady ? t('channel.configured') : t('channel.notConfigured')}
              </Badge>
              {state.channel === 'git' && state.statusInfo?.credentialConfigured === true && (
                <Badge kind="ok">{t('config.tokenSaved')}</Badge>
              )}
              {state.channel === 'webdav' && state.statusInfo?.webdav?.passwordConfigured === true && (
                <Badge kind="ok">{t('webdav.passwordSaved')}</Badge>
              )}
            </div>
            {/* 状态事实行（Workbench：配置状态/上次同步/可同步分区——未配置时也要给硬事实） */}
            <div className={css.factGrid} style={{ marginTop: 8 }}>
              <div className={css.factCell}>
                <span className={css.factLabel}>{t('syncStatus.state')}</span>
                <span className={css.factValue}>
                  {state.statusInfo?.configured === true ? t('channel.configured') : t('channel.notConfigured')}
                </span>
              </div>
              <div className={css.factCell}>
                <span className={css.factLabel}>{t('syncStatus.lastSync')}</span>
                <span className={css.factValue}>
                  {state.statusInfo?.lastSyncAt !== undefined
                    ? new Date(state.statusInfo.lastSyncAt).toLocaleString()
                    : '—'}
                </span>
              </div>
              {state.statusInfo?.sectionCount !== undefined && (
                <div className={css.factCell}>
                  <span className={css.factLabel}>{t('syncStatus.sections')}</span>
                  <span className={`${css.factValue} ${css.mono}`}>{String(state.statusInfo.sectionCount)}</span>
                </div>
              )}
              {remoteReady && (
                <div className={css.factCell} style={{ gridColumn: '1 / -1' }}>
                  <span className={css.factLabel}>{t('channel.currentUrl')}</span>
                  <span className={css.factValue}>
                    <span className={css.mono}>
                      {(state.channel === 'webdav' ? state.webdavUrl : state.repoUrl).slice(0, 60)}
                    </span>
                  </span>
                </div>
              )}
            </div>
            <div className={css.actionRowTop}>
              <Button variant="primary" onClick={openChannelDialog}>
                {t('channel.open')}
              </Button>
            </div>
          </Card>

          {/* 残留环境锁入口（issue #27/#31）：仅在锁非 FREE 时出现。此前 423 文案把用户指向
              已删除的「事故恢复」面板与 CLI → 用户无出路（本 issue 的原始症状）。
              attention=true（残留锁/无法判定）才给可点按钮；活锁会自行释放，只陈述不催回收。 */}
          {lockPanel.visible && (
            <Card>
              <span className={css.groupLabel}>{uiT('sync.lock.title')}</span>
              <div className={css.statRow}>
                <Badge kind={lockPanel.badgeKind}>{lockPanel.badgeLabel}</Badge>
              </div>
              <span className={css.hint}>{lockPanel.detail}</span>
              <div className={css.actionRow}>
                <Button
                  variant="primary"
                  disabled={!lockPanel.canRecover || state.busy !== null}
                  loading={state.recovering}
                  onClick={() => { void recoverStaleLock() }}
                >
                  {state.recovering ? <Spinner label={lockPanel.label} /> : lockPanel.label}
                </Button>
              </div>
            </Card>
          )}

          {/* 通道配置弹窗（Radix Modal 统一 a11y：focus-trap / Esc / 焦点还原 / 滚动锁；
              内含推送结果/拉取结果等嵌套 Modal，Radix 支持嵌套弹窗） */}
          <Modal
            open={channelOpen}
            onClose={closeChannelDialog}
            title={t('channel.title')}
            wide
            busy={state.savingConfig}
          >
            <Modal.Header
              title={t('channel.title')}
              onClose={closeChannelDialog}
              closeDisabled={state.savingConfig}
            />
            <Modal.Body scroll>

          {/* 通道子 tab：GitHub / WebDAV（modeTabs 样式；两通道设置各自独立） */}
          <div className={css.modeTabs} role="tablist">
            {channelTabModels(state.channel, state.busy !== null || state.savingConfig).map((tab) => (
              <button
                key={tab.channel}
                type="button"
                role="tab"
                aria-selected={tab.active}
                data-active={tab.active ? '' : undefined}
                className={css.modeTab}
                disabled={tab.disabled}
                onClick={() => { switchChannel(tab.channel) }}
              >
                {tab.channel === 'webdav' ? t('channel.webdav') : t('channel.git')}
              </button>
            ))}
          </div>
          <div className={css.modeHint}>{t('channel.perChannelHint')}</div>

          {/* 私有仓库强制提示：仅 git 通道适用 */}
          {state.channel === 'git' && <Banner kind="warn">{privateRepoHint(uiT)}</Banner>}

            {/* git 通道分支 */}
            {state.channel === 'git' && (
              <>
                <span className={css.groupLabel}>{t('config.title')}</span>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('config.repoUrl')}</span>
                  <input
                    type="text"
                    className={css.input}
                    value={state.repoUrl}
                    placeholder="https://github.com/user/private-repo.git"
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      patch({ repoUrl: e.target.value })
                      scheduleConfigSave() // 改动自动保存（防抖；关闭设置页不丢输入）
                    }}
                  />
                  <span className={css.hint}>{t('config.repoUrlHint')}</span>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>
                    {t('config.token')}
                    {' '}
                    {state.statusInfo?.credentialConfigured === true && <Badge kind="ok">{t('config.tokenSaved')}</Badge>}
                  </span>
                  <input
                    type="password"
                    className={css.input}
                    value={state.token}
                    autoComplete="off"
                    placeholder={t('config.tokenPlaceholder')}
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      patch({ token: e.target.value })
                      scheduleConfigSave()
                    }}
                  />
                  <span className={css.hint}>{t('config.tokenHint', { ref: SYNC_CREDENTIAL_REF })}</span>
                </label>

                {/* GitHub OAuth 登录（device flow）：弹窗内仅 git 通道显示；已登录（token 有效）时整块隐藏 */}
                {state.githubSignedIn === false && (
                  <>
                    {state.statusInfo?.credentialConfigured === true && (
                      <Banner kind="warn">{t('github.tokenInvalid')}</Banner>
                    )}
                    <span className={css.groupLabel}>{t('github.title')}</span>
                    <span className={css.hint}>{t('github.description')}</span>
                    {githubView.showCode && (
                      <div className={css.statRow}>
                        <Badge kind="info">{t('github.userCode')}：<strong>{githubView.userCode}</strong></Badge>
                        <a
                          className={css.ghostButton}
                          href={githubView.verificationUri}
                          target="_blank"
                          rel="noreferrer"
                          style={{ textDecoration: 'none' }}
                        >
                          {t('github.openAuth')}
                        </a>
                      </div>
                    )}
                    <div className={css.actionRow}>
                      <Button
                        variant="primary"
                        disabled={!githubView.canStart || state.busy !== null}
                        onClick={() => { void runGithubStart() }}
                      >
                        {githubView.startLabel}
                      </Button>
                      {githubView.canCancel && (
                        <Button disabled={state.busy !== null} onClick={() => { void runGithubCancel() }}>
                          {t('github.cancel')}
                        </Button>
                      )}
                    </div>
                    <div className={css.statRow}>
                      <Badge kind={githubView.phase === 'success' ? 'ok' : githubView.phase === 'error' ? 'error' : 'warn'}>
                        {githubView.statusText}
                      </Badge>
                    </div>
                    {githubView.phase === 'error' && (
                      <span className={css.hint}>{t('config.tokenHint', { ref: SYNC_CREDENTIAL_REF })}</span>
                    )}
                  </>
                )}
              </>
            )}

            {/* webdav 通道分支 */}
            {state.channel === 'webdav' && (
              <>
                <span className={css.groupLabel}>{t('webdav.title')}</span>
                {/* 常见 WebDAV 服务器预设：选择后填充 url 模板（含占位符待替换） */}
                <span className={css.hint}>{t('webdav.presetHint')}</span>
                <select
                  className={css.select}
                  value={presetIdForUrl(state.webdavUrl)}
                  disabled={state.busy !== null}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                    const p = presetById(e.target.value)
                    patch({ webdavUrl: p.url })
                    scheduleConfigSave()
                  }}
                >
                  {WEBDAV_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('webdav.url')}</span>
                  <input
                    type="text"
                    className={css.input}
                    value={state.webdavUrl}
                    placeholder="https://dav.example.com/dav/config"
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      patch({ webdavUrl: e.target.value })
                      scheduleConfigSave()
                    }}
                  />
                  <span className={css.hint}>{t('webdav.urlHint')}</span>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>
                    {t('webdav.username')}
                    {' '}
                    {state.statusInfo?.webdav?.usernameConfigured === true && <Badge kind="ok">{t('config.tokenSaved')}</Badge>}
                  </span>
                  <input
                    type="text"
                    className={css.input}
                    value={state.webdavUsername}
                    autoComplete="off"
                    placeholder="alice"
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      patch({ webdavUsername: e.target.value })
                      scheduleConfigSave()
                    }}
                  />
                  <span className={css.hint}>{t('webdav.usernameHint')}</span>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>
                    {t('webdav.password')}
                    {' '}
                    {state.statusInfo?.webdav?.passwordConfigured === true && <Badge kind="ok">{t('webdav.passwordSaved')}</Badge>}
                  </span>
                  <input
                    type="password"
                    className={css.input}
                    value={state.webdavPassword}
                    autoComplete="off"
                    placeholder={t('webdav.passwordPlaceholder')}
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      patch({ webdavPassword: e.target.value })
                      scheduleConfigSave()
                    }}
                  />
                  <span className={css.hint}>{t('webdav.passwordHint', { ref: SYNC_WEBDAV_CREDENTIAL_REF })}</span>
                </label>
              </>
            )}

            {/* 配置保存：改动自动保存（防抖，静默）；按钮立即保存并给出 Toast 回执（announce=true） */}
            <div className={css.actionRow}>
              <Button
                variant="primary"
                disabled={state.busy !== null || state.savingConfig || !remoteReady}
                onClick={() => { flushConfigSave(true) }}
              >
                {state.savingConfig ? <Spinner label={t('config.saving')} /> : t('config.save')}
              </Button>
            </div>
            <span className={css.hint}>{t('config.saveHint')}</span>
            </Modal.Body>
          </Modal>

          {/* 同步范围（固定）：不再有模式选择 —— 推送/拉取恒同步全部支持的分区，
              只排除 workspaces（平台相关）与 sessions（设备相关）。 */}
          <Card>
            <span className={css.groupLabel}>{t('scope.title')}</span>
            <span className={css.hint}>{t('scope.hint')}</span>
            <span className={css.hint}>{t('scope.excludedHint')}</span>
          </Card>

          {/* 两个同步按钮（当前通道）：拉取 = 直接覆盖本地；推送 = 直接覆盖远端。
              两者都不弹确认 —— 勾选即同步是本插件的产品语义。 */}
          <div className={css.actionRow}>
            <Button
              variant="primary"
              disabled={!buttons.canPull || githubBusy || state.busy !== null}
              onClick={() => { void runPull() }}
            >
              {state.busy === 'pull' ? <Spinner label={buttons.pullLabel} /> : buttons.pullLabel}
            </Button>
            <Button
              disabled={!buttons.canPush || githubBusy || state.busy !== null}
              onClick={() => { void runPush() }}
            >
              {state.busy === 'push' ? <Spinner label={buttons.pushLabel} /> : buttons.pushLabel}
            </Button>
          </div>

          <SyncHistoryView api={api} t={t} />
          <Modal
            open={state.pushReport !== null && pushView !== null}
            onClose={() => { patch({ pushReport: null }) }}
            title={t('push.title')}
            cardStyle={{ width: 'min(640px, 100%)', maxHeight: '85vh' }}
          >
            <Modal.Header
              title={t('push.title')}
              onClose={() => { patch({ pushReport: null }) }}
            />
            <Modal.Body scroll style={{ maxHeight: '70vh' }}>
              {pushView !== null && (<>
                <Banner kind={pushView.kind === 'ok' ? 'ok' : 'error'}>{pushView.headline}</Banner>
                {pushView.sections.length > 0 && (
                  <div>
                    <span className={css.fieldLabel}>{t('sections.title')}</span>
                    <div className={css.statRow}>
                      {pushView.sections.map((s) => <Badge key={s} kind="info">{s}</Badge>)}
                    </div>
                  </div>
                )}
                {pushView.warnings.length > 0 && (
                  <div>
                    <span className={css.fieldLabel}>{t('warnings.title')}</span>
                    <ul className={css.warnList}>
                      {pushView.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </div>
                )}
              </>)}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="primary" onClick={() => { patch({ pushReport: null }) }}>
                {t('common.close')}
              </Button>
            </Modal.Footer>
          </Modal>

          {/* 拉取结果弹窗（Radix Modal）：本次覆盖写入了哪些分区 + 回滚入口 */}
          <Modal
            open={state.pullReport !== null && pullView !== null}
            onClose={() => { patch({ pullReport: null }) }}
            title={t('pull.title')}
            cardStyle={{ width: 'min(720px, 100%)', maxHeight: '85vh' }}
          >
            <Modal.Header
              title={t('pull.title')}
              onClose={() => { patch({ pullReport: null }) }}
            />
            <Modal.Body scroll style={{ maxHeight: '70vh' }}>
              {pullView !== null && (<>
                <Banner kind={pullView.kind === 'ok' ? 'ok' : pullView.kind === 'empty' ? 'info' : 'error'}>
                  {pullView.headline}
                </Banner>
                {pullView.rolledBack && <Banner kind="warn">{t('pull.rolledBack')}</Banner>}
                {pullView.applied.length > 0 && (
                  <div>
                    <span className={css.fieldLabel}>{t('sections.title')}</span>
                    <div className={css.statRow}>
                      {pullView.applied.map((s) => <Badge key={s} kind="info">{s}</Badge>)}
                    </div>
                  </div>
                )}
                {pullView.summary !== null && pullView.summary.items.length > 0 && (
                  <>
                    <div className={css.statRow}>
                      <Badge kind="info">{t('change.total', { total: pullView.summary.total })}</Badge>
                      {pullView.summary.error > 0 && <Badge kind="error">{severityLabel('error', uiT)} × {pullView.summary.error}</Badge>}
                      {pullView.summary.warning > 0 && <Badge kind="warn">{severityLabel('warning', uiT)} × {pullView.summary.warning}</Badge>}
                      {pullView.summary.info > 0 && <Badge kind="info">{severityLabel('info', uiT)} × {pullView.summary.info}</Badge>}
                    </div>
                    <div className={css.pullScroll}>
                      <div className={css.reportList}>
                        {pullView.summary.items.map((c) => (
                          <div key={c.id} className={css.statRow}>
                            <span className={css.kindTag}>{kindLabel(c.kind, uiT)}</span>
                            <Badge kind={c.severity === 'error' ? 'error' : c.severity === 'warning' ? 'warn' : 'info'}>
                              {severityLabel(c.severity, uiT)}
                            </Badge>
                            <span>{c.description}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                {pullView.restoreHint !== '' && <Banner kind="info">{pullView.restoreHint}</Banner>}
              </>)}
            </Modal.Body>
            <Modal.Footer>
              {state.lastRestoreId !== null && (
                <Button variant="danger" disabled={state.busy !== null} onClick={() => { setRollbackOpen(true) }}>
                  {t('pull.undo')}
                </Button>
              )}
              <Button variant="primary" onClick={() => { patch({ pullReport: null }) }}>
                {t('common.close')}
              </Button>
            </Modal.Footer>
          </Modal>

          {/* 撤销本次覆盖的二次确认（DESIGN.md §6：回滚恒 danger + 二次确认） */}
          <Modal
            open={rollbackOpen}
            onClose={() => { setRollbackOpen(false) }}
            title={t('rollback.title')}
            busy={state.busy !== null}
          >
            <Modal.Header title={t('rollback.title')} onClose={() => { setRollbackOpen(false) }} />
            <Modal.Body>
              <Banner kind="warn">{t('rollback.body')}</Banner>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="danger" disabled={state.busy !== null} onClick={() => { void runRollback() }}>
                {state.busy === 'rollback' ? <Spinner label={t('rollback.running')} /> : t('rollback.confirm')}
              </Button>
              <Button disabled={state.busy !== null} onClick={() => { setRollbackOpen(false) }}>
                {t('common.close')}
              </Button>
            </Modal.Footer>
          </Modal>
    </div>
  )
}