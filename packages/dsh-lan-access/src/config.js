/**
 * Configuration surface of dsh-lan-access.
 *
 * Three fields, and deliberately no password field beside them. A
 * `role('secret')` field would be redacted from every settings *read* while its
 * plaintext still landed in the profile's `cordis.patch.yml` — which
 * `dsh-config-manager` exports verbatim into every config-sync snapshot. The
 * password is therefore the credential {@link PASSWORD_REF}, and this schema
 * only carries what is not a secret.
 *
 * The root is `.volatile()`, so the Loader hands `apply` a single live
 * `{ get() }` reference and commits settings edits in place instead of
 * remounting the plugin. That is what lets a port change take effect without a
 * DSH restart: the host half listens for `loader/volatile-update` and rebinds.
 *
 * @module @logictan/dsh-lan-access/config
 */
import z from '@deepseek-ai/schemastery';

/**
 * Loader entry id this plugin's form is keyed by.
 *
 * `dsh-settings` keys a form by profile entry id, which the repo convention
 * pins to the host half's `export const name`; the browser half passes the same
 * string to `configForms.get`. A mismatch does not throw — the card simply
 * binds a form that is never served.
 */
export const ENTRY_ID = 'dsh-lan-access';

/** Credential reference holding this plugin's own access password. */
export const PASSWORD_REF = 'DSH_LAN_ACCESS_PASSWORD';

/** Port the plugin listens on when the user has not chosen one. */
export const DEFAULT_PORT = 10000;

/**
 * Path of the read-only status route on the HOST listener.
 *
 * Deliberately not under `/api`: the Host/Origin fence is a `/api` prefix route,
 * and an exact route registered by a plugin is matched before it. A non-`/api`
 * path therefore never sees the fence, which is why the handler consults
 * `connection.requestRejection` itself (the same shape `dsh-macos-theme` uses).
 */
export const STATUS_PATH = '/dsh-lan-access/status';

/** Authentication modes, in the order the settings form lists them. */
export const AUTH_MODES = ['password', 'none'];

/**
 * Configuration of the `dsh-lan-access` entry.
 *
 * `enabled` exists so the feature can be switched off without uninstalling the
 * plugin or editing the profile: with it off the plugin binds nothing, and the
 * host's own access paths are untouched.
 */
export const Config = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .comment('启用局域网访问')
      .description('关闭后本插件不监听任何端口，宿主自身的访问方式不受影响。'),
    port: z
      .natural()
      .min(1)
      .max(65535)
      .default(DEFAULT_PORT)
      .comment('访问端口')
      .description('局域网与本机 127.0.0.1 共用这一个端口。与宿主自己的端口不同时，两套访问方式互不影响。'),
    auth: z
      .union(AUTH_MODES.map((mode) => z.const(mode)))
      .default('password')
      .comment('鉴权方式')
      .description(
        'password：先输入本插件设置的密码（存于凭据库）；none：直接进入。两种方式下浏览器都会自动取得宿主自己的登录态，无需再复制宿主的 token。',
      ),
  })
  .volatile();

/**
 * Read the live settings as plain, already-validated values.
 *
 * Defaults are applied here rather than trusted from the schema: a value that
 * arrived through config sync, a hand edit of `cordis.patch.yml`, or a card
 * write that omitted a key all reach `get()` as whatever was stored.
 *
 * @param raw - the raw `config.get()` value, of any shape.
 * @returns `{enabled, port, auth}`, every field usable as-is.
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const port = Number(source.port);
  const usablePort = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
  return {
    enabled: source.enabled !== false,
    port: usablePort,
    auth: AUTH_MODES.includes(source.auth) ? source.auth : 'password',
  };
}

/**
 * Whether two settings objects would produce the same listener.
 *
 * Used by the host half to decide whether a settings edit needs a rebind. `auth`
 * is deliberately not part of the comparison: the gate reads it per request, so
 * switching modes must not drop the connections of everyone already inside.
 *
 * @param a - one settings object.
 * @param b - the other.
 * @returns true when both describe the same listener.
 */
export function sameListener(a, b) {
  return a.enabled === b.enabled && a.port === b.port;
}
