/**
 * Model-menu discovery tests: the composer slider mounts inside the OFFICIAL
 * model menu, whose DOM shape changed in DeepSeek Harness 0.1.5-alpha.1.
 *
 *   - pre-portal: the menu renders inline inside [data-composer-card], right
 *     after its trigger button (previousElementSibling is the trigger).
 *   - 0.1.5: the menu is portaled to document.body; the seat trigger keeps it
 *     linked via aria-controls="<menu id>".
 *
 * Both shapes keep aria-haspopup="menu" on the trigger and a stable id on the
 * popover, so the controls link is the primary route and the sibling check
 * stays as the fallback. Only 0.1.5+ is supported, but the finder stays
 * shape-tolerant so a host rendering either shape keeps working.
 *
 * 0.2.0-rc.2 additionally swaps the popover's role to `group` while the model
 * list pane is open (ModelSelect.tsx:484 -- its own list box takes
 * role="menu"), so a role-only probe would lose the menu for as long as the
 * user browses models. The popover is therefore identified by its ROLE plus
 * its menu rows.
 */

// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { findModelMenu } from '../src/client/index.js'

/** A seat trigger wired to a menu id, as the host renders it. */
function trigger(menuId: string | null): HTMLButtonElement {
  const button = document.createElement('button')
  button.setAttribute('aria-haspopup', 'menu')
  button.setAttribute('aria-expanded', 'true')
  if (menuId !== null) button.setAttribute('aria-controls', menuId)
  return button
}

function menu(id: string): HTMLElement {
  const el = document.createElement('div')
  el.id = id
  el.setAttribute('role', 'menu')
  return el
}

/** The drilled-in model list pane as 0.2.0-rc.2 renders it. */
function modelPane(id: string): HTMLElement {
  const el = document.createElement('div')
  el.id = id
  el.setAttribute('role', 'group')
  el.innerHTML = `
    <div class="searchRow"><input role="searchbox" /></div>
    <div role="menu">
      <section role="group" aria-labelledby="g-ds">
        <div id="g-ds">DeepSeek</div>
        <button role="menuitemradio" aria-checked="true">DeepSeek V4.1 Flash</button>
      </section>
    </div>`
  return el
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('findModelMenu', () => {
  it('finds the portaled 0.1.5 menu via the trigger aria-controls link', () => {
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    card.appendChild(trigger('tid-menu'))
    document.body.appendChild(card)
    const portaled = menu('tid-menu')
    document.body.appendChild(portaled)

    expect(findModelMenu()).toBe(portaled)
  })

  it('finds the pre-portal inline menu next to its trigger', () => {
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    const inline = menu('tid-menu')
    card.appendChild(trigger('tid-menu'))
    card.appendChild(inline)
    document.body.appendChild(card)

    expect(findModelMenu()).toBe(inline)
  })

  it('returns undefined when the linked menu id names nothing', () => {
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    card.appendChild(trigger('ghost-menu'))
    document.body.appendChild(card)

    expect(findModelMenu()).toBeUndefined()
  })

  it('ignores a linked element that is not a menu', () => {
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    card.appendChild(trigger('not-a-menu'))
    document.body.appendChild(card)
    const impostor = document.createElement('div')
    impostor.id = 'not-a-menu'
    document.body.appendChild(impostor)

    expect(findModelMenu()).toBeUndefined()
  })

  it('finds the 0.2.0-rc.2 model pane, whose popover carries role="group"', () => {
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    card.appendChild(trigger('tid-menu'))
    document.body.appendChild(card)
    const portaled = modelPane('tid-menu')
    document.body.appendChild(portaled)

    expect(findModelMenu()).toBe(portaled)
  })

  it('ignores a linked group that carries no menu rows', () => {
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    card.appendChild(trigger('grouped'))
    document.body.appendChild(card)
    const impostor = document.createElement('div')
    impostor.id = 'grouped'
    impostor.setAttribute('role', 'group')
    impostor.innerHTML = '<div><button>Not a model row</button></div>'
    document.body.appendChild(impostor)

    expect(findModelMenu()).toBeUndefined()
  })

  it('finds the pre-portal inline model pane rendered as a group', () => {
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    const inline = modelPane('tid-menu')
    // No aria-controls: this is the sibling-check route, not the controls link.
    card.appendChild(trigger(null))
    card.appendChild(inline)
    document.body.appendChild(card)

    expect(findModelMenu()).toBe(inline)
  })

  it('ignores another composer seat whose inline menu has the same shape', () => {
    // The worktree picker is a second seat in the same composer and renders
    // through the same Menu primitive: an inline popover right after an
    // aria-haspopup="menu" trigger. Shape alone cannot tell the two apart, so
    // the slot wrapper decides -- the model seat's slider must not land in the
    // branch picker.
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    const foreign = document.createElement('div')
    foreign.setAttribute('data-slot', 'conversation.input.left')
    const wrapper = document.createElement('span')
    wrapper.appendChild(trigger(null))
    const branchMenu = menu('branch-menu')
    branchMenu.innerHTML = '<button role="menuitem">main</button>'
    wrapper.appendChild(branchMenu)
    foreign.appendChild(wrapper)
    card.appendChild(foreign)
    document.body.appendChild(card)

    expect(findModelMenu()).toBeUndefined()
  })

  it('prefers the model seat when two inline menus are open at once', () => {
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    const foreign = document.createElement('div')
    foreign.setAttribute('data-slot', 'conversation.input.left')
    const branchWrapper = document.createElement('span')
    branchWrapper.appendChild(trigger(null))
    const branchMenu = menu('branch-menu')
    branchMenu.innerHTML = '<button role="menuitem">main</button>'
    branchWrapper.appendChild(branchMenu)
    foreign.appendChild(branchWrapper)
    card.appendChild(foreign)
    const seat = document.createElement('div')
    seat.setAttribute('data-slot', 'conversation.input.model')
    const seatWrapper = document.createElement('div')
    seatWrapper.appendChild(trigger(null))
    const model = menu('model-menu')
    model.innerHTML = '<button role="menuitemradio">DeepSeek V4.1 Flash</button>'
    seatWrapper.appendChild(model)
    seat.appendChild(seatWrapper)
    card.appendChild(seat)
    document.body.appendChild(card)

    expect(findModelMenu()).toBe(model)
  })

  it('returns undefined when no menu is open', () => {
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    const closed = trigger(null)
    closed.removeAttribute('aria-expanded')
    card.appendChild(closed)
    document.body.appendChild(card)

    expect(findModelMenu()).toBeUndefined()
  })
})
