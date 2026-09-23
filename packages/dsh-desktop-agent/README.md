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
| yes | screenshot + a JSON action |
| no, or the field is absent | the driver's element table and markdown tree |

"Absent" is treated as "cannot see" on purpose. The host rewrites an image sent to
a route that does not accept one into placeholder text, after which the model is
describing a picture it never received — and answering confidently about it.

## Requirements

The profile must mount the Cua Driver computer-use provider; the plugin dispatches
to the `cua_driver_native__*` tools it publishes and has no driver of its own.

## Settings

`Settings → Plugins → desktop-agent → configuration`:

| Field | Meaning |
| --- | --- |
| Vision provider / model | The route used for each decision, chosen from the models that declare image input. All empty = the session's own current route. |
| Vision reasoning effort | Optional, and only offered for models that declare one. |
| Max steps | Actions per run; defaults to 40. |
| Screenshot long edge | Pixels; defaults to 1568. Lower saves tokens, but too low hides the controls. |
| Delivery | `background` (default) never steals focus; `foreground` is required by surfaces that filter per-process-routed input, such as canvas apps and games. |

## Tool

`desktop_agent({ app, goal, windowId })` resolves one window, runs the
observe/decide/act loop until `DONE`/`BLOCKED` or a cap is reached, and returns a
structured trace. `app` accepts an application name or a window title; omitting
it uses the frontmost window.

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
