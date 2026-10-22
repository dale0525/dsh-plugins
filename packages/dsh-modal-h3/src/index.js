/**
 * dsh-modal-h3 — host half.
 *
 * MiniMax H3 Ref2VA video generation on Modal, as six `mcp__modal_h3__*` tools.
 * Replaces the DSH-Novel CLI + skill that used to own this route: the same
 * contract, the same Modal App, the same accounts, but packaged as a service any
 * project can call.
 *
 * Four decisions are load-bearing:
 *
 *  - **The account pool is one credential, not configuration.** `MODAL_H3_ACCOUNTS`
 *    holds the whole `{"tokens": [...]}` list and is resolved on every call. A
 *    `role('secret')` config field would have written the tokens into the
 *    profile's `cordis.patch.yml` in plaintext — the exact leak the previous
 *    generation of this pipeline had. As a credential it travels with config
 *    sync's credentials section and never appears in a patch row.
 *
 *  - **No token ever reaches disk.** The pool is handed to the child process as
 *    `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`, so `~/.modal.toml` is neither
 *    written nor consulted. That also means the pool overrides a developer's own
 *    Modal login rather than silently borrowing it.
 *
 *  - **"Deployed" is decided by a probe, not by a local record.** The previous
 *    implementation only accepted accounts whose local state file said `synced`,
 *    so a fresh device could not use an account that was already deployed —
 *    `Function.from_name(...).hydrate()` and `Cls.from_name(...).hydrate()`
 *    answer that question for any account, with no deploy and no local history.
 *    `bootstrap` is never used as a health check: it re-hashes ~59 GB.
 *
 *  - **Submit and poll are separate, so the pool is the parallelism.** Each
 *    account's worker is `max_containers=1`, so one generation per account at a
 *    time; `wait_for_completion: false` lets the model keep several accounts
 *    busy at once instead of serialising on one tool call.
 *
 * @module @logictan/dsh-modal-h3
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { ACCOUNTS_REF } from './pool.js';
import { SECTION_NAME, SECTION_ORDER, H3_GUIDANCE } from './guidance.js';
import { createService } from './tasks.js';
import {
  accountsStatusTool,
  accountsSyncTool,
  cancelTaskTool,
  generateVideoTool,
  getTaskTool,
  listTasksTool,
} from './tools.js';

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'modal-h3';

/**
 * Package root, derived from this module's own URL.
 *
 * `lib/index.js` sits one level below the root that holds `app/`, so the runner
 * script and the vendored contract resolve no matter where the package was
 * installed — including inside a profile's `node_modules`.
 */
export const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Credential reference holding the account pool; re-exported for the browser half's documentation. */
export { ACCOUNTS_REF };

/**
 * Register the video tools and announce the route's contract.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  /**
   * Resolve the pool credential value on every call.
   *
   * Read per call rather than captured: an account can be added, rotated or
   * removed from the Plugins page while the process runs, and a captured value
   * would keep submitting with a revoked token until the next restart.
   *
   * @returns the raw credential value, or `''` when unset.
   */
  const resolveAccounts = async () => {
    const credentials = ctx.get('credentials');
    if (credentials === undefined) return '';
    const resolved = await credentials.resolve(ACCOUNTS_REF);
    return resolved?.value ?? '';
  };

  const service = createService({
    appDir: APP_DIR,
    dshHome: resolveDshHome(),
    resolveAccounts,
  });

  // `credentials` is a REQUIRED dependency of this block: without it the pool
  // cannot be read, so there is nothing to register. Waiting on it here (rather
  // than reading it once in `apply`) is what keeps a slow provider from turning
  // into "the tools never appeared".
  ctx.inject(['tools', 'credentials'], (toolsCtx) => {
    const tools = toolsCtx.get('tools');
    // `defineTool` is not decoration: it turns the descriptors' per-property
    // spec maps into the JSON Schema the model is shown, and validates both the
    // arguments and the returned value against them. Handing a raw descriptor to
    // `tools.register` would pass the spec map through verbatim and show the
    // model a malformed schema.
    const definitions = [
      defineTool({ ...generateVideoTool(), execute: (args, exec) => service.generate(args, exec) }),
      defineTool({ ...getTaskTool(), execute: (args, exec) => service.get(args, exec) }),
      defineTool({ ...listTasksTool(), execute: (args) => service.list(args) }),
      defineTool({ ...cancelTaskTool(), execute: (args, exec) => service.cancel(args, exec) }),
      defineTool({ ...accountsStatusTool(), execute: (args, exec) => service.accountsStatus(args, exec) }),
      defineTool({ ...accountsSyncTool(), execute: (args, exec) => service.accountsSync(args, exec) }),
    ];
    toolsCtx.effect(() => {
      const disposers = definitions.map((definition) => tools.register(definition));
      toolsCtx.logger.info(`modal-h3: registered ${disposers.length} mcp__modal_h3__* tools`);
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'modal-h3: video generation tools');

    // ----------------------------------------------------------- guidance
    // Inside this block, and read through `get` rather than `inject`, for two
    // different reasons. Inside, because the section tells the model these tools
    // exist — announcing a route whose registration was skipped is worse than
    // silence. Through `get`, because a declared `systemPrompt` dependency would
    // make a host without one lose the tools as well.
    const systemPrompt = toolsCtx.get('systemPrompt');
    if (systemPrompt === undefined || systemPrompt === null) {
      toolsCtx.logger.warn('modal-h3: the systemPrompt service is unavailable; the route contract was not announced.');
      return;
    }
    toolsCtx.effect(
      () =>
        systemPrompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          text: H3_GUIDANCE,
        }),
      'modal-h3: route contract',
    );
  });
}
