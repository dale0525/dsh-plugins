/**
 * 导出页（Export —— Workbench Rebuild 2026-09，绑 src/ui/export-flow.ts 的 ExportFlow 控制器）。
 *
 * 布局（564px 画布，致密单列）：
 *   1. 工具栏：模式分段（快速 / 自定义）+ 模式提示 + 预览 ghost + 立即导出 primary
 *   2. 自定义模式：分组分区目录（两列致密勾选；分区说明入 tooltip；设备相关/敏感徽章内联）
 *   3. 选项行：加密备份 / 导出密钥 复选 +（加密时）密码双列内联
 *   4. 命名行：自定义文件名 + 备注 双列
 *   5. 进度条 / 诚实报告 + 自动下载提示
 *   6. 预览弹窗（Modal wide）：合计一行 + 分区构成网格（与总览页共用 SectionComposition）
 *
 * 业务能力（全部保留，与旧版一致）：
 * - Quick：一键导出推荐分区（ExportFlow.quickSelection()）；
 * - Custom：按分组逐项勾选（设备相关 / 敏感分区以内联徽章标注）；
 * - 安全选项：加密备份（AES-256-GCM）与导出密钥两个独立选项；勾选导出密钥自动联动
 *   勾选加密（密钥绝不明文），取消加密一并取消导出密钥（includeSecrets ⇒ encrypt）；
 * - 自定义文件名（失焦自动补全 .zip；合法性校验与宿主一致）+ 备注；
 * - 导出前只读预览（export-preview 端点，零写入；结果在弹窗内呈现）；
 * - 密码仅内存（api.exportPassword 随请求体传输，绝不落盘/入 sessionStorage）；
 * - 导出完成自动下载到浏览器「下载」目录（可再手动下载）。
 *
 * m2：全部 UI 状态由模块级 runStore 持有（切页/关面板不重建、刷新恢复），
 * 控制器实例（ExportFlow）由 store 缓存复用。
 */
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent } from 'react'
import { EXPORT_GROUPS } from '../../ui/types.ts'
import { normalizeExportFileName } from '../../ui/export-flow.ts'
import type { SectionId } from '../../schema/types.ts'
import type { TranslateNS } from '../client-types.ts'
import type { ConfigManagerApi, ExportPreviewResponse } from '../api.ts'
import { runStore, type ExportMode } from '../run-store.ts'
import { formatBytes } from '../../ui/report.ts'
import { Badge, Banner, Button, Checkbox, Segmented, Spinner } from '../common/ui.tsx'
import { SectionComposition } from '../common/SectionComposition.tsx'
import { Modal } from '../common/Modal.tsx'
import { PreviewIcon } from '../common/Icon.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import { ProgressBar } from '../common/ProgressBar.tsx'
import { ReportView } from '../common/ReportView.tsx'
import { toast } from '../common/toast-store.ts'
import css from '../config-manager.module.css'

export interface ExportViewProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
}

/**
 * 导出页：Quick/Custom 切换 → 勾选/密码 → 执行 → 进度 → 报告 → 自动下载。
 */
export function ExportView({ api, t }: ExportViewProps) {
  // m2：状态统一来自模块级 store（sessionStorage 持久化；切页不重建）
  const state = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot)
  const exp = state.export
  // 控制器实例由 store 缓存复用（切页 / 关面板不重建）
  const flow = runStore.exportFlow(api)

  const mode = exp.mode
  const selection = exp.selection
  const includeSecrets = exp.includeSecrets
  const encrypt = exp.encrypt
  /** P0-④：自定义导出文件名（.zip；空 = 宿主自动命名；仅表单非敏感字段） */
  const fileName = exp.fileName
  /** P0-④：导出备注（写入备份列表显示；非敏感） */
  const note = exp.note
  // 密码字段仅内存（store 的敏感字段，绝不序列化进 sessionStorage）
  const password = exp.password
  const passwordConfirm = exp.passwordConfirm
  const running = exp.running
  const progress = exp.progress
  const result = exp.result
  const error = exp.error
  /** 下载进行中（瞬态 UI） */
  const [downloading, setDownloading] = useState(false)
  /** 下载防重入 ref */
  const downloadingRef = useRef(false)
  /** P2-⑫：导出前预览（null = 未请求；进行中/结果/错误） */
  const [preview, setPreview] = useState<{
    loading: boolean
    result: ExportPreviewResponse | null
    error: string | null
  } | null>(null)
  /** 需求 6：预览结果弹窗开关（点击「预览将导出内容」即打开，结果/错误/loading 均在弹窗内呈现） */
  const [previewOpen, setPreviewOpen] = useState(false)

  /** P2-⑫：请求导出前预览（不落盘；按当前模式的分区选择） */
  const runPreview = async (): Promise<void> => {
    if (running) return
    setPreview({ loading: true, result: null, error: null })
    // 需求 6：立即打开弹窗，loading 态在弹窗内呈现（工具栏按钮仍显示 Spinner）
    setPreviewOpen(true)
    try {
      const only = mode === 'quick' ? flow.quickSelection() : [...selection]
      const result = await api.exportPreview(only)
      setPreview({ loading: false, result, error: null })
    } catch (err) {
      setPreview({ loading: false, result: null, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const setMode = (next: ExportMode): void => {
    runStore.patch({ export: { mode: next } })
  }
  const setIncludeSecrets = (next: boolean): void => {
    // 导出密钥联动加密：勾选导出密钥时默认同时选中加密（密钥绝不明文存储）
    runStore.patch({ export: { includeSecrets: next, encrypt: next ? true : exp.encrypt } })
  }
  const setEncrypt = (next: boolean): void => {
    // 取消加密时若仍勾选着导出密钥 → 一并取消（密钥必须以加密形式备份，安全底线）
    runStore.patch({ export: { encrypt: next, includeSecrets: next ? includeSecrets : false } })
  }
  const setPassword = (value: string): void => {
    runStore.patch({ export: { password: value } })
  }
  const setPasswordConfirm = (value: string): void => {
    runStore.patch({ export: { passwordConfirm: value } })
  }
  const setFileName = (value: string): void => {
    runStore.patch({ export: { fileName: value } })
  }
  const setNote = (value: string): void => {
    runStore.patch({ export: { note: value } })
  }

  const toggleSection = useCallback((id: SectionId, checked: boolean): void => {
    const has = selection.includes(id)
    if (checked && !has) runStore.patch({ export: { selection: [...selection, id] } })
    if (!checked && has) runStore.patch({ export: { selection: selection.filter((s) => s !== id) } })
  }, [selection])

  const passwordInvalid =
    encrypt && (password === '' || password !== passwordConfirm)

  /** 自定义文件名合法性（P0-④）：留空合法（自动命名）；非空必须合法文件名。
   *  提交时经 normalizeExportFileName 自动补全 .zip（host 端 isValidExportFileName 仍兜底）。 */
  const trimmedName = fileName.trim()
  const baseName = trimmedName.replace(/\.zip$/i, '')
  const fileNameInvalid = trimmedName !== '' && !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(baseName)

  /** 执行导出（Quick 或 Custom）；成功后自动下载到浏览器「下载」目录 */
  const runExport = async (): Promise<void> => {
    if (passwordInvalid || fileNameInvalid) return
    runStore.patch({
      export: { running: true, error: null, result: null, downloaded: false, progress: null, runId: null },
    })
    // m3：请求进行期间经 /runs 发现 runId 并轮询 /progress（500ms）显示真实进度
    runStore.watchRunning('export', 500)
    try {
      // 加密密码随本次导出请求体传给 Host 半（仅内存）
      api.exportPassword = encrypt ? password : null
      // includeSecrets 只表示「导出密钥」；安全上密钥必须以加密形式备份，
      // UI 联动保证 includeSecrets ⇒ encrypt，这里再兜底一次
      const run = await flow.run(mode, selection, {
        includeSecrets: includeSecrets && encrypt,
        // P0-④：自定义文件名（trim 后为空 = 自动命名；自动补全 .zip 后缀）+ 备注
        fileName: normalizeExportFileName(fileName),
        note: note.trim(),
      })
      // ExportResponse 携带 runId（/progress 查询与刷新恢复用）；控制器类型不含，运行时对象有
      const runId = (run as { runId?: unknown }).runId
      runStore.patch({
        export: {
          result: run,
          runId: typeof runId === 'string' ? runId : null,
          progress: { stage: 'done', step: 1, total: 1 },
        },
      })
      {/* 导出完成即自动下载到浏览器「下载」目录 */}
      await download(run.zipPath)
      // 下载是静默的（不弹系统框），用户点完很可能已切走 → 用 Toast 送达回执
      toast.ok(t('export.saved', { name: run.report.file.name }))
    } catch (err) {
      runStore.patch({ export: { error: err instanceof Error ? err.message : String(err) } })
    } finally {
      runStore.stopRunWatch('export')
      runStore.patch({ export: { running: false } })
    }
  }

  /** 把导出的 ZIP 下载到浏览器（默认静默下载；防重入锁共享）。 */
  const download = async (zipPath: string): Promise<void> => {
    if (zipPath === '' || downloadingRef.current) return
    downloadingRef.current = true
    setDownloading(true)
    try {
      runStore.patch({ export: { error: null } })
      await api.download(zipPath)
      runStore.patch({ export: { downloaded: true } })
    } catch (err) {
      // 下载失败：同时用 Toast 送达（自动下载是静默的，用户可能已切走）
      const message = err instanceof Error ? err.message : String(err)
      runStore.patch({ export: { error: message } })
      toast.error(message)
    } finally {
      downloadingRef.current = false
      setDownloading(false)
    }
  }

  return (
    <div className={css.viewBody}>
      {/* 1. 工具栏：模式 + 预览 + 执行 */}
      <div className={css.actionRow}>
        <Segmented
          items={[
            { id: 'quick', label: t('export.mode.quick') },
            { id: 'custom', label: t('export.mode.custom') },
          ]}
          active={mode}
          onChange={(id) => { setMode(id as ExportMode) }}
          ariaLabel={t('view.export')}
        />
        <span className={css.statusSpacer} />
        <Button size="sm" disabled={running} title={t('export.preview')} onClick={() => { void runPreview() }}>
          {preview?.loading === true ? <Spinner /> : <PreviewIcon size={13} />} {t('export.preview')}
        </Button>
        <Button
          variant="primary"
          disabled={running || passwordInvalid || fileNameInvalid}
          onClick={() => { void runExport() }}
        >
          {running ? <Spinner /> : t('export.run')}
        </Button>
      </div>
      <div className={css.modeHint}>
        {mode === 'quick' ? t('export.mode.quickHint') : t('export.mode.customHint')}
      </div>

      {/* 2. Custom：分组分区目录（两列致密勾选） */}
      {mode === 'custom' && (
        <div className={css.exportGrid}>
          {EXPORT_GROUPS.map((group) => {
            const categories = flow.categories.filter((c) => c.group === group.id)
            if (categories.length === 0) return null
            return (
              <div key={group.id} className={css.exportGroup}>
                <div className={css.groupHeader}>
                  <span className={css.groupLabel}>{group.label}</span>
                  {group.note !== undefined && <span className={css.groupNote}>{group.note}</span>}
                </div>
                <div className={css.exportItems}>
                  {categories.map((cat) => (
                    <div key={cat.id} className={css.exportItem} title={cat.description}>
                      <Checkbox
                        checked={selection.includes(cat.id)}
                        onChange={(checked) => { toggleSection(cat.id, checked) }}
                        label={
                          <span className={css.categoryItem}>
                            <span className={css.categoryName}>{cat.label}</span>
                            {cat.portability !== 'portable' && (
                              <Badge kind={cat.portability === 'deviceSpecific' ? 'warn' : 'info'}>{cat.portability}</Badge>
                            )}
                            {cat.sensitive === true && <Badge kind="warn">secret</Badge>}
                          </span>
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 3. 选项行：加密 / 导出密钥（联动规则保持） */}
      <div className={css.optionsRow}>
        <Checkbox
          checked={encrypt}
          onChange={setEncrypt}
          label={<span className={css.categoryName}>{t('export.encrypt')}</span>}
        />
        <Checkbox
          checked={includeSecrets}
          onChange={setIncludeSecrets}
          label={<span className={css.categoryName}>{t('export.includeSecrets')}</span>}
        />
        <span className={css.statusSpacer} />
      </div>
      <div className={css.hint} style={{ marginBottom: 10 }}>
        {encrypt ? t('export.encryptHint') : t('export.includeSecretsHint')}
      </div>
      {encrypt && (
        <div className={css.secretFields}>
          <label className={css.field} style={{ marginBottom: 0 }}>
            <span className={css.fieldLabel}>{t('export.password')}</span>
            <input type="password" className={css.input} value={password} onChange={(e: ChangeEvent<HTMLInputElement>) => { setPassword(e.target.value) }} autoComplete="new-password" />
            {password === '' && <span className={css.formError}>{t('export.passwordRequired')}</span>}
          </label>
          <label className={css.field} style={{ marginBottom: 0 }}>
            <span className={css.fieldLabel}>{t('export.passwordConfirm')}</span>
            <input type="password" className={css.input} value={passwordConfirm} onChange={(e: ChangeEvent<HTMLInputElement>) => { setPasswordConfirm(e.target.value) }} autoComplete="new-password" />
            {password !== '' && password !== passwordConfirm && <span className={css.formError}>{t('export.passwordMismatch')}</span>}
          </label>
        </div>
      )}

      {/* 4. 命名行：文件名 + 备注（双列） */}
      <div className={css.secretFields}>
        <label className={css.field} style={{ marginBottom: 0 }}>
          <span className={css.fieldLabel}>{t('export.fileName')}</span>
          <input
            type="text"
            className={css.input}
            value={fileName}
            placeholder="dsh-config-2026-08-24"
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setFileName(e.target.value) }}
            onBlur={() => {
              // 失焦自动补全 .zip 后缀（空值保持空 = 宿主自动命名）
              if (fileName.trim() !== '') setFileName(normalizeExportFileName(fileName))
            }}
          />
          {fileNameInvalid && <span className={css.formError}>{t('export.fileNameInvalid')}</span>}
        </label>
        <label className={css.field} style={{ marginBottom: 0 }}>
          <span className={css.fieldLabel}>{t('export.note')}</span>
          <input
            type="text"
            className={css.input}
            value={note}
            placeholder={t('export.notePlaceholder')}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setNote(e.target.value) }}
          />
        </label>
      </div>

      {/* 需求 6：导出前预览弹窗（零写入；loading / 合计 / 分区构成 / 错误都在弹窗内呈现） */}
      <Modal
        open={previewOpen}
        onClose={() => { setPreviewOpen(false) }}
        title={t('export.preview')}
        wide
      >
        <Modal.Header
          title={t('export.preview')}
          onClose={() => { setPreviewOpen(false) }}
        />
        <Modal.Body scroll>
          {preview?.loading === true && <Spinner label={t('export.previewing')} />}
          {preview !== null && preview.error !== null && <Banner kind="error">{preview.error}</Banner>}
          {preview !== null && !preview.loading && preview.result !== null && (
            <>
              <div className={css.hint}>
                {t('export.previewSummary', {
                  sections: String(preview.result.totalSections),
                  size: formatBytes(preview.result.totalSizeBytes),
                })}
                {preview.result.sectionsFailed > 0 && ` · ${t('export.previewSkipped', { count: String(preview.result.sectionsFailed) })}`}
              </div>
              <SectionComposition sections={preview.result.sections} t={t} />
            </>
          )}
        </Modal.Body>
      </Modal>

      {running && <ProgressBar event={progress} active />}

      {error !== null && (
        <ErrorBanner error={error} onRetry={() => { void runExport() }} retrying={running} t={api.t} />
      )}

      {result !== null && !running && (
        <>
          <ReportView kind="export" exportReport={result.report} onDownload={() => { void download(result.zipPath) }} downloadBusy={downloading} t={api.t} />
        </>
      )}
    </div>
  )
}
