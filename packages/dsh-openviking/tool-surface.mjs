import { MCP_SERVER_NAME } from "./config.mjs";

/**
 * The eleven of OpenViking's twenty-seven tools that stay in the prompt.
 *
 * Measured over 400 of this machine's 656 local sessions (2026-11-11, the
 * `tool/call` records in `~/.dsh/sessions/*\/session.v4.jsonl.zstd`): 130
 * OpenViking calls in total. These eleven account for all 130; the other
 * sixteen were never called once, and the whole surface, hand-written
 * English tutorials included, was 31,806 characters of a 100,322-character
 * first request.
 *
 * A withdrawn tool is not unregistered. `tools` resolves a call through its
 * registration layers, and the assembly is only what the model is told
 * about — so `mcp__openviking__set_acl` still executes when named. What it
 * loses is its argument schema, which for every withdrawn tool is a viking://
 * URI, an id, a flag or a word: the guidance section states those in prose.
 */
export const ANNOUNCED_TOOLS = new Set([
  'read',
  'write',
  'edit',
  'find',
  'search',
  'list',
  'remember',
  'glob',
  'grep',
  'forget',
  'health',
]);

/**
 * Whether one OpenViking tool keeps its definition in the prompt.
 *
 * @param rawName - The server's own tool name, without the `mcp__` prefix.
 * @returns `true` when the definition is announced.
 */
export function isAnnounced(rawName) {
  return ANNOUNCED_TOOLS.has(rawName);
}

/**
 * Drop the withdrawn OpenViking definitions from an assembled tool list.
 *
 * Names outside this server's `mcp__<serverName>__` namespace pass through
 * untouched: the assembly holds every provider's tools, and only this
 * plugin's are its to remove. The test is against the public name rather
 * than a captured registration set, so a `tools/list` that failed at boot and
 * succeeded later on a credential update is still filtered — the names are
 * the contract, the set of them is not.
 *
 * @param tools - The assembly's tool definitions.
 * @returns The same array when nothing was withdrawn, otherwise a filtered copy.
 */
export function withoutWithdrawn(tools) {
  if (!Array.isArray(tools)) return tools;
  const prefix = `mcp__${MCP_SERVER_NAME}__`;
  const kept = tools.filter(
    tool => typeof tool?.name !== 'string' || !tool.name.startsWith(prefix) || isAnnounced(tool.name.slice(prefix.length)),
  );
  return kept.length === tools.length ? tools : kept;
}