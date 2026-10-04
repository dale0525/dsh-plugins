# @logictan/dsh-desktop-agent

A DSH desktop agent that drives **one window on your own desktop** through the
Cua Driver tools, using **screenshots as its primary sense**.

Each step captures the target window, sends the picture to a vision-capable model
from DSH's own model directory, and performs the click, key, or text entry the
model chose. Nothing is hard-coded to a particular model and there is no second
API key: every call goes through `ctx.llm`.

## Why screenshots instead of the accessibility tree

The accessibility tree is the right sense for ordinary applications, and this
plugin still uses it — but it cannot see a game. A game is a self-drawn surface:
it exposes no meaningful actionable nodes, and most native games additionally
filter input that is routed by process id. For those targets the only channel that
carries any information is the picture itself.

So the plugin routes by capability rather than by configuration:

| The resolved model declares `image` | Channel |
| --- | --- |
| yes | screenshot + the element anchors + a JSON action |
| no, or the field is absent | the driver's element table and markdown tree |

"Absent" is treated as "cannot see" on purpose. The host rewrites an image sent to
a route that does not accept one into placeholder text, after which the model is
describing a picture it never received — and answering confidently about it.

### Both senses arrive together

The vision channel used to ask for the screenshot alone, which left the model
estimating every coordinate from the picture — the documented failure mode of
vision models, and a real one here: asked for the centre of the largest button in
a 1567×894 screenshot, a live model answered `(310, 1062)`, a y past the bottom
of the image.

One capture now returns the screenshot AND the window's own controls, each with a
`token`, a `role`, a `label`, and its `frame` in the same pixel space. A
decision may address a control by its token instead of guessing a coordinate, and
the token names the element the driver itself identified. A token that has been
superseded by a newer capture is refused with `stale_element_token` rather than
mis-clicking, which is one more reason the loop re-observes every step.

Measured cost of the extra walk, on the heaviest tree available here (a browser
window): 0.5–3.7 s, returning ~174 anchors and ~18 KB at the 300-element cap. The
same walk uncapped returned 1130 nodes and 68 KB, which buys nothing — an element
with no label cannot be named in a decision, and the screenshot already shows it.
Only elements carrying both a token and a non-empty label become anchors.

## Requirements

None beyond installing this plugin. It publishes the `cua_driver_native__*` tools
itself, from the Cua Driver native SDK it depends on, and dispatches to them.

A profile that still mounts the old
`@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` provider must drop
that row and its `@deepseek-ai/dsh-computer-use` dependency first: both would
publish the same tool names, and the second registration is refused with
`tool "cua_driver_native__click" is already registered`.

## Settings

`Settings → Plugins → desktop-agent → configuration`:

| Field | Meaning |
| --- | --- |
| Vision provider / model | The route used for each decision, chosen from the models that declare image input. All empty = the session's own current route. |
| Vision reasoning effort | Optional, and only offered for models that declare one. |
| Max steps | Actions per run; defaults to 40. |
| Screenshot long edge | Pixels; defaults to 1568. Lower saves tokens, but too low hides the controls. |
| Delivery | `background` (default) never steals focus; `foreground` is required by surfaces that filter per-process-routed input, such as canvas apps and games. |
| Allow bring-to-front | Off by default. When on, the model may use `bring_to_front` to raise the target window. It verifiably **steals your foreground**, so it is opt-in. |

## Tool

`desktop_agent({ app, goal, windowId })` resolves one window, runs the
observe/decide/act loop until `DONE`/`BLOCKED` or a cap is reached, and returns a
structured trace. `app` accepts an application name or a window title; omitting
it uses the frontmost window.

### When to call it

For any desktop task that takes more than about two steps, call `desktop_agent`
rather than driving the `cua_driver_native__*` tools yourself. The loop's ~40
captures and decisions stay inside this one call; driving the raw tools by hand
puts every screenshot into the agent's own context instead. The raw tools remain
the right choice for resolving a window, or for a single action already decided on.

For a task that lives in a web page, `browser_agent` is the better tool — it
drives the DOM over CDP and does not depend on reading pixels. This tool is for
native windows, desktop applications, and games.

### What it does not do

It does not verify the goal. `done` is the model's own claim about the screenshot
it was shown, and the trace reports it as such. The driver's `verify_state` is
deliberately not used as a second opinion: measured against the one Electron window
available it answered `unknown` (`untrusted_source`) after ~5.6 s, so it would add
latency and a false sense of checking without checking anything.

Only on-screen windows are eligible. A covered window cannot be captured or acted
on, so the tool fails with the window named rather than screenshotting whatever
happened to be in front.

## Scope

v1 drives one window at a time, in the foreground of that window's own desktop,
and is meant for tasks whose decisions are measured in seconds — turn-based and
strategy games, simulations, settings panels, file managers.

It is not for real-time action games: one vision decision costs 300–800 ms, an
order of magnitude away from human reaction time. It does not read or write
process memory, and it makes no attempt to evade anti-cheat protection.

## Coordinates

Action coordinates are pixels in the screenshot the model was shown, measured
from its top-left corner. The driver resolves them against the capture the caller
last saw, so every step re-observes before it acts — a new capture of a window
also invalidates the element tokens of the previous one.
