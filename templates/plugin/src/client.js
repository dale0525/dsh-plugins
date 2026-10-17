/**
 * @logictan/<name> — browser half.
 *
 * This file is already in the client module loader's protocol: it is not a
 * module, imports nothing, and calls `window.__ModuleLoader__.load` at top
 * level. `build.mjs` copies it to `lib/client.js` verbatim, which is why
 * `package.json` exports `./client` at that path. That is why it is `.js` and
 * not `.tsx` — the same shape every other plugin in this repository uses.
 *
 * The whole settings surface is the wiring below: ask the settings service for
 * this plugin's namespace form and the shared describe face, then register
 * `UI.ConfigForm` for the `page` view and `UI.ConfigSummary` for the `summary`
 * view. No CSS, no field markup, no control choice — the schema in the host
 * half is the only place a configuration item is declared.
 */
window.__ModuleLoader__.load({
  id: '@logictan/<name>',
  factory: function (require) {
    var React = require('react')
    var UI = require('@logictan/dsh-plugins-shared-client')

    /** Settings namespace. Must equal the namespace this plugin's host half registers. */
    var NS = '<name>'

    /**
     * Packages whose Plugins-page rows should carry this plugin's card.
     *
     * A row is keyed by `<package name>#<row id>`, and this plugin reaches a
     * profile in one of two shapes — as a dependency of this repository's
     * aggregate bundle, or installed on its own. Both keys are registered; the
     * one whose bundle is not installed never renders, because the page
     * dispatches only the keys its own bundles declare.
     */
    var BUNDLE_NAMES = ['@logictan/dsh-plugins-all', '@logictan/<name>']

    /**
     * One configuration entry, for whichever view the page asks for.
     *
     * `configForm` / `configDescribe` are injected under these names rather
     * than as `form`, deliberately: the page passes its own `form` owner prop,
     * owner props are spread last, and owner wins — so an injected `form` would
     * be silently shadowed by the page's frozen `{ state, mutate }` snapshot,
     * which carries no `subscribe` and would freeze the card at its first
     * render.
     */
    function SettingsEntry(props) {
      if (props.view === 'summary') {
        return React.createElement(UI.ConfigSummary, {
          namespace: NS,
          form: props.configForm,
          describe: props.configDescribe,
        })
      }
      return React.createElement(UI.ConfigForm, {
        namespace: NS,
        form: props.configForm,
        describe: props.configDescribe,
        title: '配置',
      })
    }

    /**
     * `configForms` and `slots` are requested through a nested `inject` rather
     * than this plugin's own `inject` list: a plugin whose `inject` cannot be
     * satisfied never activates, so naming them there would turn "this
     * deployment has no settings UI" into "the whole plugin silently
     * disappears". Nested, an absent service costs only the settings card.
     */
    function apply(ctx) {
      ctx.inject(['configForms', 'slots'], function (scoped) {
        var form = scoped.configForms.get(NS)
        var describe = scoped.configForms.describe()

        BUNDLE_NAMES.forEach(function (bundle) {
          scoped.slots.inject('plugins.row.config', function () {
            return scoped.slots.register(
              {
                name: 'plugins.row.config',
                key: bundle + '#' + NS,
                inject: function () {
                  return { configForm: form, configDescribe: describe }
                },
              },
              SettingsEntry,
            )
          })
        })
      })
    }

    return {
      name: '@logictan/<name>',
      inject: [],
      apply: apply,
    }
  },
})
