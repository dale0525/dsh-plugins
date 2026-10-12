# @logictan/dsh-stitch-designer

Google Stitch (AI UI generation) inside DSH: the 15 `mcp__stitch__*` tools, plus
an in-session preview panel that shows each generated design, keeps a local
screenshot/HTML cache, and exports the 1:1 HTML source.

Ported from [liuxinlongwa-hue/dsh-stitch-designer](https://github.com/liuxinlongwa-hue/dsh-stitch-designer)
(MIT, © 2026 liuxinlongwa-hue): the preview panel, the screenshot cache, the
`state.json` persistence and the 1:1 HTML export come from that project. What
changed here is the tool surface, the key storage, and the design conventions —
see below.

## What it gives the model

The same 15 tools the `mcp-stitch` MCP row used to expose, under the same
public names, so existing prompts and habits keep working:

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

Three rules apply when a Stitch design is implemented as code in a repository.

| Rule | How it reaches the model |
| --- | --- |
| One code project owns exactly one Stitch project | **Enforced.** The id is recorded in the code project's `.stitch.json`; a second `create_project` from an already-bound directory is refused with the existing id. |
| Implement with TailwindCSS, the way Stitch builds its screens | Announced in the system prompt. Unless the repository already has an architecture that cannot accommodate TailwindCSS, in which case the model is told to explain that first. |
| Implement from Stitch's exported HTML for pixel-level fidelity | Announced in the system prompt. The export goes to `<project>/docs/design/<screenId>.html`; anywhere the implementation would differ from the design, the model is told to ask first and give the reason. |

The first rule is enforced in code and the other two are announced, because only
the first has a computable predicate. "Did you use TailwindCSS?" and "is this
pixel-perfect?" cannot be checked, so a validator for them would be a lie — they
are delivered the way this repository delivers every other non-computable rule,
as a system-prompt section the plugin registers itself (`src/guidance.js`).

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

## The preview panel

The **AI 设计** button in the session header opens a panel showing the newest
design for the current project: a project picker, the full-size screenshot, a
thumbnail strip, and **导出 1:1 HTML 源码**.

Generation is driven from the conversation — ask for a design, and the model
calls `generate_screen_from_text`; ask for a change, and it calls
`edit_screens`. Then press **刷新** in the panel.

The panel exists because Stitch's `list_screens` index lags a generation by up
to a couple of minutes. This plugin reads the finished screen out of the
generation result, caches the screenshot and HTML under `~/.stitch`, and
remembers screen ids per project in `~/.stitch/state.json`, so a design appears
as soon as it exists instead of after the index catches up.

## HTTP routes

Served on the DSH web server, for the panel:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/stitch/api/state` | Projects, screens and the cached preview for the current (or `?projectId=`) project |
| GET | `/stitch/api/html/<screenId>` | Fetch and cache a screen's 1:1 HTML, returning its local URL |
| GET | `/stitch/screens/<screenId>.png` | Cached screenshot |
| GET | `/stitch/html/<screenId>.html` | Exported HTML source |

## Local files

| Path | Contents |
| --- | --- |
| `$DSH_HOME/.credentials.yaml` | The API key, under `STITCH_API_KEY` |
| `<project>/.stitch.json` | The Stitch project this code project owns (see above) |
| `~/.stitch/state.json` | Last used project and the remembered screen ids per project |
| `~/.stitch/screens/` | Cached screenshots |
| `~/.stitch/html/` | The panel's copy of the exported HTML |

`<project>/docs/design/` — where the announced convention puts the exported
HTML — is written by the model following that convention, not by the plugin; it
travels with the repository, so a later session or a teammate can read the
design the code was built from.

## Replacing the `mcp-stitch` row

This plugin registers the 15 `mcp__stitch__*` names itself, so it **replaces**
the `mcp-stitch` MCP row rather than coexisting with it: two registrations of one
tool name throw. Remove that row from `$DSH_HOME/cordis.patch.yml` before
installing, and set the key on the Plugins page.

## License

MIT. See [LICENSE](./LICENSE).
