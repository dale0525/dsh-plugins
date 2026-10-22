# @logictan/dsh-ssh

SSH for the DSH agent: four tools that run commands and move files on hosts the
user configured, with the password kept out of the conversation.

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
| `ssh_upload` | copy one local file to the host over SFTP |
| `ssh_download` | copy one file from the host over SFTP |

Every tool takes an `alias`, never a hostname: the configured table is the whole
set of reachable machines.

`ssh_exec` is not interactive — no TTY, so a command that waits for input
(`sudo`'s password prompt, an editor, `read`, a pager) blocks until its timeout
and is then aborted. Each call opens its own connection and closes it, so no
state (working directory, environment, background jobs) survives between calls.

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
