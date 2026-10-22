# @logictan/dsh-modal-h3

MiniMax H3 Ref2VA video generation on [Modal](https://modal.com), as six native
`mcp__modal_h3__*` tools — one generation per Modal account, several accounts in
parallel, with the account pool kept in a credential instead of a config file.

Replaces the `scripts/modal_h3_*.py` + `.agents/skills/modal-minimax-h3-video`
route: the same contract, the same Modal App, the same accounts, but packaged as
a service any project can call and any device can sync.

## What it gives the model

```
mcp__modal_h3__generate_video         mcp__modal_h3__get_generation_task
mcp__modal_h3__list_generation_tasks  mcp__modal_h3__cancel_generation_task
mcp__modal_h3__accounts_status        mcp__modal_h3__accounts_sync
```

| Tool | What it does |
| --- | --- |
| `generate_video` | Validates the prompt and references, then spawns one generation. `dry_run: true` stops after the local validation — no network, no writes, no charge. |
| `get_generation_task` | Polls one task and reports `ffprobe` evidence once it completes. |
| `list_generation_tasks` | The local task records, newest first. Never contacts Modal. |
| `cancel_generation_task` | Cancels a recorded call. GPU time already spent is not refunded. |
| `accounts_status` | Per-account deployment state and in-flight count. `live: true` probes Modal; without it you see the last cached probe. |
| `accounts_sync` | Deploys the App and verifies its model artifacts for one or all accounts. Idempotent, takes up to a few hours, needs `pixi` on `PATH`. |

Submit and poll are separate calls, so several accounts can be busy at once:
`generate_video` with `wait_for_completion: false` returns as soon as the call is
spawned, and `get_generation_task` collects it later.

## The account pool

`Settings → Plugins → modal-h3` takes one JSON value, stored as the
`MODAL_H3_ACCOUNTS` credential:

```json
{"tokens": [
  {"name": "acc1", "token_id": "ak-...", "token_secret": "...", "monthly_credit_usd": 30},
  {"name": "acc2", "token_id": "ak-...", "token_secret": "..."}
]}
```

`name` is what task records refer to, so renaming an account orphans its
in-flight tasks.

`monthly_credit_usd` is the account's cycle budget in dollars, declared by hand
because Modal exposes no plan allowance through its API: the billing endpoints
return only `metered_cost` and `billed_cost`, and the cycle-budget RPCs need an
environment id that costs a round trip to resolve. Nothing enforces the value. It
is carried in the pool rather than in config so it travels with the tokens on
config sync, and `accounts_status` reports it as `$<n>/cycle` so the model can
see which accounts are cheap to spend. An account without it simply says nothing.

To read an account's real spend, run its billing summary:

```bash
cd packages/dsh-modal-h3
MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... \
  pixi exec -s "python=3.11" -s "modal-client==1.5.5" python -m modal billing summary
```

`Credits` is the allowance already consumed this cycle, so an account whose
`Credits` equals its declared `monthly_credit_usd` is at its limit — that is the
state a spent account shows right before submissions start failing with
`workspace billing cycle spend limit reached`.

Four properties of this arrangement are deliberate:

- **It is a credential, not a config field.** A `role('secret')` config field
  would write the tokens into the profile's `cordis.patch.yml` in plaintext. As a
  credential the pool lives in `$DSH_HOME/.credentials.yaml`, travels with config
  sync's credentials section, and never appears in a patch row.
- **It is ONE credential holding N accounts**, because credential refs cannot be
  enumerated — a pool split across N refs could not be listed back, and the card
  could not show what is configured.
- **No token reaches disk.** The pool is passed to the child process as
  `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`; `~/.modal.toml` is neither written nor
  read. Modal's client resolves env before that file, so the pool also overrides
  whatever login the machine already has.
- **The card is write-only.** `credentials.describe` reports that a value exists
  and never returns it, so the textarea is never pre-filled; pasting a new pool
  replaces the old one wholesale.

Get tokens from <https://modal.com/settings/tokens>.

## Deployment

An account can only generate after its App is deployed. Two different things
answer "is this account usable", and they cost very differently:

| Question | Command | Cost |
| --- | --- | --- |
| Is the App deployed? | `accounts_status` with `live: true` | one metadata lookup per account |
| Deploy it (or re-verify it) | `accounts_sync` | a rolling deploy plus a full sha256 pass over ~59 GB |

`accounts_status` is the health check; `accounts_sync` is not. It is idempotent —
`bootstrap` skips artifacts whose size and sha256 already match — so re-running it
after a partial failure only re-verifies, but it is still the expensive path.

Deployment state is decided by probing, not by a local record. A fresh device
therefore needs no deploy at all for an account that is already deployed
elsewhere: `Function.from_name(...).hydrate()` answers that question for any
account. Only a genuinely new account needs `accounts_sync` once.

## Concurrency

Each account's worker is `max_containers=1`, so one generation per account at a
time; the width of the pool is the parallelism. `generate_video` picks the least
busy account (ties broken by least recently used) unless `account` names one.

A task is bound to the account that spawned it — a Modal function call id only
resolves inside its own workspace — so removing an account from the pool leaves
its in-flight tasks readable but unpollable, with an explicit error rather than a
crash. The token for an account is re-read on every poll, so rotating a token in
the pool takes effect immediately, including for tasks submitted before the
rotation.

## Contract

The route is MiniMax H3 Ref2VA Turbo6, and the values below are the vendored
contract's, not this package's choices:

| | |
| --- | --- |
| Resolution / rate | 1344x768, 24 fps, 96 output frames, native stereo audio |
| Duration | 4–15 s, quantised to whole frames |
| References | up to 9 images, 3 videos, 3 audios, 12 files total |
| Attempts / budget | 2 attempts, USD 3.00 per generation |
| Modes | Ref2VA only |

The prompt must carry six sections in this order, each heading on its own line as
`name:` — `subject_definitions`, `summary`, `retention_analysis`,
`detailed_description`, `overall_soundscape`, `non_diegetic_music` — and state
`effective duration of N seconds`, where N is what `dry_run` reports. Reference
labels `<Picture n>` / `<Video n>` / `<Audio n>` must first appear in order from 1.
First and last frame targets are best effort only.

T2VA / I2VA / FL2VA / L2VA / Hybrid and exact keyframe locks are not supported.
The plugin announces all of this in the system prompt (`src/guidance.js`) rather
than only rejecting bad prompts, because a model that learns the shape from a
rejection writes the prompt twice.

## Local files

| Path | Contents |
| --- | --- |
| `$DSH_HOME/.credentials.yaml` | The account pool, under `MODAL_H3_ACCOUNTS` |
| `$DSH_HOME/dsh-modal-h3/tasks/<taskId>/` | `job.json`, `meta.json`, `request.json`, `call.json`, `output.mp4`, `report.json` |
| `$DSH_HOME/dsh-modal-h3/pool.json` | Cached probe results and last-used order |

Task directories are named `h3-<timestamp>-<hex>` and carry no project name —
every project calls this plugin, so nothing here belongs to one of them. `out_dir`
copies the delivered MP4 and report elsewhere; the task directory keeps its own
copy either way.

## Requirements

- `pixi` on `PATH`. The runner executes inside a pinned environment
  (`python=3.11`, `pillow`, `ffmpeg`, `modal-client==1.5.5`), resolved and
  cached on first use — so the first call after install is slower than later
  ones. `dry_run` needs this too: it runs the real admission locally.
- A Modal account with the App deployed (`accounts_sync`).

`app/` and `assets/` ship from the package root and are the deployed App itself:
`app/modal_h3_app.py` and the contract beside it are drop-in replacements for the
copies that used to live in the calling repository. Any fix to the App has to be
made here.

## Tests

`npm test` runs both halves: the JS suite (`node --test`, covering the pool,
task state, tool definitions, and the runner command line) and the Python suite
(`python3 -m unittest discover -s tests`, covering reference inspection inside the
vendored contract). The Python tests skip themselves when Pillow or ffprobe is
absent, so a machine without them still gets a green run rather than a false one.

## License

MIT. See [LICENSE](./LICENSE).
