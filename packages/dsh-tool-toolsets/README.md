# dsh-tool-toolsets

On-demand toolset loading for DeepSeek Harness: a plugin hands its tools over as
a named *toolset*, only a catalog (`get_tools`) joins the global tool list, and a
toolset's schemas cost nothing until an agent asks for them.

## Why

Every registered tool's schema is paid on every request, whether or not the model
ever calls it. Measured on one profile: 100 tools / 126,498 characters of schema
per request, of which the 52 MCP tools are 83,495 characters (66%). A plugin with
dozens of rarely-used tools spends most of its context budget on definitions the
model reads once.

This plugin defers that cost: a toolset's schemas are registered into the
*calling agent's own scope layer* only when that agent calls `get_tools` for it,
and the next request assembly picks them up.

## How it works

- A plugin calls `ctx.toolsets.register({ name, description, tools })`. `name`
  matches `^[a-z][a-z0-9_-]*$`; `description` is the model-facing "when to use
  this" line; `tools` are complete `defineTool` definitions.
- The plugin registers one global `get_tools` tool whose description is the
  catalog: one line per toolset (name, when-to-use, tool count). Registering or
  removing a toolset rebuilds the catalog.
- `get_tools({ toolset: "<name>" })` registers that group's tools into
  `exec.agent.ctx` — the calling agent's scope. They are callable from the next
  turn, are visible only to that agent, and unwind with the agent's fiber.
- Loading a toolset twice in one agent is a no-op returning the current list.
- Reviewing registration fails loud: bad name, empty tool list, a tool without
  `execute`, a name collision across toolsets, or the reserved name `get_tools`.

## Consuming (other plugins in this repo)

```js
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'my-plugin';
export const inject = ['tools', 'toolsets'];

export function apply(ctx) {
  ctx.toolsets.register({
    name: 'android',
    description: 'Operate a real Android phone over ADB — tap, swipe, screenshot.',
    tools: [defineTool({ /* … */ })],
  });
}
```

`inject: ['toolsets']` is required: without it the service is not visible and the
plugin silently does nothing.

## The host's own tools: `adopt`

A plugin's tools are handed to `register`. The HOST's tools cannot be: they are
registered before any plugin row mounts, so no plugin owns them and re-registering
one throws on the duplicate name.

`adopt({ name, description, tools })` claims such a group by NAME instead. The
definitions stay exactly where the host put them — so they keep their real
schemas — and the service's assembly hook hides them from each agent until that
agent loads the group. `activate` then does not register anything for an adopted
group; it only flips that agent's visibility.

`host-toolsets.mjs` is the policy on top of it: the host tools that are not
high-frequency are grouped by job (ssh, schedule, MCP resources, agent control,
goals, desktop/web, workflow, config sync, images) and claimed in full the tick
after mount. A group whose every tool is not yet registered is not claimed at
all — a catalog line promising tools that are absent would be the silent failure
class again.

This replaced `dsh-tool-surface`, deleted 2026-11-17. That plugin also withdrew
tools, but it described their arguments in prose; a tool known only by a one-line
summary is not usable, and an adopted group restores the full schema on load.

## A name-based filter elsewhere in the host

`ctx.toolsets.protectedNames()` returns every tool name a registered toolset owns
plus `get_tools`. Nothing in this repository consumes it now that
`dsh-tool-surface` is gone; it exists because a third-party filter that withdrew
tools by name would otherwise remove a tool an agent had just loaded, and the
symptom — a load that appears to work and then vanishes — has no error anywhere.

## Known trade-offs

- **Next-turn effect**: a load returns before the group is callable; it appears in
  the following request. This is inherent to any deferred-schema design — the
  tool list is fixed per request.
- **Per agent**: a sub-agent must load what it needs; it does not inherit its
  parent's loads.
- **Prefix cache**: activation changes the tool list and so invalidates the
  provider's tool prefix cache once, in exchange for a permanently smaller list.
- **In-memory activation**: a restarted session reloads what it needs (a no-op if
  already loaded).
- **Not `deferLoading`**: this is a registry-layer mechanism and works regardless
  of provider. `dsh-llm`'s built-in `deferLoading` is a different, provider-level
  mechanism; it can coexist but does not replace this.

## Three failures that only a real host shows

All three were found by pointing a browser at an isolated profile and reading the
actual `request/header` and tool results. None is reachable from unit tests, and
each cost a wrong "it works" before it was seen. They are recorded here because
the same shapes will recur in any deferred-registration work, not just this code.

1. **A plugin's own `ctx.tools.schemas()` is not the host's tool list.** It
   resolves to that plugin's layer. Measured at mount: 0 tools, and 1 the next
   tick — the 1 being `get_tools` itself — while the assembly carried 31. Any
   adoption keyed on that view silently claims nothing.
2. **The assembly hook cannot register a tool for the same request.**
   `SystemPrompt.assemble` reads its provider list *before* the waterfall runs,
   so a catalog registered inside that hook first appears one request later. A
   first request that withholds tools without naming the loader is unreachable by
   construction: the model is told nothing about them and cannot ask.
3. **A blind static claim must be pruned to what exists.** Claiming a group from
   a name list means a plugin can advertise groups from a configuration this
   installation never had; `get_tools` then reports the phantom tools as
   "available", and the next call dies with `unknown tool`. Prune to the names the
   assembly actually carries, and drop a group whole when nothing is there.

The general lesson: for anything that decides *when* a definition is visible,
only the assembly is a truthful view, and the ordering between "register" and
"read the registry" decides whether the first request is correct.

## Tests

```sh
pnpm test            # registry unit tests + real-host composition tests
```

The composition tests stand up a real cordis `Context`, the real `dsh-tools`
`ToolRuntime`, and the real `dsh-system-prompt` registry, then assert a toolset's
schemas are absent from the assembled request before activation and present
after — the one claim unit tests on pure functions cannot make. Host packages
resolve as devDependencies (pnpm links them), as peers for consumers.

## License

MIT
