/**
 * Locating the official composer model menu — the seat root's open popover.
 *
 * @module dsh-better-reasoning-effort/client/injection/model-menu
 */

/**
 * The official composer model menu: the seat root's open popover.
 *
 * Shape-tolerant across kernels: 0.1.5 portals the menu to document.body
 * and links it from the seat trigger via aria-controls, while older kernels
 * render it inline right after the trigger. Both shapes keep
 * aria-haspopup="menu" on the trigger, so the controls link is the primary
 * route and the sibling check stays as the fallback. Trigger search stays
 * scoped to the composer card, so other seats' menus never match; no copy
 * text is read, so every locale matches.
 *
 * The seat is the composer card itself: a document without one carries no
 * seat at all (a settings-only page or window, a detached render). The finder
 * returns undefined rather than widening to the document, because that
 * surface's OWN linked menus — the settings header's restart dropdown, for
 * one — are not the model menu, and the slider would replace their body
 * (issue #24).
 *
 * The popover's ROLE is shape-tolerant too: `menu` on every pane but the
 * 0.2.0-rc.2 model list, which swaps in `group` because its own list box
 * takes role="menu" (ModelSelect.tsx:484). There the menu rows identify the
 * popover instead -- see {@link isSeatPopup}.
 *
 * SHAPE ALONE IS NOT ENOUGH for the inline route: the worktree picker is a
 * second seat in the same composer and renders through the same Menu
 * primitive, so its popover is also a role="menu" right after a
 * button[aria-haspopup="menu"]. Matching it put this plugin's slider into the
 * branch picker. The slot wrapper is what separates them -- see
 * {@link seatSlotOf}.
 */

/** The composer slot that owns the model seat. */
const MODEL_SEAT_SLOT = 'conversation.input.model'

/**
 * The composer slot an element belongs to, when the kernel wraps slots in
 * elements at all.
 *
 * Kernels render each seat inside a `[data-slot]` wrapper, so the model seat
 * can be identified exactly instead of by popover shape. Older kernels have
 * no such wrapper: `undefined` there means "unknown", not "not the seat".
 * @param element - any node inside the composer.
 * @returns the slot name, or undefined when there is no wrapper.
 */
function seatSlotOf(element: HTMLElement): string | undefined {
  return element.closest('[data-slot]')?.getAttribute('data-slot') ?? undefined
}

/**
 * Whether an element is the seat's popover rather than some other linked or
 * grouped node.
 *
 * A role of `menu` is enough. A role of `group` is the 0.2.0-rc.2 model
 * list pane: the popover itself becomes a plain group, so the honest probe is
 * "does it carry menu rows?" — which also keeps unrelated groups (a settings
 * fieldset, the pane's inner sections' wrapper) from matching.
 */
function isSeatPopup(element: HTMLElement): boolean {
  const role = element.getAttribute('role')
  if (role === 'menu') return true
  return role === 'group'
    && element.querySelector('[role="menuitem"], [role="menuitemradio"]') !== null
}

export function findModelMenu(doc: Document = document): HTMLElement | undefined {
  // The seat lives only inside the composer card. Without one this surface has
  // no seat: return early instead of scanning the document, whose unrelated
  // menus would otherwise be adopted as the model menu (issue #24).
  const card = doc.querySelector('[data-composer-card]')
  if (card === null) return undefined
  for (const trigger of Array.from(card.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"][aria-controls]'))) {
    const id = trigger.getAttribute('aria-controls')
    if (id === null || id.length === 0) continue
    const menu = doc.getElementById(id)
    if (menu !== null && isSeatPopup(menu)) return menu
  }
  // Fallback: the pre-portal inline shape — the popover sits right after its
  // trigger button. That shape is shared with every other seat built on the
  // same Menu primitive, so the slot wrapper decides which one is the model
  // seat; a kernel without slot wrappers keeps the old shape-only answer.
  const popovers = Array.from(card.querySelectorAll<HTMLElement>('[role="menu"], [role="group"]'))
  let unwrapped: HTMLElement | undefined
  for (const popover of popovers) {
    if (!popover.previousElementSibling?.matches('button[aria-haspopup="menu"]')) continue
    if (!isSeatPopup(popover)) continue
    const slot = seatSlotOf(popover)
    if (slot === MODEL_SEAT_SLOT) return popover
    if (slot === undefined && unwrapped === undefined) unwrapped = popover
  }
  return unwrapped
}

/** The official composer model menu: the seat root's open popover. */
export function modelMenuOf(): HTMLElement | undefined {
  return findModelMenu()
}
