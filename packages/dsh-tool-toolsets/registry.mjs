/**
 * registry.mjs — pure logic for the toolset registry: name rules, registration
 * validation, and the model-facing catalog text.
 *
 * Nothing here touches a Context, a registry, or an agent. That is deliberate:
 * these are the rules the plugin must obey, and keeping them as plain functions
 * is what lets a test pin them without standing up a host.
 *
 * @module @logictan/dsh-tool-toolsets/registry
 */

/** A toolset name is lowercase, starts with a letter, and fits a catalog line. */
export const TOOLSET_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** The catalog tool's own name, reserved so a toolset can never claim it. */
export const CATALOG_TOOL_NAME = 'get_tools';

/** Longest a toolset name may be, so one catalog entry stays one line. */
export const MAX_TOOLSET_NAME = 64;

/** Longest a catalog line's when-to-use text may run before it is truncated. */
const MAX_CATALOG_LINE = 200;

/**
 * Collapse multiline prose to one trimmed line, truncated at the catalog limit.
 *
 * A toolset description is written as prose and may wrap; the catalog is a list
 * where each entry must occupy exactly one line, or the model reads a ragged
 * block instead of a list.
 *
 * @param text - the description as written.
 * @returns a single line, ellipsized past {@link MAX_CATALOG_LINE}.
 */
export function collapseToOneLine(text) {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  return collapsed.length > MAX_CATALOG_LINE ? `${collapsed.slice(0, MAX_CATALOG_LINE - 3)}…` : collapsed;
}

/**
 * Validate one toolset against its own shape and the toolsets already present.
 *
 * Every rule is checked at registration, which is the earliest point the
 * mistake is resolvable: by the time the model calls `get_tools` the bad entry
 * is already in the catalog or has silently vanished from it.
 *
 * `mode` decides one rule only. A toolset this service OWNS registers its own
 * tools, so each needs an `execute`; `'adopt'` claims tools that are already
 * registered elsewhere, where demanding a local `execute` would reject the
 * definition the host already supplied. Everything else — names, emptiness,
 * collisions — is identical, because those are about the catalog rather than
 * about who executes the call.
 *
 * @param toolset - candidate definition (`{ name, description, tools }`).
 * @param existing - toolset definitions already registered, in order.
 * @param {'own' | 'adopt'} [mode] - whether this toolset registers its tools.
 * @throws TypeError or Error naming the first violation found.
 */
export function validateToolset(toolset, existing, mode = 'own') {
  if (typeof toolset !== 'object' || toolset === null) {
    throw new TypeError('toolsets.register: toolset must be an object');
  }
  const { name, description, tools } = toolset;

  if (typeof name !== 'string' || !TOOLSET_NAME_PATTERN.test(name) || name.length > MAX_TOOLSET_NAME) {
    throw new Error(
      `toolsets.register: name must match ${TOOLSET_NAME_PATTERN} and be at most ${MAX_TOOLSET_NAME} chars, got ${JSON.stringify(name)}`,
    );
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error(`toolsets.register(${name}): description must be a non-empty string`);
  }
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(`toolsets.register(${name}): tools must be a non-empty array`);
  }

  const seen = new Set();
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) {
      throw new Error(`toolsets.register(${name}): every tool must be an object`);
    }
    if (typeof tool.name !== 'string' || tool.name === '') {
      throw new Error(`toolsets.register(${name}): every tool needs a non-empty string name`);
    }
    if (tool.name === CATALOG_TOOL_NAME) {
      throw new Error(`toolsets.register(${name}): tool name "${CATALOG_TOOL_NAME}" is reserved for the catalog tool`);
    }
    if (mode === 'own' && typeof tool.execute !== 'function') {
      throw new Error(`toolsets.register(${name}): tool "${tool.name}" must declare an execute function`);
    }
    if (seen.has(tool.name)) {
      throw new Error(`toolsets.register(${name}): duplicate tool name "${tool.name}" within the toolset`);
    }
    seen.add(tool.name);
  }

  for (const other of existing) {
    if (other.name === name) {
      throw new Error(`toolsets.register: toolset name "${name}" is already registered`);
    }
    for (const tool of tools) {
      if (other.tools.some((registered) => registered.name === tool.name)) {
        throw new Error(
          `toolsets.register(${name}): tool name "${tool.name}" is already claimed by toolset "${other.name}"`,
        );
      }
    }
  }
}

/**
 * Render the model-facing catalog embedded in the `get_tools` description: one
 * preamble paragraph, then one line per toolset (name, when-to-use, tool count).
 *
 * The preamble states the three things a model cannot infer from a list of
 * names: how to load one, that loading takes effect next turn, and that loading
 * again is harmless. Each is a real behaviour of this plugin, not advice.
 *
 * @param toolsets - registered definitions in registration order.
 * @returns the catalog text.
 */
export function renderCatalogDescription(toolsets) {
  const lines = toolsets.map(
    (toolset) =>
      `- ${toolset.name}: ${collapseToOneLine(toolset.description)} (${toolset.tools.length} tool${toolset.tools.length === 1 ? '' : 's'})`,
  );
  return [
    'On-demand toolsets. Each entry below names one toolset and when to use it.',
    'Call this tool with {"toolset": "<name>"} to load that toolset\'s tools into your tool list:',
    'they become callable from your next turn and stay available for the rest of the session.',
    'Loading an already-loaded toolset is a harmless no-op that returns its current tool list.',
    '',
    'Toolsets:',
    ...lines,
  ].join('\n');
}
