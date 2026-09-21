# @logictan/dsh-browser-agent

A DSH browser agent that drives **your own Chrome** over CDP. Each page
observation builds an indexed table of the visible controls; one TypeSafe
`/v1/systemone` request decides both the **operation** (CLICK / TYPE_TEXT /
SELECT / SCROLL_UP / SCROLL_DOWN / WAIT / DONE / BLOCKED) and the **target**
element index; only `TYPE_TEXT` asks a second model for the field value, and
that model comes from DSH's own `ctx.llm` service rather than a second key.

## Why it connects instead of launching

Launching a browser cannot carry your login state. The `browser-use` provider's
launch mode hard-codes `--isolated`, whose documented meaning is *keep the
browser profile in memory, do not save it to disk*. Attaching to an
already-running Chrome is the only shape that uses a profile that persists.

macOS Chrome refuses `--remote-debugging-port` on the **default** profile
(`DevTools remote debugging requires a non-default data directory`), so the
supported shape is a dedicated `--user-data-dir` profile:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.dsh/chrome-agent-profile"
```

Log in once in that window; the login survives restarts because the profile is
on disk. The profile does **not** travel with config sync — logging in is a
per-device, one-time step.

The plugin never closes that browser. It disconnects the CDP session when a run
ends, so your window and tabs are left exactly as they were.

## Settings

`Settings → Plugins → browser-agent → configuration`:

| Field | Meaning |
| --- | --- |
| TypeSafe key | `role('secret')`; stored locally, never synced, never read back |
| TypeSafe endpoint | defaults to `https://api.typesafe.ai/v1/systemone` |
| TypeSafe model | defaults to `jev-latest` |
| CDP endpoint | defaults to `http://127.0.0.1:9222` |
| Max steps | browser actions per run; defaults to 60 |
| Text provider / model / reasoning effort | route for the `TYPE_TEXT` field-value call, chosen from the live model catalog. All empty = the session's own current route. |

The TypeSafe key is a `role('secret')` field: it must be entered once per
device (DSH's config sync deliberately strips secret values), and it is never
read back into the card.

## Tool

`browser_agent({ url, goal })` navigates to `url`, runs the decision loop until
`DONE`/`BLOCKED` or a cap is reached, and returns a structured trace.

## Scope

v1 covers common HTML/ARIA controls, single-tab, single-frame pages. Iframes,
shadow roots, canvas, file uploads, nested scrolling, pop-ups and screenshots
are out of scope.
