/**
 * dsh-macos-theme — browser half.
 *
 * Re-themes DeepSeek Harness as a macOS-native workbench: a floating
 * translucent window sitting on a sky-blue desktop gradient, with the three
 * columns reading as distinct surfaces (sidebar and file rail on the recessed
 * tint, the conversation on paper).
 *
 * Two layers, because the design needs both:
 *
 *  1. **Tokens** (`ctx.theme.overrideTokens`) carry every *colour*. One layer
 *     keyed by this package id, each entry `{ light, dark }`, so both palettes
 *     ship from a single registration and the user's light/dark/system
 *     preference keeps working. `overrideTokens` is also the only persistence
 *     path a third-party theme has: `setTheme(id)` stores a preference only for
 *     the built-in ids, while a token layer stacks over whichever base theme is
 *     active and survives reloads.
 *  2. **CSS** carries what tokens cannot express: the desktop gradient and
 *     window chrome on `body`/frame, the per-column surfaces, and the
 *     component geometry (radius, height, padding) of the sidebar, header,
 *     composer and user bubble.
 *
 * Anchors are deliberately limited to build-stable hooks. Class names carry a
 * build-path-derived hash (`Wcetya_*` locally, `A55DgG_*` in CI), so they are
 * never used. What is used instead:
 *
 *  - `[data-slot="..."]` — the layout's own slot contract.
 *  - `:has(> [data-slot="..."])` — resolves a `display:contents` slot wrapper
 *    to the real styled box that owns it (the wrapper itself has no box).
 *  - `[data-conversation-header-leading]`, `[data-composer-card]`,
 *    `[data-chat-flow-kind]`, `[data-conversation-scroll]` — component-level
 *    data attributes.
 *  - `[class*="_name"]` — only where nothing else exists. The hash prefix
 *    varies per build but the CSS-module local name after the underscore comes
 *    from the source file and is stable.
 */

window.__ModuleLoader__.load({
  id: '@logictan/dsh-macos-theme',
  factory: function (require) {
    /**
     * React is required lazily through the loader's `require`, exactly as the
     * host's own client halves do. It is needed only by the settings card, so
     * the theme itself keeps working on a build that ships no React.
     */
    var React = require('react')
    /**
     * Palette. Light comes from the approved macOS light design; dark exists to
     * supply the dark colour tokens (the dark screen was drawn for exactly that
     * purpose, so its component geometry is not mirrored here).
     */
    var TOKENS = {
      /* ---- Surfaces -------------------------------------------------- */
      // Shared by the frame, the centre column and the conversation root, so it
      // is the *paper* value; the frame and the rails are re-painted in CSS.
      '--dsw-alias-bg-base': { light: '#FFFFFF', dark: '#0B101D' },
      '--dsw-alias-bg-layer-1': { light: '#FFFFFF', dark: '#0F1626' },
      '--dsw-alias-bg-layer-2': { light: '#F8FAFC', dark: '#121927' },
      '--dsw-alias-bg-layer-3': { light: '#F1F5F9', dark: '#151D2E' },
      '--dsw-alias-bg-overlay': { light: '#E2E8F0', dark: '#1E293B' },
      '--dsw-alias-bg-module-platform': { light: '#F1F5F9', dark: '#151D2E' },
      '--dsw-alias-bg-multi-select': { light: '#F1F5F9', dark: '#121927' },
      '--dsw-alias-bg-document-preview': { light: '#F1F5F9', dark: '#0B101D' },
      '--dsw-alias-bg-skeleton': { light: 'rgba(15,23,42,0.04)', dark: 'rgba(255,255,255,0.06)' },
      '--dsw-alias-settings-card-fill': { light: '#FFFFFF', dark: '#0F1626' },
      '--dsw-specific-sidebar-fill': { light: '#F8FAFC', dark: '#0F1626' },
      '--dsw-specific-menu': { light: 'rgba(255,255,255,0.86)', dark: 'rgba(18,25,39,0.86)' },

      /* ---- Text ------------------------------------------------------ */
      '--dsw-alias-label-primary': { light: '#0F172A', dark: '#E2E8F0' },
      '--dsw-alias-label-secondary': { light: '#475569', dark: '#94A3B8' },
      '--dsw-alias-label-tertiary': { light: '#94A3B8', dark: '#64748B' },
      '--dsw-alias-label-caption': { light: '#94A3B8', dark: '#64748B' },
      '--dsw-alias-label-dimmed': { light: '#CBD5E1', dark: '#475569' },
      '--dsw-alias-label-primary-dimmed': { light: '#1E293B', dark: '#CBD5E1' },
      '--dsw-alias-label-primary-foreground': { light: '#FFFFFF', dark: '#0F172A' },
      '--dsw-alias-label-document-preview': { light: '#475569', dark: '#94A3B8' },
      '--dsw-alias-menu-icon': { light: '#475569', dark: '#CBD5E1' },

      /* ---- Lines ----------------------------------------------------- */
      '--dsw-alias-border-l1': { light: 'rgba(15,23,42,0.04)', dark: 'rgba(255,255,255,0.06)' },
      '--dsw-alias-border-l2': { light: 'rgba(15,23,42,0.06)', dark: 'rgba(255,255,255,0.08)' },
      '--dsw-alias-border-l3': { light: 'rgba(15,23,42,0.08)', dark: 'rgba(255,255,255,0.07)' },
      '--dsw-alias-border-l4': { light: 'rgba(15,23,42,0.12)', dark: 'rgba(255,255,255,0.12)' },
      '--dsw-alias-settings-card-stroke': { light: 'rgba(15,23,42,0.08)', dark: 'rgba(255,255,255,0.07)' },

      /* ---- Interaction ---------------------------------------------- */
      '--dsw-alias-interactive-bg-hover': { light: 'rgba(15,23,42,0.04)', dark: 'rgba(255,255,255,0.05)' },
      '--dsw-alias-interactive-bg-active': { light: 'rgba(15,23,42,0.06)', dark: 'rgba(255,255,255,0.08)' },
      '--dsw-alias-interactive-bg-hover-solid': { light: '#F1F5F9', dark: '#151D2E' },
      '--dsw-alias-interactive-bg-hover-accent': { light: 'rgba(37,99,235,0.10)', dark: 'rgba(96,165,250,0.16)' },
      '--dsw-alias-interactive-bg-hover-danger': { light: 'rgba(239,68,68,0.08)', dark: 'rgba(239,68,68,0.14)' },
      '--dsw-alias-button-elevated-fill': { light: '#FFFFFF', dark: '#151D2E' },
      '--dsw-alias-button-floating-fill': { light: '#FFFFFF', dark: '#0F1626' },
      '--dsw-alias-button-floating-hover': { light: '#F1F5F9', dark: '#151D2E' },
      '--dsw-alias-button-primary-fill': { light: '#2563EB', dark: '#3B82F6' },
      '--dsw-alias-button-primary-hover': { light: '#1D4ED8', dark: '#60A5FA' },
      '--dsw-alias-button-primary-dimmed': { light: '#EFF6FF', dark: '#1E293B' },
      '--dsw-alias-button-info-fill': { light: '#2563EB', dark: '#3B82F6' },
      '--dsw-alias-button-info-hover': { light: '#1D4ED8', dark: '#60A5FA' },
      '--dsw-alias-button-contrast-fill': { light: '#1E293B', dark: '#E2E8F0' },
      '--dsw-alias-button-ghost-active-fill': { light: '#F1F5F9', dark: '#151D2E' },
      '--dsw-alias-button-ghost-active-hover': { light: '#E2E8F0', dark: '#1E293B' },
      '--dsw-alias-button-ghost-active-border': { light: '#CBD5E1', dark: '#475569' },

      /* ---- Brand / state -------------------------------------------- */
      '--dsw-alias-brand-primary': { light: '#2563EB', dark: '#3B82F6' },
      '--dsw-alias-brand-primary-invert': { light: '#2563EB', dark: '#3B82F6' },
      '--dsw-alias-brand-text': { light: '#0F172A', dark: '#E2E8F0' },
      '--dsw-alias-link': { light: '#2563EB', dark: '#60A5FA' },
      '--dsw-alias-state-business-primary': { light: '#2563EB', dark: '#60A5FA' },
      '--dsw-alias-state-business-tertiary': { light: '#EFF6FF', dark: '#1E293B' },
      '--dsw-alias-state-success-primary': { light: '#10B981', dark: '#10B981' },
      '--dsw-alias-state-success-secondary': { light: '#34D399', dark: '#34D399' },
      '--dsw-alias-state-success-tertiary': { light: '#ECFDF5', dark: '#12291F' },
      '--dsw-alias-state-warn-primary': { light: '#F59E0B', dark: '#F59E0B' },
      '--dsw-alias-state-warn-secondary': { light: '#FBBF24', dark: '#FBBF24' },
      '--dsw-alias-state-warn-tertiary': { light: '#FFFBEB', dark: '#2A2113' },
      '--dsw-alias-state-error-primary': { light: '#EF4444', dark: '#EF4444' },
      '--dsw-alias-state-error-secondary': { light: '#F87171', dark: '#F87171' },
      '--dsw-alias-state-idle-primary': { light: '#CBD5E1', dark: '#475569' },

      /* ---- Conversation --------------------------------------------- */
      '--dsw-specific-bubble': { light: '#1E293B', dark: '#1E293B' },
      '--dsw-alias-label-deep-diving': { light: '#4338CA', dark: '#A5B4FC' },
      '--dsw-alias-label-deep-diving-shimmer': { light: '#6366F1', dark: '#818CF8' },
      '--dsw-alias-markdown-code-block': { light: '#F8FAFC', dark: '#0A0E17' },
      '--dsw-alias-markdown-code-block-banner': { light: '#F1F5F9', dark: '#121927' },
      '--dsw-alias-markdown-inline-code': { light: '#F1F5F9', dark: '#151D2E' },
      '--dsw-alias-markdown-tag': { light: '#F1F5F9', dark: '#151D2E' },
      '--dsw-alias-markdown-placeholder': { light: '#F8FAFC', dark: '#151D2E' },
      '--dsw-alias-markdown-citation': { light: '#EFF6FF', dark: '#1E293B' },
      '--dsw-alias-markdown-code-segment-selected': { light: '#FFFFFF', dark: '#151D2E' },
      '--dsw-alias-markdown-code-segment-unselected': { light: '#F1F5F9', dark: '#0A0E17' },

      /* ---- Code diff ------------------------------------------------- */
      '--dsw-alias-code-diff-added': { light: 'rgba(16,185,129,0.08)', dark: 'rgba(16,185,129,0.12)' },
      '--dsw-alias-code-diff-deleted': { light: 'rgba(239,68,68,0.08)', dark: 'rgba(239,68,68,0.12)' },
      '--dsw-alias-file-diff-added-bg': { light: '#ECFDF5', dark: '#12291F' },
      '--dsw-alias-file-diff-added-gutter': { light: '#F0FDF4', dark: '#0E2018' },
      '--dsw-alias-file-diff-added-marker': { light: '#10B981', dark: '#34D399' },
      '--dsw-alias-file-diff-deleted-bg': { light: '#FEF2F2', dark: '#2A1517' },
      '--dsw-alias-file-diff-deleted-gutter': { light: '#FEF6F6', dark: '#221113' },
      '--dsw-alias-file-diff-deleted-marker': { light: '#EF4444', dark: '#F87171' },

      /* ---- Chrome ---------------------------------------------------- */
      '--dsw-alias-scrollbar-bg-l1': { light: '#E2E8F0', dark: '#1E293B' },
      '--dsw-alias-scrollbar-bg-l2': { light: '#CBD5E1', dark: '#334155' },
      '--dsw-alias-scrollbar-hover-l1': { light: '#CBD5E1', dark: '#334155' },
      '--dsw-alias-scrollbar-hover-l2': { light: '#94A3B8', dark: '#475569' },
      '--dsw-alias-tooltip-bg': { light: '#1E293B', dark: '#1E293B' },
      '--dsw-alias-toast-bg': { light: '#1E293B', dark: '#1E293B' },
      '--dsw-alias-menu-group-header-fill': { light: 'rgba(248,250,252,0.94)', dark: 'rgba(18,25,39,0.94)' },
      '--dsw-alias-turn-trigger-bg': { light: '#F8FAFC', dark: 'rgba(255,255,255,0.06)' },
      '--dsw-alias-turn-trigger-bg-hover': { light: 'rgba(15,23,42,0.04)', dark: 'rgba(255,255,255,0.10)' },
      '--dsw-alias-bg-mask-1': { light: 'rgba(15,23,42,0.24)', dark: 'rgba(0,0,0,0.50)' },
      '--dsw-alias-bg-mask-2': { light: 'rgba(15,23,42,0.12)', dark: 'rgba(0,0,0,0.20)' },
      '--dsw-alias-switch-thumb': { light: '#FFFFFF', dark: '#E2E8F0' },
      '--dsw-alias-onboarding-secondary-fill': { light: '#FFFFFF', dark: '#151D2E' },

      /* ---- Popups and hover feedback --------------------------------- *
       * Everything the host portals to `body` — dropdown menus, dialogs,
       * tooltips, the hover card — and every control that only shows itself on
       * hover reads its fill from this group. They were left at the host's
       * defaults, which is why the popups did not match the theme: the menu
       * surface in particular is a *translucent* fill (`#f8f9fa94` light /
       * `#43454a73` dark) painted behind a 40px blur, and the host's dark value
       * resolves to a neutral grey `rgba(67,69,74,0.45)` that has no relation to
       * this theme's slate. Overriding the fill AND the blur is what makes the
       * menu read as the same material as the rest of the chrome. */
      '--dsw-menu-surface-fill': { light: 'rgba(255,255,255,0.72)', dark: 'rgba(18,25,39,0.72)' },
      '--dsw-menu-backdrop-filter': { light: 'blur(24px) saturate(180%)', dark: 'blur(24px) saturate(180%)' },

      /* The elevation shadows are NOT here: the host declares them on
         `body, body *`, and a token override lands on `body` alone, so every
         portalled popup re-defined them back to the host's values. They are
         re-declared in CSS on the same universal selector instead — see section
         1b of `theme.css`. Only the stroke COLOUR can live here, because the
         host does not re-declare it per element. */
      '--dsw-elevation-stroke-color': { light: 'rgba(15,23,42,0.10)', dark: 'rgba(255,255,255,0.10)' },

      /* NOTE: `--dsw-hovercard-bg` is deliberately NOT themed. The host sets it
         on the hover-card element itself (`.card { --dsw-hovercard-bg: #2C2C2E }`)
         and paints that element from it, so a value inherited from `body` can
         never reach it — an override here is inert. The card is a dark
         tooltip-style surface whose text colours are hardcoded `#fff` /
         `#cfd3d6` in the workspace module, so re-pointing the fill at a light
         value would only make its own text unreadable. */

      /* Toolbar / icon hover. `--dsw-alias-interactive-bg-hover` already covers
         the generic case, but the toolbar and the expanded help button use their
         own tokens and stayed at the host's neutral grey. */
      '--dsw-alias-button-tool-bar-hover': {
        light: 'rgba(15,23,42,0.06)',
        dark: 'rgba(255,255,255,0.08)',
      },
      '--dsw-alias-bg-layer-4': { light: '#F1F5F9', dark: '#1E293B' },

      /* Keyboard-shortcut chips inside tooltips. */
      '--dsw-alias-tooltip-key-bg': {
        light: 'rgba(255,255,255,0.18)',
        dark: 'rgba(255,255,255,0.18)',
      },

      /* Dialog scrims blur their backdrop through this; `none` left the mask
         flat and made dialogs read as pasted-on rather than layered. */
      '--dsw-mask-blur': { light: 'blur(2px)', dark: 'blur(2px)' },

      /* Radius scale. The popups size themselves off these, and the host's
         defaults (8/12/16/28px) are a different shape language from this
         theme's; the panel value is the one that shows on dialogs. */
      '--dsw-radius-sm': { light: '8px', dark: '8px' },
      '--dsw-radius-md': { light: '10px', dark: '10px' },
      '--dsw-radius-lg': { light: '14px', dark: '14px' },
      '--dsw-radius-panel': { light: '20px', dark: '20px' },
    }

    /**
     * Structural CSS, compiled from `src/theme.css` at build time (Tailwind
     * `@apply` -> plain CSS) and inlined here by `build.mjs`. Editing this
     * string directly is pointless: it is regenerated on every build.
     */
    var CSS = __DSH_MACOS_THEME_CSS__

    /** Marks the injected style element so it is never mistaken for another plugin's. */
    var STYLE_ID = 'dsh-macos-theme'

    /**
     * The loader entry id of the HOST half, which is also this plugin's
     * `cordis.patch.yml` row id. The settings service keys configuration forms
     * by that id, so the browser half can only reach its own form by naming it.
     */
    var NS = 'macos-theme'

    /**
     * Marks `body` while the chat typeface replacement is switched OFF.
     *
     * The stylesheet keys the opt-out off this attribute rather than off a class
     * the browser half would have to add and remove per surface: the font rules
     * read `var(--dsh-chat-font, inherit)`, and the variable is defined only when
     * this attribute is absent, so one attribute flips every surface at once.
     */
    var NATIVE_FONT_ATTR = 'data-dsh-native-chat-font'

    /**
     * The bundles that can own this plugin's row: the aggregate carrier and the
     * package itself. Whichever one the user installed supplies the row id the
     * form is keyed by, so both are offered and the settings page matches on the
     * one that actually exists.
     */
    var BUNDLE_NAMES = ['@logictan/dsh-plugins-all', '@logictan/dsh-macos-theme']

    /** The schema-resolved section the Host last accepted. */
    function accepted(snapshot) {
      var layer = snapshot && snapshot.value
      return layer !== null && typeof layer === 'object' ? layer : {}
    }

    /** The raw user layer; a key's presence here is what marks it overridden. */
    function userLayer(snapshot) {
      var layer = snapshot && snapshot.user
      return layer !== null && typeof layer === 'object' ? layer : {}
    }

    /**
     * The row's configuration card on the Plugins page.
     *
     * `props.scope` is the form `apply` obtained for this entry from
     * `configForms.get(NS)`. The value is read through `useSyncExternalStore`
     * because the Host can change it from another surface (and reverts it when
     * the settings file is edited underneath), so a local `useState` copy would
     * go stale.
     */
    function MacosThemeSettingsCard(props) {
      var scope = props.scope

      var subscribe = React.useCallback(
        function (onChange) {
          return scope.subscribe(onChange)
        },
        [scope],
      )
      var getSnapshot = React.useCallback(
        function () {
          return scope.getSnapshot()
        },
        [scope],
      )
      var snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

      if (props.view === 'summary') return '字体'

      var value = accepted(snapshot)
      var writable = snapshot.writable === true
      var overridden = Object.prototype.hasOwnProperty.call(userLayer(snapshot), 'replaceChatFont')
      var on = value.replaceChatFont !== false

      /** Write the new value, or clear the override so the default applies again. */
      function set(next) {
        if (!writable) return
        if (next === undefined) scope.unset('replaceChatFont')
        else scope.set('replaceChatFont', next)
      }

      var children = [
        React.createElement('div', { key: 'heading', style: CARD_HEADING }, '聊天字体'),
        React.createElement(
          'div',
          { key: 'intro', style: CARD_HINT },
          '用插件自带的 Fira Code + 落霞孤鹜等宽替换对话、代码块与输入框的字体。字体随插件一起提供，' +
            '不依赖访问设备上装没装——关掉后恢复 DSH 原来的字体。',
        ),
        React.createElement(
          'label',
          { key: 'toggle', style: CARD_ROW },
          React.createElement('input', {
            type: 'checkbox',
            checked: on,
            disabled: !writable,
            onChange: function (event) {
              set(event.target.checked)
            },
          }),
          React.createElement('span', null, '替换字体'),
        ),
      ]

      if (overridden) {
        children.push(
          React.createElement(
            'button',
            {
              key: 'reset',
              type: 'button',
              disabled: !writable,
              style: CARD_RESET,
              onClick: function () {
                set(undefined)
              },
            },
            '恢复默认',
          ),
        )
      }

      return React.createElement('div', null, children)
    }

    var CARD_HEADING = { fontWeight: 600, marginBottom: '2px' }
    var CARD_HINT = { opacity: 0.7, marginBottom: '10px' }
    var CARD_ROW = { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }
    var CARD_RESET = { marginTop: '8px', cursor: 'pointer' }

    var LIST_PREFIX = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(.*)$/
    var TASK_BOX = /^\[([ xX])\](?:\s+|$)/

    /**
     * Next line's list prefix, or `null` when the line is not a list item and
     * `''` when the list should end here.
     *
     * `''` is the empty-item rule every editor shares: pressing Enter on a
     * marker with nothing after it leaves the list instead of adding another
     * empty bullet. Ordered items step the number, task items come back
     * unchecked, and the original indent is carried over verbatim.
     */
    function nextListPrefix(line) {
      var match = LIST_PREFIX.exec(line)
      if (!match) return null
      var body = match[6]
      var box = ''
      if (match[2]) {
        var task = TASK_BOX.exec(body)
        if (task) {
          box = '[ ] '
          body = body.slice(task[0].length)
        }
      }
      if (body === '') return ''
      if (match[2]) return match[1] + match[2] + match[5] + box
      return match[1] + (Number(match[3]) + 1) + match[4] + match[5]
    }

    /**
     * The visual line the caret sits on, split at the caret. A composer
     * paragraph holds every line as one block, so the line is only recoverable
     * by walking its `<br>`s — `innerText` would give the whole draft.
     */
    function caretLine(root, caret) {
      var block = caret.startContainer
      block = block.nodeType === 1 ? block : block.parentElement
      while (block && block.parentElement !== root) block = block.parentElement
      if (!block) return null
      var probe = document.createRange()
      probe.setStart(caret.startContainer, caret.startOffset)
      probe.collapse(true)
      var breaks = block.querySelectorAll('br')
      var open = null
      var close = null
      for (var i = 0; i < breaks.length; i++) {
        var side = probe.comparePoint(breaks[i], 0)
        if (side < 0) open = breaks[i]
        else if (side > 0 && !close) close = breaks[i]
      }
      var before = document.createRange()
      if (open) before.setStartAfter(open)
      else before.setStart(block, 0)
      before.setEnd(caret.startContainer, caret.startOffset)
      var after = document.createRange()
      after.setStart(caret.startContainer, caret.startOffset)
      if (close) after.setEndBefore(close)
      else after.setEnd(block, block.childNodes.length)
      return { block: block, before: before.toString(), after: after.toString() }
    }

    /**
     * Give the composer the platform keymap this theme's design calls for, on
     * top of the host's:
     *
     *  - Enter and Shift+Enter break the line, and continue the list when the
     *    caret is on a list item.
     *  - Ctrl/Cmd+Enter submits.
     *
     * That leaves the two line-break keys symmetric on every viewport, so
     * 移动端 needs no special case here — a touch keyboard has no Ctrl key, but
     * the send button is still there for it.
     *
     * The host's own Enter handler is reused rather than reimplemented: it is
     * the only thing that knows how to submit (it arbitrates the input-trigger
     * popups and respects the busy/queue state). It reads a plain `shiftKey`, so
     * replaying a synthetic event with the flag set delegates the line break and
     * with it cleared delegates the submit, instead of duplicating either. Our
     * listener runs in the capture phase so the host's handler only ever sees
     * the event we let through.
     */
    function installComposerKeys() {
      var replaying = false

      function replay(root, shiftKey) {
        replaying = true
        try {
          root.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              keyCode: 13,
              which: 13,
              shiftKey: shiftKey,
              bubbles: true,
              cancelable: true,
            }),
          )
        } finally {
          replaying = false
        }
      }

      /**
       * The marker is only "empty" when nothing follows it anywhere on the
       * line. Testing what precedes the caret instead would eat the marker of a
       * list item the caret sits inside, and of any line with a selection.
       */
      function pressBackspace(root, times) {
        for (var i = 0; i < times; i++) {
          root.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Backspace',
              code: 'Backspace',
              keyCode: 8,
              which: 8,
              bubbles: true,
              cancelable: true,
            }),
          )
        }
      }

      function onKeyDown(event) {
        if (replaying) return
        if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return
        if (event.altKey) return
        var root = event.target.closest('[data-composer-input]')
        if (!root) return
        /* An open suggestion popup owns Enter: the host uses it to accept the
           highlighted row, so leave the event alone. */
        var card = root.closest('[data-composer-card]')
        var popup = card && card.querySelector('[role="listbox"]')
        if (popup && popup.getClientRects().length > 0) return

        event.preventDefault()
        event.stopPropagation()

        /* Ctrl/Cmd+Enter is the only key that submits. Both plain Enter and
           Shift+Enter fall through to the line break below. */
        if (event.ctrlKey || event.metaKey) {
          replay(root, false)
          return
        }

        var selection = window.getSelection()
        var caret = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
        var at = caret ? caretLine(root, caret) : null
        /* A non-collapsed selection is being replaced, so it is never an empty
           item however the line reads. */
        var empty = at && caret.collapsed ? nextListPrefix(at.before + at.after) : null

        if (empty === '') {
          pressBackspace(root, at.before.length)
          return
        }

        replay(root, true)
        if (empty) document.execCommand('insertText', false, empty)
      }

      document.addEventListener('keydown', onKeyDown, true)
      return function () {
        document.removeEventListener('keydown', onKeyDown, true)
      }
    }

    /**
     * Apply the theme.
     *
     * The `theme` service is resolved through a nested `inject` rather than the
     * plugin's own `inject` list: a plugin whose `inject` cannot be satisfied
     * never activates, and on the client a single such entry fails the whole
     * boot audit. This way a build without the theme service still gets the
     * structural CSS.
     */
    function apply(ctx) {
      ctx.effect(function () {
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return function () {
          style.remove()
        }
      }, 'macos-theme: styles')

      ctx.effect(installComposerKeys, 'macos-theme: composer keys')

      ctx.inject(['theme'], function (scoped) {
        scoped.effect(function () {
          return scoped.theme.overrideTokens('@logictan/dsh-macos-theme', TOKENS)
        }, 'macos-theme: tokens')
      })

      /* `configForms` is requested through a nested `inject` for the same reason
         `theme` is: naming it in this plugin's own `inject` would turn "this
         deployment has no settings UI" into "the whole theme silently
         disappears". Nested, an absent service costs only the settings card. */
      ctx.inject(['configForms', 'slots'], function (scoped) {
        var scope = scoped.configForms.get(NS)

        scoped.effect(function () {
          var off = document.body.hasAttribute(NATIVE_FONT_ATTR)
          function sync() {
            var snapshot = scope.getSnapshot()
            if (snapshot.status !== 'ready') return
            var on = accepted(snapshot).replaceChatFont !== false
            document.body.toggleAttribute(NATIVE_FONT_ATTR, !on)
          }
          sync()
          var unsubscribe = scope.subscribe(sync)
          return function () {
            unsubscribe()
            document.body.toggleAttribute(NATIVE_FONT_ATTR, off)
          }
        }, 'macos-theme: chat font')

        BUNDLE_NAMES.forEach(function (bundle) {
          scoped.slots.inject('plugins.row.config', function () {
            return scoped.slots.register(
              {
                name: 'plugins.row.config',
                key: bundle + '#' + NS,
                inject: function () {
                  return { scope: scope, ctx: scoped }
                },
              },
              MacosThemeSettingsCard,
            )
          })
        })
      })
    }

    return {
      name: '@logictan/dsh-macos-theme',
      inject: [],
      apply: apply,
    }
  },
})
