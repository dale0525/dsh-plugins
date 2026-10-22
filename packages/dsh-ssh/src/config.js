/**
 * Configuration surface of dsh-ssh: the host table.
 *
 * One field, `hosts`, and deliberately no password field beside it. A
 * `role('secret')` field would be redacted from every settings *read* while its
 * plaintext still landed in the profile's `cordis.patch.yml` — which
 * `dsh-config-manager` exports verbatim into every config-sync snapshot. The
 * password is therefore a credential (`$DSH_HOME/.credentials.yaml`), one
 * reference per host, and this schema only carries what is not a secret.
 *
 * The root is `.volatile()`, so the Loader hands `apply` a single live
 * `{ get() }` reference and commits settings edits in place instead of
 * remounting the plugin. That also makes the whole `hosts` array writable
 * through one path op (`['hosts']`), which is what the settings card uses: the
 * shared form has no control for an array of objects, so the card stages the
 * table itself and writes it back in one edit.
 *
 * @module @logictan/dsh-ssh/config
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
export const ENTRY_ID = 'dsh-ssh';

/** Prefix of every password reference this plugin owns. */
export const PASSWORD_REF_PREFIX = 'SSH_PASSWORD_';

/**
 * Grammar of a host alias.
 *
 * Aliases are what the model types to address a host, so they must survive
 * being written inside a sentence: no spaces, no shell metacharacters, and no
 * leading punctuation. Case-insensitive for addressing (see
 * {@link findHost}) because `nas` and `NAS` are the same machine to a human.
 */
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Longest alias accepted; long enough for `personal-cloud-unraid`, short enough to read. */
const ALIAS_MAX = 64;

/**
 * Configuration of the `dsh-ssh` entry.
 *
 * `alias` is required and unique (case-insensitively): it is the only handle the
 * tools accept, so a host without one could never be reached. `host`, `username`
 * and `port` are the three facts a password login needs; anything else (keys,
 * jump hosts, agent forwarding) is out of scope by design.
 */
export const Config = z
  .object({
    hosts: z
      .array(
        z.object({
          alias: z.string().default(''),
          host: z.string().default(''),
          port: z.number().default(22),
          username: z.string().default(''),
        }),
      )
      .default([])
      .comment('SSH 主机')
      .description('每台主机一个 alias（工具里用它指代主机）+ host / port / username。密码在下方单独设置，存于凭据库。'),
  })
  .volatile();

/**
 * Validate one alias.
 *
 * @param alias - candidate alias.
 * @returns an error message, or `undefined` when the alias is usable.
 */
export function aliasError(alias) {
  if (typeof alias !== 'string' || alias === '') return 'alias 不能为空';
  if (!ALIAS_PATTERN.test(alias)) return `alias "${alias}" 只能用字母、数字、点、连字符、下划线，且以字母或数字开头`;
  if (alias.length > ALIAS_MAX) return `alias "${alias}" 超过 ${ALIAS_MAX} 个字符`;
  return undefined;
}

/**
 * Derive the credential reference holding one host's password.
 *
 * The credential grammar is `/^[A-Za-z_][A-Za-z0-9_]*$/`, so the alias has to be
 * folded into that alphabet. The fold is not injective — `a-b` and `a.b` both
 * become `A_B` — which is why {@link normalizeHosts} refuses a table where two
 * aliases share a reference: they would silently share one password.
 *
 * @param alias - the host alias.
 * @returns the credential reference.
 */
export function passwordRef(alias) {
  const folded = String(alias).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return PASSWORD_REF_PREFIX + folded;
}

/**
 * Normalize the configured host table into the shape the tools read.
 *
 * Defaults are applied here rather than trusted from the schema: a value that
 * arrived through config sync, a hand edit of `cordis.patch.yml`, or a card
 * write that omitted a key all reach `get()` as whatever was stored.
 *
 * @param value - the raw `hosts` array, of any shape.
 * @returns `{hosts, errors}`; `hosts` holds only the usable rows.
 */
export function normalizeHosts(value) {
  const errors = [];
  const hosts = [];
  const byAlias = new Map();
  const byRef = new Map();

  for (const [index, entry] of (Array.isArray(value) ? value : []).entries()) {
    const at = `hosts[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${at} 不是对象`);
      continue;
    }
    const alias = typeof entry.alias === 'string' ? entry.alias.trim() : '';
    const host = typeof entry.host === 'string' ? entry.host.trim() : '';
    const username = typeof entry.username === 'string' ? entry.username.trim() : '';
    const rawPort = entry.port;
    const port = rawPort === undefined || rawPort === null || rawPort === '' ? 22 : Number(rawPort);

    const badAlias = aliasError(alias);
    if (badAlias !== undefined) {
      errors.push(`${at}: ${badAlias}`);
      continue;
    }
    if (host === '') {
      errors.push(`${at} (${alias}): host 不能为空`);
      continue;
    }
    if (username === '') {
      errors.push(`${at} (${alias}): username 不能为空`);
      continue;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(`${at} (${alias}): port 必须是 1-65535 的整数`);
      continue;
    }

    const key = alias.toLowerCase();
    if (byAlias.has(key)) {
      errors.push(`${at}: alias "${alias}" 与 hosts[${byAlias.get(key)}] 重复`);
      continue;
    }
    const ref = passwordRef(alias);
    if (byRef.has(ref)) {
      errors.push(`${at}: alias "${alias}" 与 "${byRef.get(ref)}" 折叠到同一个密码引用 ${ref}，会共用密码`);
      continue;
    }

    byAlias.set(key, index);
    byRef.set(ref, alias);
    hosts.push({ alias, host, port, username, passwordRef: ref });
  }

  return { hosts, errors };
}

/**
 * Look one host up by alias.
 *
 * @param hosts - the normalized table.
 * @param alias - the alias the caller typed, in any case.
 * @returns the host, or `undefined`.
 */
export function findHost(hosts, alias) {
  const key = typeof alias === 'string' ? alias.trim().toLowerCase() : '';
  return hosts.find((entry) => entry.alias.toLowerCase() === key);
}
