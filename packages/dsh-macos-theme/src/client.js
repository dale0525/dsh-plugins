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
     * The shared settings-card component layer. Every plugin in this family
     * renders its configuration card from it, so the same control looks the same
     * in every plugin and both palettes come from the host's tokens.
     *
     * It resolves through the loader because this package's own client half has
     * no build step to bundle it: the module is registered by its own row in the
     * composed graph. `dsh.client.external` in `package.json` names it so the
     * module graph orders that row ahead of this one.
     */
    var UI = require('@logictan/dsh-plugins-shared-client')
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
     * Marks `body` with THIS DEVICE's resolved light/dark choice.
     *
     * The Host stores one `ui-theme.preference` for the whole installation and
     * bakes it into every index response's boot script, so a desktop on the LAN
     * and a phone opening the same Host would otherwise share one palette. This
     * attribute is the per-device override: it is set from `localStorage`, which
     * is per-browser, and the stylesheet re-points the dark token values on it.
     *
     * `data-ds-dark-theme` alone cannot do the job — the Host writes the active
     * palette INLINE on `body` (`ThemePresenter.apply`), and an inline
     * declaration outranks every selector. The dark token block therefore has to
     * carry `!important`, and this attribute has to be the thing that turns it
     * on, so a device can be dark while the Host's stored preference stays light.
     */
    var DEVICE_THEME_ATTR = 'data-dsh-device-theme'

    /** Per-browser store of the device's own choice: `'light'` or `'dark'`. */
    var DEVICE_THEME_KEY = 'dsh-macos-theme.device-theme'

    /**
     * The Host's own palette attribute, which the stylesheet's structural dark
     * rules already key on. A device override must drive this too, or the theme
     * would paint dark tokens onto light-mode geometry.
     */
    var HOST_DARK_ATTR = 'data-ds-dark-theme'

    /** Read this device's stored choice, or `null` when it has none. */
    function deviceTheme() {
      try {
        var stored = window.localStorage.getItem(DEVICE_THEME_KEY)
        return stored === 'light' || stored === 'dark' ? stored : null
      } catch (error) {
        /* Private-mode Safari throws on read; the Host's preference then wins,
           which is the same state as a device that never chose. */
        return null
      }
    }

    /**
     * Project the device's choice onto the document.
     *
     * Two attributes move together on purpose: {@link DEVICE_THEME_ATTR} turns on
     * the `!important` dark token block (beating the Host's inline values), and
     * {@link HOST_DARK_ATTR} turns on the structural dark rules this stylesheet
     * already carries. Setting only the first would leave light geometry under
     * dark tokens.
     *
     * With no stored choice the Host's boot script and presenter stay the single
     * source, which is what keeps a device that never touched this setting
     * exactly as it was — and what lets a device that DID touch it go back.
     */
    /**
     * Write an attribute only when it actually changes.
     *
     * `setAttribute` records a mutation even when the value is identical, so an
     * unguarded write from inside the attribute observer would re-enter it
     * forever. `toggleAttribute`/`removeAttribute` are already no-ops in that
     * case; only the value-carrying attribute needs this guard.
     */
    function setAttributeIfChanged(element, name, value) {
      if (element.getAttribute(name) !== value) element.setAttribute(name, value)
    }

    function applyDeviceTheme() {
      var choice = deviceTheme()
      if (choice === null) {
        document.body.removeAttribute(DEVICE_THEME_ATTR)
        /* Restoring means re-deriving the Host's own answer, not just dropping
           our attribute: this function set the palette attribute too, and
           leaving it behind would keep a device in dark after the user picked
           "follow the Host" while the Host preference is light. */
        document.body.toggleAttribute(HOST_DARK_ATTR, hostWantsDark())
        return
      }
      setAttributeIfChanged(document.body, DEVICE_THEME_ATTR, choice)
      document.body.toggleAttribute(HOST_DARK_ATTR, choice === 'dark')
    }

    /**
     * What the Host's own preference resolves to on this device right now.
     *
     * The presenter publishes the preference (not the resolved scheme) as
     * `data-ds-theme-source`, exactly as the boot script does, so `system` has to
     * be resolved here through `prefers-color-scheme` — the same rule
     * `ThemePresenter` applies. An unreadable value falls back to light, matching
     * the Host's default preference.
     */
    function hostWantsDark() {
      var source = document.documentElement.getAttribute('data-ds-theme-source')
      if (source === 'system') {
        return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
      }
      return source === 'dark'
    }

    /**
     * Keep the device override applied across the Host's own writes.
     *
     * `ThemePresenter.apply` runs on every `theme/change` (a settings edit, a
     * `prefers-color-scheme` flip) and re-sets the Host palette attribute from
     * the stored preference, which would silently undo a device override. An
     * observer on those two attributes re-asserts the device choice instead of
     * fighting it from a timer.
     *
     * `applyDeviceTheme` is idempotent and cheap, so the callback just calls it:
     * a conditional version had to re-derive the same three cases inline and got
     * the "no device choice" case wrong. Writing an attribute from inside the
     * callback re-enters it once more, and the second pass settles because the
     * document already holds the values the function writes.
     */
    function installDeviceTheme(ctx) {
      applyDeviceTheme()
      var observer = new MutationObserver(applyDeviceTheme)
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: [HOST_DARK_ATTR, DEVICE_THEME_ATTR],
      })
      /* A `prefers-color-scheme` flip only matters when the Host follows the
         system; re-derive so a device on "follow the Host" tracks it. */
      var media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
      if (media !== null) media.addEventListener('change', applyDeviceTheme)
      /* Another tab on the same browser is the same device: follow it. */
      function onStorage(event) {
        if (event.key !== DEVICE_THEME_KEY && event.key !== null) return
        applyDeviceTheme()
      }
      window.addEventListener('storage', onStorage)
      return function () {
        observer.disconnect()
        if (media !== null) media.removeEventListener('change', applyDeviceTheme)
        window.removeEventListener('storage', onStorage)
        document.body.removeAttribute(DEVICE_THEME_ATTR)
      }
    }

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

    /**
     * The row's configuration card on the Plugins page.
     *
     * The card is the shared `ConfigForm`, so the schema is the whole settings
     * surface: the field, its label and its description all come from
     * `Config.replaceChatFont`, and this half owns no control, no write path and
     * no copy. Adding a second setting is one line in the schema.
     *
     * The `summary` view stays a one-liner. The Host renders that view inside the
     * detail header's description paragraph, so a block-level summary there would
     * be markup nested in a `<p>`.
     */
    function MacosThemeSettingsCard(props) {
      if (props.view === 'summary') return '字体'
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(UI.ConfigForm, {
          namespace: NS,
          form: props.scope,
          describe: props.describe,
          title: '聊天字体',
        }),
        React.createElement(DeviceThemeCard, null),
      )
    }

    /**
     * This device's light/dark choice, in the plugin's own settings surface.
     *
     * Deliberately NOT a schema field: a schema field is written to the Host's
     * user-settings document, which is one value for the whole installation and
     * therefore the very thing this control exists to override. Keeping it in
     * the browser's `localStorage` is what makes the choice per-device, so it
     * cannot be expressed as `Config` and is drawn here instead.
     */
    function DeviceThemeCard() {
      var state = React.useState(deviceTheme())
      var value = state[0]
      var setValue = state[1]
      var choice = value === null ? 'host' : value
      function choose(next) {
        try {
          if (next === 'host') window.localStorage.removeItem(DEVICE_THEME_KEY)
          else window.localStorage.setItem(DEVICE_THEME_KEY, next)
        } catch (error) {
          /* Storage refused (private mode): the control still re-reads below, so
             it settles back to the Host's preference instead of lying. */
        }
        applyDeviceTheme()
        setValue(next === 'host' ? null : next)
      }
      return React.createElement(
        UI.SettingsCard,
        {
          title: '本机外观',
          description:
            '只影响这台设备。宿主下发的亮暗是全局的，这里可以覆盖它；选「跟随宿主」即恢复全局设置。',
        },
        React.createElement(UI.Segmented, {
          value: choice,
          label: '本机外观',
          options: [
            { value: 'host', label: '跟随宿主' },
            { value: 'light', label: '亮色' },
            { value: 'dark', label: '暗色' },
          ],
          onChange: choose,
        }),
      )
    }

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
     * The host setting this theme takes over: 工作步骤展示 / Work details.
     *
     * The user asked for one behaviour in every mode, so the mode selector is not
     * offered any more. It is hidden rather than removed: the row is rendered by
     * React from the host's own settings schema, and deleting the node React owns
     * makes its next reconciliation throw. A row is identified by its title text,
     * which is the only thing that tells the five rows of that section apart —
     * they carry no attribute of their own, and all five share one hashed class.
     *
     * The string is the host's own `settings.transcript.title`, hard-coded in both
     * locales because this half has no access to the chat bundle's dictionary and
     * the theme ships no dictionary of its own for a key it does not own.
     */
    var TRANSCRIPT_SETTING_TITLES = ['工作步骤展示', 'Work details']

    /** Marks a hidden settings row, so the stylesheet can take it out of the flow. */
    var HIDE_ATTR = 'data-dsh-hide'

    /** The slot the host fills with the general settings rows. */
    var PANEL = "[data-slot='settings.general.item']"

    /**
     * Hide the transcript-mode row whenever the settings dialog is showing.
     *
     * The sweep is keyed on the dialog rather than run on every mutation: the chat
     * streams a DOM change per token, and the settings section is only mounted
     * while the dialog is open. So the observer does one cheap check per batch and
     * only walks the section's rows once a dialog has appeared.
     */
    function hideTranscriptSettingRow() {
      var panel = null

      function sweep() {
        if (panel === null || !panel.isConnected) panel = document.querySelector(PANEL)
        if (panel === null) return
        var rows = panel.children
        for (var i = 0; i < rows.length; i++) {
          var title = rows[i].querySelector("[class*='_title']")
          if (title === null) continue
          var text = (title.textContent || '').trim()
          if (TRANSCRIPT_SETTING_TITLES.indexOf(text) < 0) continue
          rows[i].setAttribute(HIDE_ATTR, '')
        }
      }

      sweep()
      var observer = new MutationObserver(function (records) {
        if (panel !== null && panel.isConnected) {
          sweep()
          return
        }
        panel = null
        for (var r = 0; r < records.length; r++) {
          var added = records[r].addedNodes
          for (var n = 0; n < added.length; n++) {
            var node = added[n]
            if (node.nodeType !== 1 || typeof node.querySelector !== 'function') continue
            /* The dialog arrives as one pre-built subtree, so the row slot is a
               descendant of the added node and never appears in `addedNodes`. */
            if (node.matches(PANEL) || node.querySelector(PANEL) === null) continue
            sweep()
            return
          }
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return function () {
        observer.disconnect()
      }
    }

    /**
     * The card header: one line, the turn's own state, and the tool's own result.
     *
     * Three things the stylesheet cannot do, all on the same element:
     *
     * 1. The header shows the first half of the host's title and nothing else. The
     *    host composes `label + " · " + detail`, where the detail is the live
     *    command or the reasoning text (measured: `正在运行命令 · Probe header label
     *    DOM tree exactly`). The design keeps only the label, and truncation cannot
     *    express that: the tail starts after a separator whose position CSS cannot
     *    know.
     * 2. A finished tool says so. The host's live label falls back to `正在分析请求`
     *    whenever no tool is running, so a card whose last row is a returned command
     *    announced the next analysis instead of the result the user just watched
     *    arrive — reported as "刚运行完命令，不是应该显示执行了命令吗".
     * 3. The card stays lit while its turn runs. ACTIVE is a turn, not a row: the
     *    user's report was the card dimming the moment its last command returned,
     *    mid-turn. The turn state is the host's running hint, which is a SIBLING of
     *    the card (measured: turn 8, the hint's previous sibling is the card), so it
     *    is mirrored onto the card for the stylesheet to paint.
     *
     * The visible label is one text node inside `span._text_*`, and the host
     * re-renders it on every streamed token, so this is an observer rather than a
     * one-off pass. A node already carrying the wanted text is left alone, which is
     * what keeps the observer from feeding itself.
     */
    var TURN_LIVE_ATTR = 'data-dsh-turn-live'

    /**
     * The label span, relative to a card: the header is the card's first child.
     *
     * `:scope >` is load-bearing. Without it the selector also matches every ROW,
     * whose own first child is its label: measured, a finished turn's card read
     * `执行了命令 执行了命令` on each row, because the rows were rewritten along with
     * the header. The header is the card's direct first child and nothing deeper.
     */
    var CARD_LABEL = ":scope > div:first-child span[class*='_text_']"

    /** The host's own `message.turnProcess.separator`, hard-coded as its titles are. */
    var TITLE_SEPARATOR = ' · '

    /**
     * The host's finished labels (`message.turnProcess.done.*`), in both locales
     * because this half has no access to the chat bundle's dictionary — the same
     * arrangement as the settings row above.
     *
     * Only the tools whose wording differs from their row variant are listed; every
     * other row falls through to the variant table below, so no tool can end up
     * with no label.
     */
    var DONE_BY_TOOL = {
      read_image: ['已读取图片', 'Read images'],
      web_search: ['已搜索网页', 'Searched the web'],
      web_fetch: ['已访问网页', 'Visited web pages'],
      subagent: ['已协调子智能体', 'Coordinated subagents'],
      ask_user_question: ['向用户提出了问题', 'Asked questions'],
      todo_write: ['更新了计划', 'Updated the plan'],
      create_goal: ['更新了计划', 'Updated the plan'],
      update_goal: ['更新了计划', 'Updated the plan'],
    }

    /** The host's row variants, as `data-variant` spells them. */
    var DONE_BY_VARIANT = {
      read: ['已读取文件', 'Read files'],
      search: ['已搜索代码', 'Searched code'],
      write: ['已写入文件', 'Wrote files'],
      edit: ['修改了文件', 'Edited files'],
      bash: ['执行了命令', 'Ran commands'],
      code: ['运行了代码', 'Ran code'],
      others: ['已调用工具', 'Called tools'],
    }

    function syncCardHeaderLabels() {
      function isChinese() {
        return (document.documentElement.lang || 'zh').toLowerCase().indexOf('zh') === 0
      }

      /** The card of the turn that is still running, or null. */
      function liveTurnCard() {
        var hint = document.querySelector('[data-chat-running]')
        var card = hint === null ? null : hint.previousElementSibling
        return card !== null && card.hasAttribute('data-step-process') ? card : null
      }

      function trimTextNode(node) {
        var text = node.nodeValue
        var at = text === null ? -1 : text.indexOf(TITLE_SEPARATOR)
        if (at < 0) return
        node.nodeValue = text.slice(0, at)
      }

      function writeText(span, text) {
        var only = span.firstChild
        if (only !== null && only === span.lastChild && only.nodeType === 3) {
          if (only.nodeValue !== text) only.nodeValue = text
          return
        }
        if (span.textContent !== text) span.textContent = text
      }

      /**
       * The label for a card whose turn is still running, or null to keep the
       * host's own.
       *
       * A row that is still running or still streaming keeps the host's wording —
       * 正在运行命令, 准备读取文件 — because that is exactly what is happening. So
       * does a finished reasoning row: the model really is analysing again, which is
       * what the host says. Only a finished TOOL has a result to report, and its
       * result is what the card announces until the next row appears.
       */
      function runningLabel(card) {
        var rows = card.querySelectorAll('[data-step-process-content] [data-variant]')
        var row = rows.length === 0 ? null : rows[rows.length - 1]
        if (row === null) return null
        if (row.matches("[data-state='running']") || row.querySelector('[data-shimmer]') !== null) return null
        var tool = row.getAttribute('data-tool')
        var pair =
          (tool !== null && DONE_BY_TOOL[tool]) || DONE_BY_VARIANT[row.getAttribute('data-variant')]
        if (pair === undefined) return null
        return isChinese() ? pair[0] : pair[1]
      }

      function syncCard(card, live) {
        if (card === live) {
          if (!card.hasAttribute(TURN_LIVE_ATTR)) card.setAttribute(TURN_LIVE_ATTR, '')
        } else if (card.hasAttribute(TURN_LIVE_ATTR)) {
          card.removeAttribute(TURN_LIVE_ATTR)
        }
        var result = card === live ? runningLabel(card) : null
        var labels = card.querySelectorAll(CARD_LABEL)
        for (var i = 0; i < labels.length; i++) {
          /* The ghost the shimmer paints behind the label carries the same text in
             an attribute; the stylesheet hides it, and it is skipped here so only
             the text a reader can see is rewritten. */
          if (labels[i].hasAttribute('data-shimmer-text')) continue
          /* Only the running turn's card is rewritten. Every other card keeps the
             host's own title — the folded summary of a finished turn, and the done
             label the host gives a group the turn has moved past (measured after a
             reload: 执行了命令, with nothing of ours on it). The host re-renders a
             card as it stops being the newest, so nothing written here survives it. */
          if (result !== null) {
            writeText(labels[i], result)
            continue
          }
          var nodes = labels[i].childNodes
          for (var n = 0; n < nodes.length; n++) {
            if (nodes[n].nodeType === 3) trimTextNode(nodes[n])
          }
        }
      }

      /**
       * The beat played when one step of the running turn finishes.
       *
       * A row is "in flight" while it is executing (`data-state="running"`) or
       * while its text is still streaming (a `[data-shimmer]` inside it). Watching
       * for a row that WAS in flight and no longer is, rather than counting, is what
       * makes one command finishing distinguishable from the next one starting in
       * the same batch — a count would stay level and no beat would play.
       *
       * Only the running turn's card beats. A history card is finished by
       * definition, and animating it would put a pulse on the screen every time the
       * transcript scrolled a card into view.
       */
      var BEAT_ATTR = 'data-dsh-step-done'
      var BEAT_MS = 720
      var inFlight = new WeakMap()
      var beatTimers = new WeakMap()
      /* The same timers again in a Set, because a `WeakMap` cannot be walked and the
         effect's teardown has to clear every one of them. */
      var pendingBeats = new Set()

      function flightOf(card) {
        var rows = card.querySelectorAll('[data-step-process-content] [data-variant]')
        var set = []
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].matches("[data-state='running']") || rows[i].querySelector('[data-shimmer]') !== null) {
            set.push(rows[i])
          }
        }
        return set
      }

      function beat(card) {
        var pending = beatTimers.get(card)
        if (pending !== undefined) {
          clearTimeout(pending)
          pendingBeats.delete(pending)
        }
        /* Taken off first: a beat that fires while the previous one is still playing
           has to restart the animation, and re-setting an attribute that is already
           there does not. */
        card.removeAttribute(BEAT_ATTR)
        void card.offsetWidth
        card.setAttribute(BEAT_ATTR, '')
        var timer = setTimeout(function () {
          card.removeAttribute(BEAT_ATTR)
          beatTimers.delete(card)
          pendingBeats.delete(timer)
        }, BEAT_MS)
        beatTimers.set(card, timer)
        pendingBeats.add(timer)
      }

      function watchSteps(card, live) {
        var now = flightOf(card)
        var was = inFlight.get(card)
        inFlight.set(card, now)
        if (was === undefined || card !== live) return
        for (var i = 0; i < was.length; i++) {
          if (now.indexOf(was[i]) >= 0 || !was[i].isConnected) continue
          beat(card)
          return
        }
      }

      function sweep() {
        var live = liveTurnCard()
        var cards = document.querySelectorAll('[data-step-process]')
        for (var i = 0; i < cards.length; i++) {
          syncCard(cards[i], live)
          watchSteps(cards[i], live)
        }
      }

      sweep()
      var observer = new MutationObserver(function (records) {
        var live = liveTurnCard()
        var full = false
        for (var r = 0; r < records.length; r++) {
          var record = records[r]
          if (record.type === 'characterData') {
            var parent = record.target.parentNode
            var card = parent === null ? null : parent.closest('[data-step-process]')
            if (card !== null) {
              syncCard(card, live)
              watchSteps(card, live)
            }
            continue
          }
          /* A changed attribute can change which card is live, or which row is the
             newest, so those re-read the whole flow; so does anything leaving the
             tree, which is how the turn ends. An added node only needs its own card
             resynced, and that is the common case: a streamed token. */
          if (record.type === 'attributes' || record.removedNodes.length > 0) {
            full = true
            continue
          }
          for (var a = 0; a < record.addedNodes.length; a++) {
            var node = record.addedNodes[a]
            var element = node.nodeType === 1 ? node : node.parentElement
            var owner = element === null || element === undefined ? null : element.closest('[data-step-process]')
            if (owner !== null) {
              syncCard(owner, live)
              watchSteps(owner, live)
            } else full = true
          }
        }
        if (full) sweep()
      })
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributeFilter: ['data-state', 'data-shimmer', 'hidden', 'data-chat-running'],
      })
      return function () {
        observer.disconnect()
        pendingBeats.forEach(function (timer) {
          clearTimeout(timer)
        })
        pendingBeats.clear()
      }
    }

    /**
     * The conversation View is pinned to 对话.
     *
     * The strip is hidden by the stylesheet, so the View cannot be changed by hand,
     * and the last way in was a tool row's 「查看」 button: it calls the host's
     * `inspectCall`, which opens the trajectory View with a focus target. Measured
     * live, one click on a `read` row flipped the strip to 轨迹, replaced the
     * conversation with the trajectory ledger, and persisted `view: "trajectory"` in
     * the session's store — with no control left that leads back. The affordance is
     * hidden in CSS; this is the repair for a selection that is already wrong (a
     * preference persisted before that rule shipped, or any path the host adds
     * later). The View state belongs to the host, so the repair drives the chat tab
     * the user would have clicked.
     */
    function keepChatView() {
      var scheduled = false
      var timer = 0

      /** The two labels the host ships for the chat View, per locale. */
      function chatTab() {
        var tabs = document.querySelectorAll("[data-conversation-tabs] [role='tab']")
        for (var i = 0; i < tabs.length; i++) {
          var label = (tabs[i].textContent || '').trim()
          if (label === '对话' || label === 'Chat') return tabs[i]
        }
        return null
      }

      function repair() {
        scheduled = false
        var chat = chatTab()
        if (chat === null) return
        if (chat.getAttribute('aria-selected') === 'true') return
        chat.click()
      }

      /* Coalesced and deferred: the observer runs on every mutation of a streaming
         conversation, and the click is a host state update that must not arrive
         while the host is still committing the switch. */
      function schedule() {
        if (scheduled) return
        scheduled = true
        timer = setTimeout(repair, 0)
      }

      schedule()
      var observer = new MutationObserver(schedule)
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-selected'],
      })
      return function () {
        observer.disconnect()
        clearTimeout(timer)
      }
    }

    /**
     * The stat dock under the composer: four figures, each behind its own glyph.
     *
     * The host composes two sentences — `12 轮 902 步 · 175 tok/s` and
     * `108M tok · 缓存命中 97%` — out of `stats.counts`, `message.tokensPerSecond`,
     * `message.turnUsage.count` and `stats.cacheHit`. The design keeps the figures
     * alone, so every word in those four templates has to go, and the stylesheet
     * cannot do it: a template's words sit at positions CSS cannot name.
     *
     * The figures are recovered from the rendered text rather than from the host's
     * numbers, which this half never sees. That is also why no locale table is
     * needed: 「12 轮 902 步」 and `12 turns 902 steps` both END in the step count,
     * so "the last number in the string" reads both.
     *
     * Nothing here rebuilds a node. React owns this subtree and re-renders it on
     * every streamed token, so a substituted span would be reconciled against a
     * detached node and the dock would freeze on a stale figure — the rewrite writes
     * `nodeValue` in place and keeps the host's own element (the `·` separator, now
     * carrying the second glyph) exactly where React put it.
     */

    /** Exponents for the K/M/B suffixes a token figure can carry. */
    var UNIT_SCALE = { '': 0, K: 3, M: 6, B: 9 }

    /** The first number in a string, decimals included, or null. */
    function firstFigure(text) {
      var match = /\d+(?:\.\d+)?/.exec(text)
      return match === null ? null : match[0]
    }

    /** The last number in a string, decimals included, or null. */
    function lastFigure(text) {
      var found = text.match(/\d+(?:\.\d+)?/g)
      return found === null ? null : found[found.length - 1]
    }

    /** K/M/B at one decimal below a hundred, whole numbers above it. */
    function formatTokens(value) {
      if (value < 1e3) return String(Math.round(value))
      var unit = value < 1e6 ? 'K' : value < 1e9 ? 'M' : 'B'
      var scaled = value / Math.pow(10, UNIT_SCALE[unit])
      return (scaled >= 100 ? String(Math.round(scaled)) : String(Math.round(scaled * 10) / 10)) + unit
    }

    /**
     * A token figure with its unit, rescaled to K/M/B.
     *
     * The host's own formatter stops at M, so a session past a billion reads `1000M`
     * there; the figure is re-derived from the value it printed, which is what gives
     * the B step any meaning at all.
     */
    function usageFigure(text) {
      var match = /^\s*(\d+(?:\.\d+)?)\s*([KMB]?)/.exec(text)
      if (match === null) return null
      var value = parseFloat(match[1])
      if (!isFinite(value)) return null
      return formatTokens(value * Math.pow(10, UNIT_SCALE[match[2]]))
    }

    /** The percentage in a cache-hit label, sign kept, or null. */
    function percentFigure(text) {
      var match = /(\d+(?:\.\d+)?)\s*%/.exec(text)
      return match === null ? null : match[1] + '%'
    }

    function rewriteComposerStats() {
      var PILL = '[data-composer-dock] [data-composer-stat]'

      function writeFigure(node, text) {
        if (node.nodeValue !== text) node.nodeValue = text
      }

      /**
       * Reduce one pill. The detailed layout is `figure · figure`; compact renders
       * the second figure alone, and the meter is a different component, so both of
       * those — and any shape this does not recognise — are left as the host drew
       * them rather than guessed at.
       */
      function sync(pill) {
        var label = pill.querySelector("[class*='_label']")
        if (label === null) return
        var nodes = label.childNodes
        if (nodes.length !== 3) return
        var sep = nodes[1]
        if (sep.nodeType !== 1) return
        var head = nodes[0].nodeType === 3 ? nodes[0].nodeValue : null
        var tail = nodes[2].nodeType === 3 ? nodes[2].nodeValue : null
        if (head === null || tail === null) return
        var stat = pill.getAttribute('data-composer-stat')
        var first = null
        var second = null
        if (stat === 'activity') {
          first = lastFigure(head)
          var speed = firstFigure(tail)
          second = speed === null ? null : speed + '/s'
        } else if (stat === 'usage') {
          first = usageFigure(head)
          second = percentFigure(tail)
        }
        if (first === null || second === null) return
        writeFigure(nodes[0], first)
        writeFigure(nodes[2], '(' + second + ')')
      }

      function sweep() {
        var pills = document.querySelectorAll(PILL)
        for (var i = 0; i < pills.length; i++) sync(pills[i])
      }

      /* Coalesced like the two effects above it: the observer sees every mutation of
         a streaming conversation, and the pass queries the document. A write that
         changes nothing is skipped by `writeFigure`, so the pass cannot feed itself,
         but a scheduled one is still the difference between a few passes per frame
         and one per token. */
      var scheduled = false
      var timer = 0
      function schedule() {
        if (scheduled) return
        scheduled = true
        timer = setTimeout(function () {
          scheduled = false
          sweep()
        }, 0)
      }

      sweep()
      var observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      return function () {
        observer.disconnect()
        clearTimeout(timer)
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

      ctx.effect(installDeviceTheme, 'macos-theme: device theme')

      ctx.effect(hideTranscriptSettingRow, 'macos-theme: transcript setting row')

      ctx.effect(syncCardHeaderLabels, 'macos-theme: card header labels')

      ctx.effect(keepChatView, 'macos-theme: chat view')

      ctx.effect(rewriteComposerStats, 'macos-theme: composer stats')

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
        /* The schema mirror. `ConfigForm` reads the field list from it, so the
           card needs it alongside the form; both are requested here rather than
           in `inject` for the reason in the comment above. */
        var describe = scoped.configForms.describe()

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
                  return { scope: scope, describe: describe }
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
