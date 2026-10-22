/**
 * The Modal account pool: one credential whose value is the JSON list of accounts.
 *
 * **Why one credential instead of one per account.** A credential reference
 * cannot be enumerated — `ctx.credentials` resolves refs by name and offers no
 * "list every ref starting with MODAL_H3_" — so a pool spread over N refs would
 * be invisible to the plugin: it could not report which accounts exist, could
 * not pick the least-busy one, and could not tell a new device which names to
 * expect. One ref holding a JSON array is enumerable by construction, and it is
 * the same value the DSH-Novel generation kept in a git-tracked file, so that
 * file can be pasted in unchanged.
 *
 * The value never touches disk on the JS side: it is read per call and handed
 * to the runner as `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` in the child
 * environment. No `~/.modal.toml` is written, which is what makes a machine
 * with three pooled accounts leak nothing at rest.
 *
 * @module @logictan/dsh-modal-h3/pool
 */

/** Credential reference holding the whole pool. */
export const ACCOUNTS_REF = 'MODAL_H3_ACCOUNTS';

/** Environment variables the Modal client reads when no profile file exists. */
export const TOKEN_ID_ENV = 'MODAL_TOKEN_ID';
export const TOKEN_SECRET_ENV = 'MODAL_TOKEN_SECRET';

/**
 * Parse and validate the pool credential value.
 *
 * The accepted shape is `{"tokens": [...]}`, byte-compatible with the pool file
 * this plugin replaces. Validation is total and reports every problem rather
 * than the first, because the value is hand-pasted JSON: a one-error-at-a-time
 * message would make a three-typo paste a three-round trip.
 *
 * @param text - the credential value, possibly empty or malformed.
 * @returns `{accounts, errors}`; `errors` is empty exactly when `accounts` is usable.
 */
export function parseAccountPool(text) {
  const errors = [];
  if (typeof text !== 'string' || text.trim() === '') {
    return { accounts: [], errors: ['the credential is empty; expected {"tokens": [...]}'] };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { accounts: [], errors: [`not valid JSON: ${error.message}`] };
  }
  const tokens = Array.isArray(parsed) ? parsed : parsed?.tokens;
  if (!Array.isArray(tokens)) {
    return { accounts: [], errors: ['no tokens array; expected {"tokens": [{name, token_id, token_secret}, ...]}'] };
  }
  if (tokens.length === 0) {
    return { accounts: [], errors: ['tokens is empty; at least one account is required'] };
  }
  const accounts = [];
  const seen = new Set();
  tokens.forEach((entry, index) => {
    const at = `tokens[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${at} is not an object`);
      return;
    }
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const tokenId = typeof entry.token_id === 'string' ? entry.token_id.trim() : '';
    const tokenSecret = typeof entry.token_secret === 'string' ? entry.token_secret.trim() : '';
    if (name === '') errors.push(`${at}.name is missing or empty`);
    else if (seen.has(name)) errors.push(`${at}.name is duplicated: ${name}`);
    if (tokenId === '') errors.push(`${at}.token_id is missing or empty`);
    if (tokenSecret === '') errors.push(`${at}.token_secret is missing or empty`);
    if (name === '' || tokenId === '' || tokenSecret === '' || seen.has(name)) return;
    seen.add(name);
    const credit = entry.monthly_credit_usd;
    accounts.push({
      name,
      tokenId,
      tokenSecret,
      ...(typeof credit === 'number' && Number.isFinite(credit) ? { monthlyCreditUsd: credit } : {}),
    });
  });
  return { accounts, errors };
}

/**
 * Choose the account for one submission.
 *
 * Least-busy first, then least-recently-used. The worker class is
 * `max_containers=1`, so an account can only run one generation at a time:
 * spreading submissions is not an optimisation, it is the only way to get
 * parallel width at all, and the pool size is the ceiling.
 *
 * Accounts that recently refused a submission are skipped, because a dead
 * account is not merely "busy": Modal rejects the call outright, so choosing it
 * again costs a failed generation every time and never makes progress. The
 * failure is recorded by the caller (see `src/tasks.js`) and cleared by the next
 * successful submit or sync, so a topped-up account comes back on its own.
 * When EVERY account is refusing, the filter is dropped: a real error from Modal
 * is more useful than "no account available", and a pool that stays broken must
 * still say why.
 *
 * @param accounts - validated pool entries.
 * @param options.requested - account name the caller asked for, if any.
 * @param options.inFlight - `Map<accountName, count>` of unfinished tasks.
 * @param options.lastUsedAt - `Map<accountName, epochMs>` of last submission.
 * @param options.refusing - names that recently failed a submission.
 * @returns the chosen account.
 * @throws when `requested` names no pooled account, or the pool is empty.
 */
export function selectAccount(accounts, options = {}) {
  const { requested, inFlight = new Map(), lastUsedAt = new Map(), refusing = new Set() } = options;
  if (accounts.length === 0) throw new Error('the account pool is empty; set the MODAL_H3_ACCOUNTS credential first');
  if (requested !== undefined && requested !== null && String(requested).trim() !== '') {
    const wanted = String(requested).trim();
    const found = accounts.find((account) => account.name === wanted);
    if (found === undefined) {
      const known = accounts.map((account) => account.name).join(', ');
      throw new Error(`account ${wanted} is not in the pool; pooled accounts: ${known}`);
    }
    return found;
  }
  const usable = accounts.filter((account) => !refusing.has(account.name));
  const candidates = usable.length > 0 ? usable : accounts;
  const score = (account) => inFlight.get(account.name) ?? 0;
  const used = (account) => lastUsedAt.get(account.name) ?? 0;
  return [...candidates].sort((left, right) => score(left) - score(right) || used(left) - used(right))[0];
}

/**
 * Environment additions that authenticate one account without a profile file.
 *
 * The Modal client's precedence is env → `~/.modal.toml` → default profile, so
 * setting these two is sufficient AND overrides whatever the machine happens to
 * have configured. That override is intentional: a pooled account must be used
 * exactly as the pool says, never silently swapped for the developer's own.
 *
 * @param account - one validated pool entry.
 * @returns the environment overlay for the runner process.
 */
export function accountEnvironment(account) {
  return { [TOKEN_ID_ENV]: account.tokenId, [TOKEN_SECRET_ENV]: account.tokenSecret };
}
