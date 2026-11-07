# @logictan/dsh-magpie-image

Image generation for DSH through magpie's image MCP endpoint, as two native
`mcp__magpie__*` tools that sit beside `@logictan/dsh-imagegen` rather than
replacing it.

## Tools

| Tool | Purpose |
|---|---|
| `mcp__magpie__generate_image` | Text-to-image, or edit/combine images by passing `reference_images`. The result is saved as a durable attachment and shown beside the call. |
| `mcp__magpie__generation_result` | Fetch a request that outlived magpie's ~20-second budget, by the `task_id` the first call answered with. |

The names carry the `mcp__magpie__` prefix because `dsh-imagegen` already owns
the bare `generate_image`; two registrations of one tool name throw
(`tool "<name>" is already registered`), and the prefixed form is the same
vocabulary `@deepseek-ai/dsh-mcp-client` would have produced.

Only the image half of magpie is exposed. Its `generate_video` is deliberately
absent — video is covered by `@logictan/dsh-modal-h3`.

## Setup

Nothing to configure beyond the key. The plugin resolves the `MAGPIE_API_KEY`
credential, which is the same ref the magpie LLM provider already uses, so a
working magpie chat route needs no second key. Set or replace it on the Plugins
page; the plugin re-reads it on every call. In a profile that mounts no
credential store (headless disables it and passes the key through the process
environment), the plugin falls back to `process.env.MAGPIE_API_KEY`.

## Why this is a plugin and not an MCP row

Two measured facts about the endpoint (2026-11-07) each rule out a thin
`@deepseek-ai/dsh-mcp-client` row:

1. **The key cannot be a patch value.** An mcp-client row carries headers as
   literal config with no environment interpolation and no access to the
   credential store, so mounting it would write the magpie key into
   `cordis.patch.yml` — which `dsh-config-manager` exports verbatim into every
   config-sync snapshot. This plugin reads the credential per call instead.
2. **A reference image is not a path.** magpie accepts `data:<mime>;base64,…`
   or an http(s) URL, and refuses a local absolute path from any machine but the
   one it runs on ("generate_image reads a file only for an agent on the computer
   magpie runs on"). DSH attachments hold decoded bytes, so this plugin encodes
   them into a data URL on the way in — which is also what makes an image from a
   previous result reusable as a reference.

A third fact shapes the results: magpie's download URL expires after one hour,
so images are saved into the attachment store rather than passed through as
links.

## Behaviour worth knowing

- **Images render inline through a plugin route.** A browser half registers a
  `tool.call.toolview` card for both tools and fetches the bytes from
  `/api/dsh-magpie-image/image`, because a tool-result image is deliberately not
  part of session content. The host persists the references through
  `presentationMeta`; the card reads `meta.images` and draws them (current hosts
  keep the references in `meta`, not in `content` image blocks).
- **Long requests answer with prose, not an id.** Past ~20 seconds magpie
  returns a sentence containing the id; the tool reports `status: "pending"`
  with that `task_id` instead of failing, so the caller polls
  `mcp__magpie__generation_result` rather than regenerating.
- **Oversized references fail upstream.** magpie answers `file too large` inside
  the tool result, so this plugin imposes no byte cap of its own — a local cap
  would only replace a precise provider message with a guessed one.
- **Results are rejected, not repaired.** A media type outside PNG/JPEG/WebP/GIF,
  non-canonical base64, or a result carrying neither an image nor a task id
  raises an error rather than returning an empty success.

## Build

`lib/` is generated from `src/` by `build.mjs` (`prepare` and `prepack` both run
it). It is not version-controlled.