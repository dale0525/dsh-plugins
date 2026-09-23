/**
 * The Cua Driver native runtime — the driver half.
 *
 * Absorbed from `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`,
 * which the profile used to mount as its own loader row. The desktop agent drives
 * the desktop exclusively by dispatching to the driver's `cua_driver_native__*`
 * tools through the tool registry, so those tools have to be published by
 * whoever owns the native handle; keeping that ownership in this package makes
 * the plugin self-contained instead of leaving it inert without a second row.
 *
 * What the absorption deliberately drops: the `computerUse` registration slot.
 * That slot existed to keep two computer-use providers from claiming the same
 * desktop, and the plugin is now the only publisher of these tools — a profile
 * that still mounts the old provider collides at `tools.register` with
 * `tool "cua_driver_native__click" is already registered`, which is the honest
 * signal that the old row must go.
 *
 * @module @logictan/dsh-desktop-agent/driver
 */
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';

/** Every published tool name carries this prefix; the loop's dispatch names depend on it. */
export const TOOL_PREFIX = 'cua_driver_native__';

/** DeepSeek's function-name alphabet and maximum length are protocol constants. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

/** The prompt section this runtime owns. */
const SECTION_NAME = 'computer-use:cua-driver-native';

const GUIDANCE = `Cua Driver native computer-use tools operate the host desktop. Discover the exact app and window, then get a fresh window snapshot before acting. Use element_token from that snapshot, or coordinates from its screenshot. A new snapshot of that window invalidates its earlier element tokens. Select either target or the legacy pid/window_id fields; do not combine them.

Prefer background delivery. A refusal does not authorize a foreground retry. Verify the requested outcome from fresh state after an action; a delivered click alone does not prove the outcome. After cancellation, inspect current state before retrying because completed input is not rolled back. Other sessions and applications may change the same desktop.

On macOS, cursor-overlay operations may return facility_unavailable even when screenshots and input work.`;

/**
 * Load the native SDK module.
 *
 * The one external boundary this plugin cannot validate away: the driver ships
 * as per-platform native binaries, so the module is imported at the point of use
 * rather than at module load, and a missing binary fails the mount with the
 * resolver's own message instead of a module-scope import error.
 *
 * @returns the SDK module namespace.
 */
function loadNativeSdk() {
  return import('@trycua/cua-driver');
}

/**
 * Read the tool catalog out of the driver's JSON.
 *
 * The SDK marshals this from a native process, so it is a real untrusted
 * boundary: a shape change must be reported here, not carried into tool
 * registration where it would surface as an unexplained schema error.
 *
 * @param value - the parsed catalog payload.
 * @returns the catalog entries.
 * @throws {Error} when the payload is not a catalog.
 */
function readCatalog(value) {
  const tools = value?.tools;
  if (!Array.isArray(tools)) throw new Error('Cua Driver returned no tool catalog.');
  return tools;
}

/**
 * Mount the native runtime on `ctx`.
 *
 * The effect is registered before the first `await` so that a failure anywhere
 * after the native handle exists still releases it, and so that unloading the
 * plugin mid-startup aborts the in-flight discovery call instead of waiting for
 * it to finish.
 *
 * @param ctx - the plugin context, providing `tools` and optionally `systemPrompt`.
 * @param loadSdk - the SDK loader; overridden by tests, which cannot import the native binaries.
 * @returns the effect disposer that tears the runtime down.
 * @throws {Error} when the SDK cannot be loaded, the catalog is unusable, or a registration is refused.
 */
export async function mountDriver(ctx, loadSdk = loadNativeSdk) {
  const lifetime = new AbortController();
  const pending = new Set();
  let driver;

  const dispose = ctx.effect(
    () => async () => {
      lifetime.abort();
      // Shutting the native handle down under an in-flight call would release
      // memory the call still reads, so settlement comes first.
      await Promise.allSettled(pending);
      if (driver !== undefined) {
        await driver.shutdown();
        driver.uniffiDestroy();
      }
    },
    'desktop-agent: cua driver runtime',
  );

  try {
    const { CuaDriver } = await loadSdk();
    lifetime.signal.throwIfAborted();
    // The generated constructor returns its class with an owned binding handle,
    // but declares only CuaDriverLike, which omits uniffiDestroy().
    driver = CuaDriver.create(undefined);
    await publishTools(ctx, driver, lifetime, pending);
  } catch (error) {
    await dispose();
    throw error;
  }

  return dispose;
}

/**
 * Publish one model tool per catalog entry and the usage guidance section.
 *
 * @param ctx - the plugin context.
 * @param driver - the live native handle.
 * @param lifetime - the runtime's abort source.
 * @param pending - the in-flight native calls the teardown waits for.
 */
async function publishTools(ctx, driver, lifetime, pending) {
  const tools = ctx.get('tools');
  const catalog = readCatalog(JSON.parse(await driver.listToolsJson({ signal: lifetime.signal })));
  lifetime.signal.throwIfAborted();

  const names = new Set();
  for (const tool of catalog) {
    if (typeof tool?.name !== 'string' || tool.name === '') {
      throw new Error('Cua Driver listed a tool without a name.');
    }
    const publicName = TOOL_PREFIX + tool.name;
    if (!TOOL_NAME.test(publicName)) {
      throw new Error(`Cua Driver tool "${tool.name}" exceeds the supported function-name format`);
    }
    if (names.has(publicName)) throw new Error(`Cua Driver listed tool "${tool.name}" more than once`);
    names.add(publicName);

    tools.register(createMcpToolDefinition(ctx, {
      name: publicName,
      rawName: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      async call(args, execution) {
        // Two independent cancellations: the caller giving up, and the plugin
        // being unloaded. The native call must observe both.
        const combined = AbortSignal.any([execution.signal, lifetime.signal]);
        combined.throwIfAborted();
        const operation = driver.callTool(tool.name, JSON.stringify(args), { signal: combined });
        pending.add(operation);
        try {
          const result = await operation;
          combined.throwIfAborted();
          return JSON.parse(result.rawJson);
        } finally {
          pending.delete(operation);
        }
      },
    }));
  }

  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt === null || systemPrompt === undefined) {
    ctx.logger?.warn?.('desktop-agent: the systemPrompt service is unavailable; the Cua Driver guidance was not registered.');
    return;
  }
  ctx.effect(
    () => systemPrompt.section({
      name: SECTION_NAME,
      order: systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
      text: GUIDANCE,
    }),
    'desktop-agent: cua driver guidance',
  );
}
