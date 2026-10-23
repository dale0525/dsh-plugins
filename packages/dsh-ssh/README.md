# @logictan/dsh-ssh

SSH for the DSH agent: five tools that run commands, read files and move files
on hosts the user configured, with the password kept out of the conversation.

## Why not the `ssh` binary

The `secret-safe-ssh` skill this plugin replaces spawned the real `ssh` client
and fed the password through `SSH_ASKPASS` plus a Python helper. That route needs
OpenSSH, python and a POSIX shell on the machine running DSH — so it never worked
on Windows, and every call had to re-derive host facts from a YAML inventory
instead of from the plugin's own configuration.

This plugin speaks the protocol in-process with [`ssh2`](https://www.npmjs.com/package/ssh2),
which is pure JavaScript. The same code path runs on macOS, Linux and Windows, and
the password never reaches a command line, an environment variable or a temporary
file — it goes from the credential store into the connection options and nowhere
else.

`ssh2` is bundled into `lib/index.js` rather than declared as a dependency, so
this package installs with nothing to compile and no build script to approve. That
is not an optimisation: `ssh2` ships an `install` script that pnpm refuses to run
unless the user's profile has allow-listed it, and its refusal fails the whole
install (`ERR_PNPM_IGNORED_BUILDS`). The script only tries to compile an optional
native crypto binding — the plugin runs on the pure-JS fallback, verified for exec
and SFTP — so depending on `ssh2` would make every install fail on behalf of a
binding nobody needs. Details in `build.mjs`.

## Settings

`Settings → Plugins → dsh-ssh`:

| Field | Meaning |
| --- | --- |
| alias | the handle the agent uses (`ssh_exec({ alias: "nas", … })`); letters, digits, `.`, `-`, `_` |
| host | hostname or address |
| port | defaults to 22 |
| username | login user |
| password | not a config field — a credential per host; see below |

Each host's password lives in `$DSH_HOME/.credentials.yaml` as
`SSH_PASSWORD_<ALIAS>` (the alias upper-cased, every other character folded to
`_`), entered in the same card and never read back. Storing it as a config field
would defeat that: a config value is redacted from settings *reads*, but the
plaintext still sits in `cordis.patch.yml`, which the config sync exports
verbatim.

Two aliases that fold to the same reference (`a-b` and `a.b`) are rejected: they
would silently share one password.

## Tools

| Tool | Purpose |
| --- | --- |
| `ssh_list` | the configured hosts, their alias/host/port/username, and whether a password is stored. Opens no connection. |
| `ssh_exec` | run one shell command; returns exit code, stdout and stderr |
| `ssh_read` | read a remote text file as a line-numbered window, the same shape as the local `read` tool |
| `ssh_upload` | copy one local file to the host over SFTP |
| `ssh_download` | copy one file from the host over SFTP |

Every tool takes an `alias`, never a hostname: the configured table is the whole
set of reachable machines.

`ssh_exec` is not interactive — no TTY, so a command that waits for input
(`sudo`'s password prompt, an editor, `read`, a pager) blocks until its timeout
and is then aborted. Each call opens its own connection and closes it, so no
state (working directory, environment, background jobs) survives between calls.

`ssh_exec` takes `workdir` instead of a `cd /x && …` prefix, matching the local
bash tool. The SSH `exec` request has no working-directory field, so the plugin
puts a quoted `cd` in front of the command and exits non-zero if the directory
does not exist — running the command somewhere else and succeeding would be
worse than failing.

`ssh_read` exists so that reading a remote file does not mean `cat` through
`ssh_exec`: it returns the same `<path>/<content>` envelope, 1-based line
numbers, and `offset`/`limit` paging the local `read` tool uses. Only the head of
the file is transferred (512 KiB), so a larger file gets a footer saying the
later lines were not scanned rather than a false "end of file".

`ssh_read`, `ssh_upload` and `ssh_download` need the server's SFTP subsystem.
Embedded and minimal systems often have none — OpenWrt routers, for instance,
answer the subsystem request with exit code 127 — and on those hosts the three
tools fail with a message naming the missing subsystem. `ssh_exec` still works,
so reading falls back to `sed -n '1,200p' file` and transferring to the host's
own means. The plugin does not detect this ahead of time: a host's subsystems are
only known by asking it, and a probe on every call would cost a round trip to
learn what the failing call already says.

The timeout budget is reported in the result header (`timeout_budget: 120s`),
never after the output — a trailing `timeout: 300s` reads as "this command timed
out", which is exactly what it does not mean. A multi-line command is echoed by
its first line plus a line count, so a heredoc does not bury the output it
produced.

## Host key verification

ssh2 accepts any host key unless told otherwise, which with password
authentication means handing the password to whoever answers on the address. The
plugin records the first key it sees per `host:port` in
`$DSH_HOME/dsh-ssh/known-hosts.json` and refuses every later connection that
presents a different one — OpenSSH's `accept-new` policy.

This cannot protect the very first connection; it protects every one after it,
and it turns a rebuilt host (or an impostor) into an error naming both
fingerprints instead of a leaked password. The file is deliberately per device
and not synced: trust is a local judgement.

After a legitimate rebuild, delete that address's entry from the file and
reconnect.

## Scope

Password authentication only, one hop, no jump hosts, no key files, no
port forwarding, no `sudo` handling. A pooled connection is out of scope too:
each operation connects, runs, and disconnects.
