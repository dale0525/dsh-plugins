/**
 * index.mjs — the `ctx.toolsets` service and the `get_tools` catalog tool.
 *
 * The problem this solves: every tool a plugin registers enters the global tool
 * list, and its schema is paid on every request — whether or not the model ever
 * calls it. A plugin with forty tools spends most of its context on definitions
 * the model reads once and never uses.
 *
 * This plugin lets a plugin hand its tools over as a named *toolset* instead.
 * Only a catalog (`get_tools`) joins the global list; a toolset's schemas are
 * registered into the *calling agent's own scope layer* at the moment that
 * agent asks for them, and the request assembly picks them up on the next turn.
 *
 * Why the agent's scope rather than the global registry: the tool list is
 * assembled per request from the agent's view (`dsh-tools` resolves `schemas`
 * through `view(exec.agent)`), activation is per-agent by construction, and the
 * registrations unwind with the agent's fiber — a finished sub-agent leaves no
 * tools behind and needs no cleanup.
 *
 * @module @logictan/dsh-tool-toolsets
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { HOST_TOOLSETS } from './host-toolsets.mjs';
import {
  CATALOG_TOOL_NAME,
  renderCatalogDescription,
  validateToolset,
} from './registry.mjs';

export const name = 'tool-toolsets';

/** Registers tools (`ctx.tools`), so it must wait for that service. */
export const inject = ['tools'];

/**
 * The `ctx.toolsets` service: a registry of tool groups plus per-agent
 * activation.
 *
 * Registrations are owned by the fiber of the plugin that called `register`,
 * so unloading or HMR-swapping that plugin removes its toolset — and the
 * catalog line with it — without this service tracking anything.
 */
export class ToolsetsService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - the service's own context.
   */
  constructor(ctx) {
    // `this.ctx` is rebound to whichever caller reaches the service, so it
    // cannot reach `ctx.tools` — that needs the inject this plugin declared,
    // which only the plugin's OWN context carries. `ownCtx` is that context.
    this.ownCtx = ctx;
    this.ctx = ctx;
    /** @type {Map<string, {name: string, description: string, tools: readonly object[]}>} */
    this.registered = new Map();
    /**
     * Activation state, keyed by the agent object. A WeakMap because the key
     * is the agent itself: when the agent is collected, its record goes too.
     * In-memory only — a restarted session simply re-loads what it needs, and
     * loading twice is a no-op.
     * @type {WeakMap<object, Set<string>>}
     */
    this.activated = new WeakMap();
    /** @type {Set<string>} toolsets whose tools this service gates but does not own. */
    this.adopted = new Set();
    /** @type {(() => void) | undefined} */
    this.catalogDispose = undefined;
  }

  /**
   * Register one toolset. The registration (and its removal) is owned by the
   * calling plugin's fiber.
   *
   * @param {{name: string, description: string, tools: readonly object[]}} toolset
   * @returns {() => void} disposer that removes this toolset.
   */
  register(toolset) {
    validateToolset(toolset, this.registered.values());
    return this.ctx.effect(() => {
      this.registered.set(toolset.name, toolset);
      this.#refreshCatalog();
      return () => {
        this.registered.delete(toolset.name);
        this.#refreshCatalog();
      };
    }, `toolsets.register(${toolset.name})`);
  }

  /**
   * Registered toolsets, in registration order.
   * @returns {readonly {name: string, description: string, tools: readonly object[]}[]}
   */
  list() {
    return [...this.registered.values()];
  }

  /**
   * Every tool name a registered toolset owns, plus the catalog tool's own name.
   *
   * Kept as public surface because a name-based filter elsewhere in the host
   * would otherwise remove a tool an agent had just loaded — the silent-no-op
   * class of failure that this repo saw twice. `dsh-tool-surface`, the plugin
   * that consumed it, was deleted on 2026-11-17 (this plugin's own assembly hook
   * now does that job for adopted groups), so nothing in this repository calls
   * it today; a third-party filter can.
   *
   * @returns {Set<string>} names that a name-based filter must not withdraw.
   */
  protectedNames() {
    const names = new Set([CATALOG_TOOL_NAME]);
    for (const toolset of this.registered.values()) {
      for (const tool of toolset.tools) names.add(tool.name);
    }
    return names;
  }

  /**
   * Adopt already-registered tools into a toolset that this service only gates.
   *
   * `register` owns its tools: nothing else registered them, and activation
   * registers them into the agent. Some groups cannot work that way — the host's
   * own tools are registered by the host before any plugin runs, so a plugin can
   * neither re-register them (the registry rejects a duplicate name) nor take
   * over their execution. What it *can* do is decide when the model is told
   * about them, because the assembly is a separate surface from the registry.
   *
   * So an adopted toolset is a claim, not an owner: the names are checked for
   * existence and left exactly where they are; activation only records that this
   * agent may see them. `#adopted` is what the assembly hook subtracts from an
   * agent's announced list until that agent loads the toolset — loading then
   * restores each schema in full, which the prose-carrying approach it replaces
   * could never do.
   *
   * @param {{name: string, description: string, tools: readonly {name: string, execute?: unknown}[]}} toolset
   * @returns {() => void} disposer that releases the claim.
   */
  adopt(toolset) {
    validateToolset(toolset, this.registered.values(), 'adopt');
    return this.ctx.effect(() => {
      this.registered.set(toolset.name, toolset);
      this.adopted.add(toolset.name);
      this.#refreshCatalog();
      return () => {
        this.registered.delete(toolset.name);
        this.adopted.delete(toolset.name);
        this.#refreshCatalog();
      };
    }, `toolsets.adopt(${toolset.name})`);
  }

  /**
   * Drop adopted groups whose tools this host does not have, and drop individual
   * phantom names from the groups it keeps.
   *
   * The mount-time claim is deliberately blind: this plugin's own `ctx` view
   * cannot see the host's tools, so it records the static list and lets the
   * assembly settle which of them exist. Without this step the catalog
   * advertises groups from a configuration this installation never had, and the
   * failure is the worst shape available — `get_tools` happily reports the
   * phantom tools as "now available", the model calls one, and the host answers
   * `unknown tool "list_mcp_resources"` (measured on the isolated profile,
   * 2026-11-18, which has no MCP-resource plugin installed at all).
   *
   * A group with no tool present is dropped whole: a catalog line for it is a
   * promise this host cannot keep. A group with some tools present keeps only
   * those, so a partially-installed set still works.
   *
   * @param present - every tool name the current assembly carries.
   */
  pruneToExisting(present) {
    for (const [name, toolset] of [...this.registered]) {
      if (!this.adopted.has(name)) continue;
      const kept = toolset.tools.filter((tool) => present.has(tool.name));
      if (kept.length === toolset.tools.length) continue;
      this.registered.delete(name);
      this.adopted.delete(name);
      if (kept.length > 0) {
        this.registered.set(name, { ...toolset, tools: kept });
        this.adopted.add(name);
      }
      this.#refreshCatalog();
    }
  }

  /**
   * Whether one toolset's tools are adopted rather than owned.
   *
   * @param toolsetName - the toolset to test.
   * @returns true when the tools are already registered by someone else.
   */
  isAdopted(toolsetName) {
    return this.adopted.has(toolsetName);
  }

  /**
   * Names to subtract from one agent's announced list: every tool of every
   * adopted toolset that the agent has not loaded.
   *
   * The assembly hook calls this per request, so the answer depends on the
   * requesting agent — an adopted group is hidden from an agent that never asked
   * for it and visible to one that did, without the two seeing each other's
   * choice.
   *
   * @param agent - the scope key of the request being assembled, or undefined.
   * @returns {Set<string>} names absent from that agent's tool list.
   */
  withheldNames(agent) {
    const names = new Set();
    if (this.adopted.size === 0) return names;
    const loaded = agent === undefined ? undefined : this.activated.get(agent);
    for (const toolsetName of this.adopted) {
      if (loaded?.has(toolsetName) === true) continue;
      for (const tool of this.registered.get(toolsetName).tools) names.add(tool.name);
    }
    return names;
  }

  /**
   * Load one toolset into one agent's scope. Idempotent per (agent, toolset).
   *
   * Refuses to shadow a tool the agent already sees: a collision is almost
   * always a misconfiguration (the same tool registered twice, or a toolset
   * loaded after its own tools), and silently letting one definition win would
   * make the effective schema depend on load order.
   *
   * @param {{ctx: {tools: {register: (tool: object) => () => void}}}} agent
   * @param {string} toolsetName
   * @returns {{toolset: string, description: string, alreadyActive: boolean, tools: {name: string, description: string}[]}}
   */
  activate(agent, toolsetName) {
    const toolset = this.registered.get(toolsetName);
    if (toolset === undefined) {
      throw new Error(`toolsets.activate: unknown toolset ${JSON.stringify(toolsetName)}`);
    }

    let names = this.activated.get(agent);
    if (names === undefined) {
      names = new Set();
      this.activated.set(agent, names);
    }

    const alreadyActive = names.has(toolsetName);
    if (!alreadyActive) {
      // An adopted toolset's tools are ALREADY registered (by the host), so
      // registering them here would throw on the duplicate name and, worse,
      // shadow the host's definition if it did not. Loading it only flips this
      // agent's visibility.
      if (!this.adopted.has(toolsetName)) {
        const visible = new Set(this.ownCtx.tools.schemas(agent).map((schema) => schema.name));
        const collisions = toolset.tools.filter((tool) => visible.has(tool.name)).map((tool) => tool.name);
        if (collisions.length > 0) {
          throw new Error(
            `toolsets: toolset "${toolsetName}" exposes tool(s) ${collisions.map((n) => JSON.stringify(n)).join(', ')} already visible to this agent; refusing to shadow`,
          );
        }
        for (const tool of toolset.tools) {
          agent.ctx.tools.register(tool);
        }
      }
      names.add(toolsetName);
    }

    return {
      toolset: toolset.name,
      description: toolset.description,
      alreadyActive,
      tools: toolset.tools.map((tool) => ({
        name: tool.name,
        // `?? ''` rather than a bare pass-through: an adopted tool's descriptor
        // has no description here, and `undefined` in the result is what failed
        // the lossless-JSON check. An empty string says the same thing legally.
        description: tool.description ?? '',
      })),
    };
  }

  /**
   * Replace the catalog tool with one built from the current registry.
   *
   * The catalog text is embedded in the tool's description, so any change to
   * the set of toolsets means a new tool definition.
   *
   * Registered even when NO toolset exists yet. That is deliberate and it is the
   * difference between saving the first request and saving nothing: the host
   * reads its provider list before the assembly waterfall runs, so a catalog
   * registered from inside that hook only reaches the SECOND request — and a
   * first request that withholds tools without a loader is unreachable-by-design
   * (measured 2026-11-17). Registering at mount time means every request,
   * including the first, names the loader.
   */
  #refreshCatalog() {
    this.catalogDispose?.();
    this.catalogDispose = undefined;
    this.catalogDispose = this.ownCtx.tools.register(
      buildGetToolsTool({
        catalog: () => this.list(),
        activate: (agent, toolsetName) => this.activate(agent, toolsetName),
      }),
    );
  }
}

/**
 * Build the `get_tools` catalog tool against the current registry.
 *
 * @param {{catalog: () => readonly object[], activate: (agent: object, name: string) => object}} deps
 * @returns {object} a `defineTool` definition ready for `ctx.tools.register`.
 */
export function buildGetToolsTool(deps) {
  return defineTool({
    name: CATALOG_TOOL_NAME,
    description: renderCatalogDescription(deps.catalog()),
    parameters: {
      toolset: {
        type: 'string',
        required: true,
        description: 'Name of the toolset to load. See the toolsets listed in this tool\'s description.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          toolset: { type: 'string', required: true, description: 'Loaded toolset name.' },
          description: { type: 'string', required: true, description: "The toolset's when-to-use statement." },
          alreadyActive: {
            type: 'boolean',
            required: true,
            description: 'True when the toolset was already loaded for this agent.',
          },
          tools: {
            type: 'array',
            required: true,
            description: 'Tools now available in the calling agent\'s tool list.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                // NOT required: an ADOPTED group records names only — its
                // definitions live in the registry, which this service does not
                // own. Requiring it forced `undefined` into the output, and a
                // required-but-absent field is not lossless JSON, so the whole
                // call failed validation (measured 2026-11-18, `mcp_resources`).
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.alreadyActive
            ? `Toolset "${value.toolset}" was already loaded; its tools remain available. Tools (${value.tools.length}): ${value.tools.map((tool) => tool.name).join(', ')}`
            : `Loaded toolset "${value.toolset}". Tools now in your list (${value.tools.length}): ${value.tools.map((tool) => tool.name).join(', ')}`,
        },
      ],
    },
    async execute(args, exec) {
      const requested = args.toolset;
      const known = deps.catalog();
      if (!known.some((toolset) => toolset.name === requested)) {
        const { ToolArgsError } = await import('@deepseek-ai/dsh-tools');
        throw new ToolArgsError([
          `toolset: unknown toolset ${JSON.stringify(requested)}; known toolsets: ${known.map((t) => t.name).join(', ') || '(none)'}`,
        ]);
      }
      const agent = exec.agent;
      if (agent === undefined) {
        throw new Error('get_tools: this execution carries no agent; toolsets activate per agent');
      }
      const activated = deps.activate(agent, requested);
      return { ...activated, tools: [...activated.tools] };
    },
  });
}

/**
 * Mount the service. Cordis class-plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const service = new ToolsetsService(ctx);
  ctx.provide('toolsets', service);

  // The assembly hook is the ONLY place adoption happens, and it acts on the
  // list the providers just produced.
  //
  // Why not claim earlier from `ctx.tools.schemas()`: this plugin's own context
  // resolves `tools` to its own layer, and on a real host that view holds only
  // what this plugin registered — measured in the isolated profile, where the
  // post-mount claim saw 0 tools while the request carried 23. The assembly is
  // the one view that is correct by construction: it IS what the model is about
  // to be told, whichever layer each definition came from.
  //
  // Claim the host groups NOW, from the static list, without first checking that
  // their tools are registered.
  //
  // The check is what made the first request expensive: this plugin's own
  // `ctx.tools` view resolves to its own layer, and the host's tools are not in
  // it — measured on an isolated profile, `schemas()` returned 0 at mount and 1
  // (`get_tools` itself) a tick later, while the assembly carried 31. Waiting
  // for a view that never fills meant no catalog on the first request, and the
  // gate below then (correctly) refused to hide anything, so nothing was saved.
  //
  // Claiming blind is safe because `adopt` brings nothing with it: it records
  // names and hides what the assembly actually carries. A group whose tools are
  // absent from this host simply hides nothing.
  for (const group of HOST_TOOLSETS) {
    service.adopt({
      name: group.name,
      description: group.description,
      tools: group.tools.map((toolName) => ({ name: toolName })),
    });
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const nextAssembly = await next();
    const present = new Set(nextAssembly.tools.map((tool) => tool.name));

    // First settle which adopted groups this host actually has — the catalog
    // must never promise a group whose tools are not here.
    service.pruneToExisting(present);

    // Safety gate, kept as an invariant rather than as a timing repair.
    //
    // The catalog is registered at MOUNT time, so on a normal boot it is already
    // in this list and this line does nothing. It exists for the case where it
    // is not: a request that withholds tools without naming a loader leaves the
    // model with a hidden tool set and no way to ask for it. That exact shape
    // was measured on an isolated profile on 2026-11-17 — 23 tools, host tools
    // removed, `get_tools` absent — and it is the same silent failure as the
    // `write` incident, arrived at from the other side.
    //
    // Costing one visible request when the loader is genuinely missing is the
    // cheap side of that trade: the tools stay reachable, and the next request
    // carries the catalog.
    if (!present.has(CATALOG_TOOL_NAME)) return nextAssembly;

    const withheld = service.withheldNames(context?.scope);
    if (withheld.size === 0) return nextAssembly;
    const kept = nextAssembly.tools.filter((tool) => !withheld.has(tool.name));
    // Returning the original array when nothing changed keeps the cached prefix
    // intact; a fresh array every step would defeat the caching this saves.
    return kept.length === nextAssembly.tools.length ? nextAssembly : { ...nextAssembly, tools: kept };
  });

  ctx.effect(() => () => {
    service.catalogDispose?.();
    service.catalogDispose = undefined;
  }, 'tool-toolsets: dispose catalog tool');
}

/**
 * The plugin object. `inject` must live HERE rather than only as a module
 * export: cordis reads `plugin.inject` off the plugin value it is handed, and a
 * bare function carries no properties. A module-level `export const inject`
 * satisfies the loader (which builds a plugin object from the namespace) but is
 * invisible when a test — or any caller — passes the function itself, and the
 * symptom is an "cannot get property tools without inject" at the first
 * `ctx.tools` touch.
 */
export default { name, inject, apply };
