/**
 * @logictan/dsh-plugins-shared-client — host half.
 *
 * The package is a browser-only component library. Its host half exists for one
 * mechanical reason: `dsh-client-modules` only puts a package into the browser
 * module table when a real loader entry names it (`reconcilePackage` is driven
 * by loader entries, not by the dependency graph). A package that is merely a
 * `dependencies` entry of its consumers is never reconciled, so a consumer's
 * `require('@logictan/dsh-plugins-shared-client')` fails with
 * `missed the module table`. The row is what makes the client bundle loadable.
 *
 * The row also obliges this half to be a plugin: the loader resolves one from
 * these exports, and `Registry.resolve` accepts only a function or an object
 * with an `apply` method — a module exporting neither fails the row with
 * `invalid plugin, expect function or object with an "apply" method`. Every one
 * of the host's own ~150 rows exports `apply` or a `default` for that reason.
 *
 * `apply` has nothing to do here: everything this package ships runs in the
 * browser, and the browser half installs its own stylesheet at activation. So
 * it is deliberately empty rather than reaching for host state it does not
 * need. The `name` is not decoration — it is the row id, which the loader
 * rejects outright on collision.
 *
 * @module @logictan/dsh-plugins-shared-client
 */

/**
 * Cordis companion plugin name. Must equal this package's `cordis.patch.yml`
 * row id (`plugins-shared-client`).
 */
export const name = 'plugins-shared-client'

/** No host-side behaviour: see the module doc comment. */
export function apply(): void {}
