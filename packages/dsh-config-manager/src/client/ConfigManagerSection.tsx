/**
 * Config Manager 配置页 —— 「插件 → @logictan/dsh-plugins-all」详情页里本插件那一行的页面。
 * 仅同步一个页面，故不设页签导航：主体直接是同步内容。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigManagerSectionInjected, TranslateNS } from './client-types.ts'
import type { ServiceStatus } from './api.ts'
import { runStore } from './run-store.ts'
import { SyncSettingsView } from './sync/SyncSettingsView.tsx'
import { MODAL_ROOT_ID } from './common/Modal.tsx'
import { StatusDot } from './common/ui.tsx'
import { ToastViewport } from './common/ToastViewport.tsx'
import css from './config-manager.module.css'

export type ConfigManagerSectionProps =
  & PropsRuntime<'plugins.row.config'>
  & ConfigManagerSectionInjected
  & { t: TranslateNS<'config-manager'> }

export function ConfigManagerSection({ api, syncApi, syncT, t }: ConfigManagerSectionProps) {
  const state = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot)

  /* ---------------- 状态栏版本（挂载时取一次；失败隐藏） ---------------- */
  const [version, setVersion] = useState<ServiceStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    api.status().then(
      (s) => { if (!cancelled) setVersion(s) },
      () => { /* 版本信息失败不影响功能 */ },
    )
    return () => { cancelled = true }
  }, [api])

  /* ---------------- 状态栏数据 ---------------- */
  const runningCount = state.sync.busy !== null ? 1 : 0
  const statusKind: 'ok' | 'info' | 'error' = runningCount > 0 ? 'info' : 'ok'
  const statusText = runningCount > 0
    ? t('shell.status.running', { count: String(runningCount) })
    : t('shell.status.idle')

  return (
    <div className={css.section} id={MODAL_ROOT_ID}>
      {/* 页面主体 */}
      <main className={css.shellMain}>
        <div className={css.pagePad}>
          <SyncSettingsView api={syncApi} t={syncT} />
        </div>
      </main>

      {/* 底部状态栏：运行状态 + 版本 */}
      <footer className={css.statusBar}>
        <StatusDot kind={statusKind} pulse={runningCount > 0} />
        <span className={css.statusText}>{statusText}</span>
        <span className={css.statusSpacer} />
        {version !== null && (
          <span className={css.statusMeta}>
            {t('shell.version', { plugin: version.pluginVersion, dsh: version.dshVersion })}
          </span>
        )}
      </footer>

      {/* 全局通知视口（右下角堆叠） */}
      <ToastViewport t={t} />
    </div>
  )
}
