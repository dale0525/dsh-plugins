/** WorkBuddy's configuration page: both product cards under one row's entry. */

import type { CSSProperties, ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { CARD_VARIANTS, WorkBuddyPluginCard } from './WorkBuddyPluginCard.tsx'
import type { WorkBuddySettingsKey } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface WorkBuddyPluginConfigInjected {
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
}

/** Props delivered by the row-configuration slot. */
export type WorkBuddyPluginConfigProps =
  PropsRuntime<'plugins.row.config'>
  & Partial<WorkBuddyPluginConfigInjected>

/**
 * The cards' list; the page supplies no other chrome. A semantic `<ul>` —
 * each card below is an `<li>` — with the user-agent list defaults cleared so
 * only the column/gap rhythm remains.
 */
const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  listStyle: 'none',
  margin: 0,
  padding: 0,
}

/**
 * Render the WorkBuddy row's one-liner or its configuration page.
 *
 * The Plugins page renders every configuration entry twice: once as the
 * one-liner under the row's title (`view: 'summary'`) and once as the body of
 * the row's own page (`view: 'page'`). The page draws the row id, the module
 * name, and the crumb itself, so this component supplies only the copy and the
 * forms.
 *
 * Both products live in this one entry because the row is declared once: the
 * slot is keyed by `<bundle>#<row id>`, and a second registration under the
 * same key throws. Each product therefore keeps its own card — with its own
 * account, balance, and model set — inside the single page.
 */
export function WorkBuddyPluginConfig(props: WorkBuddyPluginConfigProps): ReactNode {
  const { t } = props
  if (t === undefined) throw new Error('WorkBuddy plugin config requires its translation function')
  if (props.view === 'summary') return t('configSummary')
  return (
    <ul style={pageStyle}>
      {CARD_VARIANTS.map(variant => (
        <WorkBuddyPluginCard key={variant.id} t={t} variant={variant} />
      ))}
    </ul>
  )
}
