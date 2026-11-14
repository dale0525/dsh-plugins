# @logictan/dsh-stitch-designer

Google Stitch (AI UI generation) inside DSH: Stitch's own `mcp__stitch__*` tools,
one local addition (`remove_screens_from_canvas`), plus the design conventions
that keep one code project bound to one Stitch project.

Ported from [liuxinlongwa-hue/dsh-stitch-designer](https://github.com/liuxinlongwa-hue/dsh-stitch-designer)
(MIT, © 2026 liuxinlongwa-hue). What changed here is the tool surface, the key
storage, and the scope — that project's preview panel, screenshot cache and
1:1 HTML export endpoint have been removed; see below.

## What it gives the model

The Stitch tools the `mcp-stitch` MCP row used to expose (and whatever Stitch
has added since — `download_file` among them), under the same public names, so
existing prompts and habits keep working:

```
mcp__stitch__create_project              mcp__stitch__get_project
mcp__stitch__delete_project              mcp__stitch__list_projects
mcp__stitch__list_screens                mcp__stitch__get_screen
mcp__stitch__generate_screen_from_text   mcp__stitch__edit_screens
mcp__stitch__generate_variants           mcp__stitch__upload_design_md
mcp__stitch__create_design_system        mcp__stitch__list_design_systems
mcp__stitch__create_design_system_from_design_md
mcp__stitch__update_design_system        mcp__stitch__apply_design_system
```

The tool list is read from Stitch at activation, not copied into this package,
so a tool Stitch adds or renames shows up without a code change. A call budget
of 180s covers `generate_screen_from_text`, which is long-running.

### `remove_screens_from_canvas` — the one tool Stitch does not offer

Stitch has no screen-delete API. `stitch delete screen` answers
`UNSUPPORTED_RESOURCE / "Stitch screens do not support delete."`, and
`DELETE /projects/<p>/screens/<s>` answers 404 in every spelling including
`:delete` (measured 2026-11-08). The MCP tool list has no `delete_screen`
either, so this is not a capability the bridge failed to expose.

What the service does accept is a project-level rewrite of the canvas:
`PATCH /v1/projects/<id>?updateMask=screenInstances` with the instance list
minus the unwanted entries. That is what this tool does, and it is why the
plugin carries a small REST transport (`src/canvas.js`) alongside the MCP one.

Removal is **batch by construction, not by looping**: the canvas is a single
field, so N ids cost one GET and one PATCH. Looping would mean N
read-modify-write cycles and a lost removal whenever two of them raced. Passing
a single id in the list is simply the one-element case.

Ids that are not on the canvas do not fail the call: the ones that are get
removed, and the leftovers come back in the result so the caller can see them.
When *none* of the ids is on the canvas the tool raises instead of writing.

The screen object is not destroyed — it stays addressable at
`GET /v1/projects/<p>/screens/<s>` — but it leaves the project, which is what
clears abandoned screens out of a project. Renaming a screen's title has no API
route at all (the canvas `label` is a separate field and does not change the
screen `title`), so this plugin offers no rename tool.

```
mcp__stitch__remove_screens_from_canvas { projectId, screenIds: [screenId, ...] }
```

## Settings

`Settings → Plugins → stitch-designer`:

| Field | Meaning |
| --- | --- |
| Stitch API Key | The `STITCH_API_KEY` credential; write-only in the UI and never read back |

Get the key from <https://stitch.withgoogle.com> (avatar → Stitch Settings → API
key). It is stored in `$DSH_HOME/.credentials.yaml` as `STITCH_API_KEY` — **not**
in a plugin config row, so it never appears in plaintext in
`cordis.patch.yml`. Config sync carries it in its credentials section.

Setting the key registers the tools immediately; no restart is needed.

## Design conventions

Two groups of rules apply: how a screen is commissioned, and how it is then
implemented.

Commissioning:

| Rule | Why |
| --- | --- |
| Say what to show and what to leave out, and nothing about style | The brief names the content and the existing components, plus what must not appear. Layout, spacing, colour, type and motion are left to Stitch; a brief that fixes them turns design into transcription, no better than writing it by hand. |
| Ask for nothing that cannot be built | The screen is going to be reproduced pixel for pixel, so a wish for an impossible interaction or unavailable data is a defect in the brief. |
| Describe a design language only when the implementation must match one — and describe it, don't name it | The one exception to "no style limits": when a screen has to fit an existing visual system (here, `@logictan/dsh-macos-theme`), the brief must say what that system actually looks like — colour values, radii, borders, type weights and sizes, spacing density, light/dark relationships. Stitch does not know our package or theme names; pass the theme's own design-system text verbatim when the project has one. With no such constraint, specify no design language at all. |
| Compose it from components the project already has | Host components and the shared component layer exist; a redrawn lookalike is work spent twice. |
| Revise with `edit_screens`, and keep exactly one copy of each screen | An edit produces a new screen id instead of overwriting the old one, so the design is changed in place and the id it superseded is removed with `remove_screens_from_canvas`. A canvas holding abandoned drafts and tried variants hides which screen is current — and the removal is irreversible, so which ids were superseded is settled before it is called. |
| Commission the light screen first, and one dedicated dark screen for the tokens | Dark is the same design language's dark values, not an inversion, so the tokens have to be decided somewhere the model can see them: one extra screen settles background, surface, border, foreground and accent values. Every other screen then exists only in light, and is implemented in both modes from those tokens. Later adds, edits and deletes touch the light screens only. |

Implementation:

| Rule | How it reaches the model |
| --- | --- |
| One code project owns exactly one Stitch project | **Enforced.** The id is recorded in the code project's `.stitch.json`; a second `create_project` from an already-bound directory is refused with the existing id. |
| Implement with TailwindCSS, the way Stitch builds its screens | Announced in the system prompt. Unless the repository already has an architecture that cannot accommodate TailwindCSS, in which case the model is told to explain that first. |
| Implement from Stitch's exported HTML for pixel-level fidelity | Announced in the system prompt. The export goes to `<project>/docs/design/<screenId>.html`; anywhere the implementation would differ from the design, the model is told to ask first and give the reason. |

Only the one-project rule is enforced in code, because it is the only one with a
computable predicate. "Did you use TailwindCSS?" and "is this pixel-perfect?"
cannot be checked, so a validator for them would be a lie — they are delivered
the way this repository delivers every other non-computable rule, as a
system-prompt section the plugin registers itself (`src/guidance.js`).

`.stitch.json` is the project's own file — commit it. It is small and
hand-editable on purpose: it is the escape hatch when a Stitch project was
deleted, or when the wrong one was recorded. A record pointing at a project
that no longer exists is cleared automatically rather than obeyed, so the
refusal can never become a permanent dead end; `delete_project` clears it too.

```json
{ "projectId": "15445722684773602632" }
```

Only the id is stored. The title is not, because it is a second copy of a fact
Stitch already owns and would go stale as soon as the project is renamed
upstream — while the binding rule reads the id alone.

## Local files

| Path | Contents |
| --- | --- |
| `$DSH_HOME/.credentials.yaml` | The API key, under `STITCH_API_KEY` |
| `<project>/.stitch.json` | The Stitch project this code project owns (see above) |

`~/.stitch` — the previous generation's screenshot/HTML cache under the user's
home directory — is no longer written or read by this plugin. Exporting a
design to `<project>/docs/design/` is the model following the announced
convention, not a plugin action; it travels with the repository, so a later
session or a teammate can read the design the code was built from.

## Replacing the `mcp-stitch` row

This plugin registers the 15 `mcp__stitch__*` names itself, so it **replaces**
the `mcp-stitch` MCP row rather than coexisting with it: two registrations of one
tool name throw. Remove that row from `$DSH_HOME/cordis.patch.yml` before
installing, and set the key on the Plugins page.

## License

MIT. See [LICENSE](./LICENSE).
