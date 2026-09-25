/**
 * Replace the shell's standalone New Session affordance with a two-tab entry:
 * New Session and Image Generation. When image generation is active, the
 * plugin also uses the shell's region area as a dedicated history surface;
 * the original workspace/session tree remains underneath and is restored when
 * the panel closes.
 */

import type { ImageGenController } from './controller.ts'
import css from './panel.module.css'

/** Stable selector for the injected two-tab host. */
export const ENTRY_SELECTOR = '[data-dsh-imagegen-session-tabs]'
/** Stable selector for the history surface in the shell region area. */
export const HISTORY_HOST_SELECTOR = '[data-dsh-imagegen-history-host]'

/** Inline picture glyph kept deliberately small for the sidebar rail. */
const IMAGE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="5.6" cy="5.8" r="1"/><path d="M2.5 12.5l3.6-3.4 2.4 2.2 3-3 2 2.4"/></svg>'

/** Inline plus glyph for the new-session tab. */
const NEW_SESSION_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>'

/**
 * Sidebar column markers: the web shell names its grid column `sidebarCol`
 * (AppFrame) or exposes `data-pane="sidebar"`; DSH Desktop renders the upstream
 * sidebar inside a surface of its own instead (#20).
 */
const SIDEBAR_COLUMN_SELECTOR = [
  '[data-pane="sidebar"]',
  '[class*="sidebarCol"]',
  '[class*="dshDesktopSidebarSurface"]',
  '[class*="dshDesktopUpstreamSidebar"]',
].join(', ')

/** Accessible names the shell gives its New Session affordance. */
const NEW_SESSION_LABELS = ['new session', 'new chat', '新会话', '新建会话', '新对话', '新话题']

/** Loose New Session match for shells without a stable class or data hook. */
function looksLikeNewSession(button: HTMLButtonElement): boolean {
  const name = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''} ${button.textContent ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
  return NEW_SESSION_LABELS.some((label) => name.includes(label))
}

/** Find the sidebar shell root, or undefined while it is not mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>(SIDEBAR_COLUMN_SELECTOR)
  const logoRow = (column ?? document).querySelector<HTMLElement>('[class*="logoRow"]')
  if (logoRow !== null) {
    // Walk out of the brand row until an ancestor also owns the shell button:
    // desktop shells put a wrapper surface between the two, so the row parent is
    // not always the root the tabs have to live in (#20).
    for (let candidate = logoRow.parentElement; candidate !== null; candidate = candidate.parentElement) {
      if (candidate === document.body) break
      if (newSessionButton(candidate, false) !== undefined) return candidate
      if (candidate === column) break
      if (column !== null && !column.contains(candidate)) break
    }
    // Legacy shape: with no recognisable shell button anywhere above the brand
    // row its parent stays the mount point, which is where the web shell has
    // always kept the tabs (#20).
    return logoRow.parentElement ?? column ?? undefined
  }
  if (column === null) return undefined
  return (column.firstElementChild as HTMLElement | undefined) ?? column
}

/**
 * The shell-owned New Session button across current and legacy shells. The
 * loose fallback stays opt-in so the root search never settles on a wrapper
 * whose first button happens to be a brand or collapse toggle (#20).
 */
function newSessionButton(root: HTMLElement, allowLooseFallback = true): HTMLButtonElement | undefined {
  const hooked = root.querySelector<HTMLButtonElement>(
    'button[data-dsh-part="new-session"], button[class*="newSession"]',
  )
  if (hooked !== null) return hooked
  const labelled = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(looksLikeNewSession)
  if (labelled !== undefined) return labelled
  if (!allowLooseFallback) return undefined
  return Array.from(root.children).find(
    (child): child is HTMLButtonElement => child instanceof HTMLElement && child.tagName === 'BUTTON',
  )
}

/** Locate the shell region that normally contains workspaces and sessions. */
function regionArea(root: HTMLElement): HTMLElement | undefined {
  return root.querySelector<HTMLElement>('[class*="regionArea"]') ?? undefined
}

function makeTab(
  label: string,
  tooltip: string,
  icon: string,
  onClick: () => void,
): HTMLButtonElement {
  const tab = document.createElement('button')
  tab.type = 'button'
  tab.className = css.sessionTab
  tab.setAttribute('aria-label', label)
  tab.setAttribute('title', tooltip)
  tab.innerHTML = `<span class="${css.sessionTabIcon}">${icon}</span><span class="${css.sessionTabLabel}">${label}</span>`
  tab.addEventListener('click', onClick)
  return tab
}

function hideShellButton(button: HTMLButtonElement): void {
  // MutationObserver drives the self-heal pass. Re-writing an already-hidden
  // button from that pass creates another mutation and can starve the page in
  // an endless observer loop, so apply the hidden state idempotently.
  if (
    button.dataset.dshImagegenOriginal === ''
    && button.getAttribute('aria-hidden') === 'true'
    && button.tabIndex === -1
    && button.style.display === 'none'
  ) return
  button.dataset.dshImagegenOriginal = ''
  button.setAttribute('aria-hidden', 'true')
  button.tabIndex = -1
  button.style.display = 'none'
}

function restoreShellButton(button: HTMLButtonElement): void {
  button.style.removeProperty('display')
  button.removeAttribute('aria-hidden')
  button.removeAttribute('tabindex')
  delete button.dataset.dshImagegenOriginal
}

/** Mount or repair the two-tab host at the shell's New Session position. */
function placeTabs(
  root: HTMLElement,
  controller: ImageGenController,
  newSessionLabel: string,
  newSessionTooltip: string,
  imageLabel: string,
  imageTooltip: string,
): HTMLDivElement | undefined {
  const button = newSessionButton(root)
  if (button === undefined) return undefined

  const existing = root.querySelector<HTMLDivElement>(ENTRY_SELECTOR)
  if (existing !== null && existing.parentElement === button.parentElement) {
    hideShellButton(button)
    return existing
  }

  existing?.remove()
  const tabs = document.createElement('div')
  tabs.dataset.dshImagegenSessionTabs = ''
  tabs.className = css.sessionTabs
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', imageTooltip)

  const newSessionTab = makeTab(newSessionLabel, newSessionTooltip, NEW_SESSION_ICON, () => {
    controller.close()
    button.click()
  })
  const imageTab = makeTab(imageLabel, imageTooltip, IMAGE_ICON, () => {
    controller.open()
  })
  newSessionTab.dataset.dshImagegenTab = 'new-session'
  imageTab.dataset.dshImagegenTab = 'image'
  tabs.append(newSessionTab, imageTab)

  button.parentElement?.insertBefore(tabs, button)
  hideShellButton(button)
  return tabs
}

/** Mount an overlay host over the workspace/session tree for image history. */
function placeHistoryHost(root: HTMLElement): HTMLDivElement | undefined {
  const region = regionArea(root)
  if (region === undefined) return undefined
  const existing = region.querySelector<HTMLDivElement>(HISTORY_HOST_SELECTOR)
  if (existing !== null) return existing
  const host = document.createElement('div')
  host.dataset.dshImagegenHistoryHost = ''
  host.className = css.sidebarHistoryHost
  region.append(host)
  return host
}

/**
 * Mount the two tabs and self-heal after React rebuilds the sidebar. The
 * shell-owned button is restored by the disposer so unloading the plugin
 * leaves the host unchanged.
 */
export function mountSidebarEntry(
  controller: ImageGenController,
  newSessionLabel: string,
  newSessionTooltip: string,
  imageLabel: string,
  imageTooltip: string,
): () => void {
  let root: HTMLElement | undefined
  let tabs: HTMLDivElement | undefined
  let historyHost: HTMLDivElement | undefined
  let originalButton: HTMLButtonElement | undefined
  let warnedUnmounted = false

  /**
   * Compact shell fingerprint for the warning below: it never dumps the sidebar
   * markup (which carries session titles), only the markers we look for.
   */
  const describeShell = (): string => {
    const markers = SIDEBAR_COLUMN_SELECTOR.split(', ')
      .map((selector) => `${selector}=${document.querySelectorAll(selector).length}`)
      .join(' ')
    const outline = Array.from(document.body.children)
      .slice(0, 6)
      .map((element) => {
        const name = typeof element.className === 'string' ? element.className.split(/\s+/)[0] : ''
        return `${element.tagName.toLowerCase()}${name === '' ? '' : `.${name}`}`
      })
      .join(' > ')
    return `${markers} body>${outline}`
  }

  // A shell we have never seen must not fail silently: the reporter of #20 had
  // no console output at all to work from.
  const warnUnmounted = (): void => {
    if (warnedUnmounted || tabs !== undefined) return
    warnedUnmounted = true
    const reason = root === undefined ? 'sidebar root not found' : 'new-session button not found'
    console.warn(`[dsh-imagegen] sidebar entry stayed unmounted (${reason}); shell probe: ${describeShell()}`)
  }

  const unmountedTimer = window.setTimeout(warnUnmounted, 5000)

  const syncActive = (): void => {
    if (tabs === undefined) return
    const newTab = tabs.querySelector<HTMLElement>('[data-dsh-imagegen-tab="new-session"]')
    const imageTab = tabs.querySelector<HTMLElement>('[data-dsh-imagegen-tab="image"]')
    if (controller.getSnapshot().panelOpen) {
      if (newTab !== null) delete newTab.dataset.active
      if (imageTab !== null) imageTab.dataset.active = ''
    } else {
      if (newTab !== null) newTab.dataset.active = ''
      if (imageTab !== null) delete imageTab.dataset.active
    }
  }

  const ensure = (): void => {
    if (root !== undefined && !root.isConnected) {
      root = undefined
      tabs = undefined
      historyHost = undefined
      originalButton = undefined
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    root.dataset.dshImagegenSidebarRoot = ''
    const button = newSessionButton(root)
    if (button === undefined) return
    originalButton ??= button
    tabs = placeTabs(root, controller, newSessionLabel, newSessionTooltip, imageLabel, imageTooltip)
    historyHost = placeHistoryHost(root)
    syncActive()
  }

  const bodyObserver = new MutationObserver(ensure)
  bodyObserver.observe(document.body, { childList: true, subtree: true })
  const unsubscribe = controller.subscribe(syncActive)
  ensure()

  return () => {
    window.clearTimeout(unmountedTimer)
    bodyObserver.disconnect()
    unsubscribe()
    tabs?.remove()
    historyHost?.remove()
    if (originalButton !== undefined && originalButton.isConnected) restoreShellButton(originalButton)
    if (root !== undefined) delete root.dataset.dshImagegenSidebarRoot
  }
}

/**
 * Internals re-exported for the standalone smoke test: the browser bundle is
 * the only consumer of the entry, so the check has to drive these directly to
 * cover a shell layout the jsdom studio fixture does not render (#20).
 */
export const sidebarEntryTestHooks = {
  findSidebarRoot: sidebarRoot,
  findNewSessionButton: newSessionButton,
  mount: mountSidebarEntry,
}
