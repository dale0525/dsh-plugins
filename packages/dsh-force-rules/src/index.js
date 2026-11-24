/**
 * dsh-force-rules — deterministic enforcement of six prose rules.
 *
 * Six prose rules in the operating instructions are mechanized here, because
 * prose is advisory and each of these has already failed in practice:
 *
 *  1. A subagent seat is never one-shot. On dsh 0.2.0 `run_in_background: false`
 *     is the only switch into the one-shot path, whose run id cannot be
 *     continued with `send_message` and whose settlement is never announced to
 *     the delegating session — so the delegator blocks until the execution cap
 *     expires. This plugin denies that call before dispatch. dsh 0.2.1 removed
 *     both the parameter and the path, so on that generation the rule is
 *     satisfied by construction and nothing is denied.
 *  2. A delegating session must not poll or spin while a seat runs.
 *  3. Silence must have an upper bound: a seat that dies without ever emitting
 *     `subagent/end` would otherwise leave the delegator waiting forever.
 *
 *  4. A seat receives only the authority its own instruction declares. The
 *     delegating instruction opens with a profile marker -- `[只读]` (the
 *     default when no marker is present), `[审核]`, or `[编辑: <paths>]` --
 *     and every call the seat makes is checked against that profile.
 *
 *  5. A delegation that can select the child's model must name the route it
 *     selected. The host treats the selection as optional and lets the seat
 *     inherit a default, so an unnamed route silently runs the seat on a model
 *     the delegator never chose, and nothing surfaces that until its output is
 *     read. `provider` and `model` are one unit -- either half alone identifies
 *     no route. `reasoning_effort` is required only for a route whose model
 *     advertises efforts: the host rejects any effort on a model that has none,
 *     so a blanket requirement there would be a denial no value could satisfy.
 *
 * Rules 2 and 3 are one mechanism: the plugin keeps one durable self-waking
 * checkpoint on each delegating session for exactly as long as that session has
 * a live seat. A seat that reports normally removes it; a seat that dies
 * silently leaves it to fire.
 *
 *  6. Decompose before acting, and say who does each line. A session that never
 *     writes a list never has a line to hand to a seat, so the whole task runs
 *     single-threaded -- measured: a 25-minute session spent 846 of 1507 seconds
 *     in the model re-deriving the same unresolved questions, while 44% of its
 *     tool calls sat on lanes that could have run in parallel.
 *
 * How an answer is *written* is deliberately not enforced here. That belongs to
 * the prose rules in the operating instructions, which reach the model through
 * the system prompt on every step; a listener at the turn boundary would have to
 * send the model back for a second step, and the user would read two answers.
 *
 * @module @logictan/dsh-force-rules
 */

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { defineTool } from '@deepseek-ai/dsh-tools';

const execFileAsync = promisify(execFile);

const SHELL_TOOLS = new Set(['bash', 'pwsh']);
const WORKSPACE_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch', 'notebook_edit']);
const GIT_TIMEOUT_MS = 2500;
const MAX_STAT_FILES = 64;
const DEBUG_MARKER_RE = /\[DEBUG-[A-Za-z0-9_-]*/;
const TEST_COMMAND_RE =
  /^(?:[A-Z_][A-Z0-9_]*=\S+\s+)*(?:(?:pnpm|npm|yarn|bun)\s+(?:[^\n;&|]*\s+)?(?:run\s+)?test\b|node\s+(?:[^\n;&|]*\s+)?--test\b|(?:npx|pnpm\s+exec)\s+(?:vitest|jest|mocha|ava|tap|playwright\s+test)\b|(?:vitest|jest|pytest|cargo\s+test|go\s+test|rspec|phpunit|\.?\/?gradlew?\s+test)\b)/;
const NON_TEST_FLAGS_RE = /(?:^|\s)(?:--help|-h|--list|--watch|-w)(?:\s|$)|[<>]/;
const READONLY_SHELL_RE = /^(?:git\s+(?:status|diff|log|show|rev-parse|branch)\b|ls\b|pwd\b|cat\b|head\b|tail\b|rg\b|grep\b|find\b|wc\b)/;

/**
 * Strip single- and double-quoted segments so subcommand matching ignores
 * text inside arguments such as `echo "git commit"` or `-m "git commit"`.
 *
 * @param {string} command
 * @returns {string}
 */
function stripQuotedStrings(command) {
  let out = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote !== null) {
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        out += '  ';
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      out += ' ';
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Normalize a shell test command for duplicate re-run detection.
 * Returns `null` when the command is not a test runner invocation.
 *
 * @param {unknown} rawCommand
 * @returns {string | null}
 */
function normalizeTestCommand(rawCommand) {
  if (typeof rawCommand !== 'string') return null;
  const trimmed = rawCommand.trim().replace(/\s+/g, ' ');
  if (!trimmed || NON_TEST_FLAGS_RE.test(trimmed)) return null;
  if (!TEST_COMMAND_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Resolve the effective working directory for a shell tool call without
 * adding `workingDirectory` to the plugin's required `inject` list.
 *
 * @param {any} ctx
 * @param {any} exec
 * @returns {Promise<string | undefined>}
 */
async function resolveEffectiveWorkdir(ctx, exec) {
  const wdService = ctx.get('workingDirectory');
  let sessionCwd;
  if (wdService !== undefined && exec.agent !== undefined) {
    if (typeof wdService.get === 'function' && exec.agent.session !== undefined) {
      sessionCwd = wdService.get(exec.agent.session);
    }
    if (sessionCwd === undefined && typeof wdService.ensure === 'function') {
      try {
        sessionCwd = await wdService.ensure(exec.agent, exec.signal);
      } catch {
        sessionCwd = undefined;
      }
    }
  }
  if (sessionCwd === undefined) sessionCwd = exec.agent?.session?.header?.cwd;
  const argWorkdir = typeof exec.arguments?.workdir === 'string' && exec.arguments.workdir.trim()
    ? exec.arguments.workdir.trim()
    : undefined;
  if (argWorkdir === undefined) return sessionCwd;
  if (path.isAbsolute(argWorkdir)) return argWorkdir;
  return sessionCwd ? path.resolve(sessionCwd, argWorkdir) : argWorkdir;
}

/**
 * Run a short, non-interactive git query and return stdout, or `null` on error.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string | null>}
 */
async function runGit(cwd, args, signal) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      signal,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Compute a lightweight workspace fingerprint combining git HEAD, porcelain
 * status, modified-file mtime/size, and session mutation epoch.
 *
 * @param {string | undefined} cwd
 * @param {AbortSignal | undefined} signal
 * @param {number} mutationEpoch
 * @returns {Promise<string>}
 */
async function computeWorkspaceFingerprint(cwd, signal, mutationEpoch) {
  if (!cwd) return `nogit:|e:${mutationEpoch}`;
  const topOut = await runGit(cwd, ['rev-parse', '--show-toplevel'], signal);
  if (topOut === null) return `nogit:${cwd}|e:${mutationEpoch}`;
  const repoRoot = topOut.trim();
  const [headOut, statusOut] = await Promise.all([
    runGit(repoRoot, ['rev-parse', 'HEAD'], signal),
    runGit(repoRoot, ['status', '--porcelain=v1', '-uall'], signal),
  ]);
  const head = headOut ? headOut.trim() : 'UNBORN';
  const status = statusOut ?? '';
  const lines = status.split('\n').filter(Boolean).slice(0, MAX_STAT_FILES);
  const stats = await Promise.all(
    lines.map(async (line) => {
      const rawPath = line.slice(3).trim();
      const targetPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop().trim() : rawPath;
      try {
        const st = await stat(path.join(repoRoot, targetPath));
        return `${targetPath}:${st.mtimeMs}:${st.size}`;
      } catch {
        return `${targetPath}:missing`;
      }
    }),
  );
  return `git:${repoRoot}|${head}|${status}|${stats.join(',')}|e:${mutationEpoch}`;
}

/**
 * Inspect whether a shell command contains an actual `git commit` invocation.
 *
 * @param {unknown} rawCommand
 * @returns {{ gitCwd: string | undefined, includeUnstaged: boolean } | null}
 */
function inspectGitCommitCommand(rawCommand) {
  if (typeof rawCommand !== 'string') return null;
  const unquoted = stripQuotedStrings(rawCommand);
  const commitMatch = unquoted.match(
    /(?:^|[;&|\n])\s*(?:[A-Z_][A-Z0-9_]*=\S+\s+)*git((?:\s+(?:-C\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)))*)\s+commit(\b[^\n;&|]*)/,
  );
  if (!commitMatch) return null;
  const preOpts = commitMatch[1] ?? '';
  const commitArgs = commitMatch[2] ?? '';
  if (/(?:^|\s)(?:--help|-h|--dry-run)(?:\s|$)/.test(commitArgs)) return null;
  const cFlagMatch = preOpts.match(/-C\s+(\S+)/);
  const hasAllFlag = /(?:^|\s)(?:--all|-[a-zA-Z]*a[a-zA-Z]*)(?:\s|$)/.test(commitArgs);
  const hasChainedAdd = /(?:^|[;&|\n])\s*(?:[A-Z_][A-Z0-9_]*=\S+\s+)*git(?:\s+-C\s+\S+)*\s+add\b/.test(unquoted);
  return {
    gitCwd: cFlagMatch ? cFlagMatch[1] : undefined,
    includeUnstaged: hasAllFlag || hasChainedAdd,
  };
}

/**
 * Scan unified diff text (`-U0`) for added lines containing `[DEBUG-` markers.
 * Deleted lines (`-`) and file headers (`+++ `) are ignored so cleanup commits pass.
 *
 * @param {string} diffText
 * @returns {Array<{ file: string, snippet: string }>}
 */
function findDebugMarkersInDiff(diffText) {
  const hits = [];
  let currentFile = '<unknown>';
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (!line.startsWith('+')) continue;
    const content = line.slice(1);
    if (DEBUG_MARKER_RE.test(content)) {
      hits.push({ file: currentFile, snippet: content.trim().slice(0, 120) });
      if (hits.length >= 5) break;
    }
  }
  return hits;
}

/**
 * Rule 8: deny `git commit` when staged (or auto-staged via `-a`/`git add &&`)
 * additions contain temporary `[DEBUG-...` instrumentation markers.
 *
 * @param {any} ctx
 * @param {any} exec
 * @returns {Promise<string | undefined>}
 */
async function checkCommitDebugMarkers(ctx, exec) {
  if (!SHELL_TOOLS.has(exec.name)) return undefined;
  const info = inspectGitCommitCommand(exec.arguments?.command);
  if (info === null) return undefined;
  const baseCwd = await resolveEffectiveWorkdir(ctx, exec);
  const effectiveCwd = info.gitCwd
    ? (path.isAbsolute(info.gitCwd) ? info.gitCwd : (baseCwd ? path.resolve(baseCwd, info.gitCwd) : info.gitCwd))
    : baseCwd;
  if (!effectiveCwd) return undefined;

  const stagedDiff = await runGit(effectiveCwd, ['diff', '--cached', '-U0', '--no-color'], exec.signal);
  const hits = stagedDiff ? findDebugMarkersInDiff(stagedDiff) : [];
  if (hits.length === 0 && info.includeUnstaged) {
    const unstagedDiff = await runGit(effectiveCwd, ['diff', '-U0', '--no-color'], exec.signal);
    if (unstagedDiff) hits.push(...findDebugMarkersInDiff(unstagedDiff));
  }
  if (hits.length === 0) return undefined;

  const summary = hits.map((h) => `${h.file}: ${h.snippet}`).join('; ');
  return [
    'Commit blocked: temporary `[DEBUG-` instrumentation marker found in added lines',
    `(${summary}).`,
    'Remove all temporary `[DEBUG-` logs and re-stage before committing.',
  ].join(' ');
}

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'force-rules';

/**
 * The tool registry (to identify delegation tools from their own declaration)
 * and the live agent registry (to resolve a child's durable parent).
 *
 * `systemPrompt` is deliberately NOT injected. This plugin only listens on the
 * `system-prompt/assemble` event; it never calls the service. Injection means
 * "required", so a host without that service would disable this plugin entirely
 * — losing the one-shot ban and the wait bound along with the annotation. The
 * host's own listeners (`dsh-agent-preset-registry`, `dsh-session-reference`)
 * subscribe the same way without injecting it.
 */
export const inject = ['tools', 'agents'];

/**
 * Runtime-context slot the host reserves for delegation guidance.
 *
 * Resolved by name through `getContextOrder` rather than hardcoded, so the
 * plugin follows the host's own placement if it ever moves. The host fills this
 * slot today with a depth-ceiling warning only — it says when to stop
 * delegating, never when to start — so this contribution is the missing half of
 * a slot the host already allocates and re-assembles on every step.
 */
const DELEGATION_CUE_SLOT = 'SUBAGENT_DELEGATION';

/**
 * Tool results a `[root]` line must have cost before the cue names it.
 *
 * Below this the line has not spent anything worth handing over, and naming it
 * would be an accusation the model can correctly ignore. The threshold is the
 * same order of magnitude as the "three independent sources" test in the
 * criterion, so a line that crosses it is one the criterion already covers.
 */
const CUE_AFTER_CALLS = 8;

/**
 * Silence allowed before the checkpoint wakes the delegating session.
 *
 * An hour, not minutes: the wake-up is a durable session message, so one that
 * lands just as the last seat settles cannot be retracted by deleting the task.
 * A long bound keeps that race rare while still bounding the silence of a seat
 * that dies without ever settling.
 */
const CHECKPOINT_SECONDS = 3600;

/** Durable title identifying this plugin's checkpoint among a session's reminders. */
const CHECKPOINT_TITLE = 'subagent checkpoint';

/**
 * Stable identity for a checkpoint whose title a renewing model may replace.
 *
 * Matched as a prefix so a row written under an earlier wait bound (a different
 * minute count in the first line) is still recognized and cleaned.
 */
const CHECKPOINT_PROMPT_PREFIX = 'A subagent seat you delegated has not reported within';

/** What the woken delegating session is told to do. */
const CHECKPOINT_PROMPT = [
  `${CHECKPOINT_PROMPT_PREFIX} 60 minutes.`,
  'Check the seats with `list_agents`:',
  '- finished: continue from its settlement notification;',
  '- still running: renew this checkpoint with `schedule_create` and wait again;',
  '- terminated abnormally or unreachable: apply the retry policy (retry, and only open a new seat after 3 failed attempts).',
  'Do not poll repeatedly; this checkpoint is the only wake-up you need.',
].join('\n');

/**
 * Whether one JSON Schema node declares a subagent seat as its outcome.
 *
 * Only `properties.kind.const` counts, plus the `oneOf` / `anyOf` / `allOf`
 * branches that host generations use to list outcomes. A recursive scan for any
 * `const` anywhere would treat an unrelated tool that happens to output the
 * string "activation" as a delegation tool, and a seat would then be allowed to
 * call that tool outside the allow-list.
 *
 * Two constants mean the same thing across host generations: `continuable` on
 * dsh 0.2.0, where the tool also offered a one-shot path, and `activation` on
 * 0.2.1, where every delegation starts an independently managed subagent and the
 * one-shot path is gone. Both are recognised because `latest` still resolves to
 * 0.2.0 and this package declares no host generation of its own.
 *
 * @param node - one JSON Schema node from a tool's output declaration.
 * @returns whether the schema can produce a seat.
 */
function declaresSeat(node) {
  if (Array.isArray(node)) return node.some(declaresSeat);
  if (node === null || typeof node !== 'object') return false;
  const kind = node.properties?.kind;
  if (kind?.const === 'continuable' || kind?.const === 'activation') return true;
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(node[key]) && node[key].some(declaresSeat)) return true;
  }
  return false;
}

/**
 * Whether this delegation tool still offers the one-shot switch.
 *
 * Read from the tool's own parameter declaration, for the same reason the seat
 * check reads the output declaration: the name alone would also match `bash`,
 * and a host generation without the switch must not be gated on it.
 *
 * @param ctx - the plugin context.
 * @param exec - the pending call.
 * @returns whether the tool declares `run_in_background`.
 */
function declaresBackgroundSwitch(ctx, exec) {
  return ctx.tools.get(exec.name, exec.agent)?.parameters?.properties?.run_in_background !== undefined;
}

/**
 * Whether this call can start a subagent seat.
 *
 * The tool is resolved in the scope that owns it, and that scope differs by
 * seam. A pending call carries its calling agent in `exec.agent`. An assembly
 * entry does NOT: it is a detached `{ name, description, parameters }` record,
 * so reading `exec.agent` there silently resolves the GLOBAL view instead — and
 * a delegation tool registered into an agent's own layer is invisible from
 * there, which made every annotation below a no-op on hosts that compose tools
 * per agent. The assembly seam therefore passes its own `context.scope`.
 *
 * @param ctx - the plugin context.
 * @param exec - the pending call, or an assembly entry naming the tool.
 * @param scope - the scope that owns the tool; defaults to the calling agent.
 * @returns whether the called tool is a delegation tool.
 */
function isDelegation(ctx, exec, scope = exec.agent) {
  const tool = ctx.tools.get(exec.name, scope);
  const schema = tool?.output?.schema;
  return schema !== undefined
    && declaresSeat(schema)
    && tool?.parameters?.properties?.prompt !== undefined;
}

/**
 * Tools that cannot change anything outside the seat's own conversation.
 *
 * The read-only profile is an allow-list, not a deny-list: a seat gets the
 * tools named here and nothing else. A deny-list would silently grant every
 * mutating tool the host adds later, which is the exact failure this profile
 * exists to prevent.
 */
const READ_ONLY_TOOLS = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
  'skill',
  'send_message',
  'structured_output',
  'todo_write',
  'ask_user_question',
  'list_agents',
  'list_subagent_models',
  'job_list',
  'job_output',
  'get_goal',
  // agy-link's mirror tool replays activity agy already recorded and throws for
  // an unknown run/step, so it performs no side effect: denying it prevents
  // nothing. It must stay allowed because agy re-emits one mirror call per
  // completed step, and a denial makes the seat retry that step forever
  // (observed: 136 denials, 9 minutes, manual interrupt).
  'agy_tool',
]);

/**
 * The programmatic-tool-calling transport.
 *
 * A seat running in PTC mode reaches every other tool through this one call, so
 * it must stay open to all profiles; the calls it dispatches are checked
 * individually against the same profile.
 */
const PTC_TRANSPORT = 'run_code';

/** The profile governing a seat whose instruction carries no known marker. */
const READ_ONLY = { kind: 'readonly' };

/** Marker heads accepted as the profile declaration of a delegating instruction. */
const PROFILE_MARKERS = new Map([
  ['只读', 'readonly'],
  ['readonly', 'readonly'],
  ['read-only', 'readonly'],
  ['审核', 'review'],
  ['review', 'review'],
  ['编辑', 'edit'],
  ['edit', 'edit'],
]);

/**
 * Commands that only observe, for the review profile.
 *
 * Every pattern anchors on the command word, so a mutating subcommand of the
 * same tool (git commit, git push, npm publish) cannot match by prefix.
 */
const DRY_RUN_COMMANDS = [
  /^git (status|diff|log|show|branch|remote|tag|stash|rev-parse|ls-files|blame|describe|shortlog|whatchanged)\b/,
  /^git config --(get|list)\b/,
  /^(ls|cat|head|tail|wc|grep|rg|find|fd|tree|stat|file|du|df|pwd|echo|which|type|env|printenv)\b/,
  /^(node|python|python3|pnpm|npm|go|cargo|rustc) (--version|-v|-V)\b/,
  /^(npm|pnpm) (ls|list|why|outdated|view|info)\b/,
  /^terraform (plan|validate|show|output|state list)\b/,
  /^kubectl (get|describe|logs|explain|api-resources)\b/,
  /^docker (ps|images|inspect|logs|version)\b/,
  /^gh (pr|run|issue|release|workflow) (view|list|diff|checks|status)\b/,
  /^(tsc --noEmit|eslint|prettier --check)\b/,
];

/**
 * Shell syntax that would let one permitted command run a second, unchecked one.
 *
 * A whitelist on the leading command word is not enough by itself: "git status
 * && rm -rf build" and "git log | sh" both open with a permitted command.
 * Written with \x60 for the backtick so this rule survives being quoted.
 */
const SHELL_CHAINING = /[;&|<>$\x60\n]/;

/** Tools that write one file, and the argument naming it. */
const WRITTEN_PATH_ARGUMENT = {
  write: 'file_path',
  edit: 'file_path',
  str_replace_editor: 'path',
};

/**
 * Normalize one path for comparison against an authorized entry.
 *
 * @param path - the path as the call supplied it.
 * @returns the path with separators unified and any leading "./" removed.
 */
function normalizePath(path) {
  return String(path)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/');
}

/**
 * Read the file set an edit marker authorizes.
 *
 * @param text - everything after the marker's colon.
 * @returns the normalized, non-empty paths.
 */
function parseProfilePaths(text) {
  return text
    .split(/[,\s]+/)
    .map((entry) => normalizePath(entry))
    .filter((entry) => entry.length > 0);
}

/**
 * Read the profile a delegating instruction declares.
 *
 * The instruction must OPEN with the marker: leading whitespace is tolerated,
 * but any other text before it makes the marker inert. Scanning the whole
 * instruction for a known marker instead would let a read-only brief that merely
 * quotes one grant the authority it was written to forbid — the brief "never use
 * [编辑: src/a.js]" escalated that seat to write authority on `src/a.js`
 * (measured). Anchoring to the start is what makes a mention inert, and it also
 * makes "which marker wins" unambiguous: there is only ever the first one.
 *
 * An instruction with no leading marker is read-only.
 *
 * @param instruction - the text of the seat's delegation prompt.
 * @returns the governing profile.
 */
function parseProfile(instruction) {
  if (typeof instruction !== 'string') return READ_ONLY;
  const match = /^\s*\[([^\]]*)\]/.exec(instruction);
  if (match === null) return READ_ONLY;
  const body = match[1].trim();
  const separator = body.indexOf(':');
  const head = (separator === -1 ? body : body.slice(0, separator)).trim().toLowerCase();
  const kind = PROFILE_MARKERS.get(head);
  if (kind === undefined) return READ_ONLY;
  if (kind !== 'edit') return { kind };
  return { kind, paths: parseProfilePaths(separator === -1 ? '' : body.slice(separator + 1)) };
}

/**
 * The instruction one seat was delegated with.
 *
 * Identified by `source.kind`, not by position: a child's later user-role
 * events are the runtime's own (`agent-instructions`, `plugin`) and a
 * continuation from the parent is a later message, so the delegating
 * instruction is the first child-owned message whose source is the user.
 *
 * A seat's own history begins after whatever it inherited: a forked seat is
 * seeded with its parent's turns, and the marker governing the fork is in the
 * delegation that follows them, never in the inherited history.
 *
 * @param session - the seat's session.
 * @returns the delegation instruction text, or undefined when there is none.
 */
function seatInstruction(session) {
  if (typeof session.snapshotEvents !== 'function') return undefined;
  const boundary = typeof session.inheritedEventCount === 'number' ? session.inheritedEventCount : 0;
  for (const event of session.snapshotEvents(boundary)) {
    if (event?.type !== 'user/message') continue;
    const data = event.data;
    if (data?.source?.kind !== 'user') continue;
    const blocks = data.content;
    if (!Array.isArray(blocks)) continue;
    const text = blocks
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');
    if (text.length > 0) return text;
  }
  return undefined;
}

/**
 * Whether one session is a delegated seat.
 *
 * Mirrors the host's own predicate: a seat is marked by `origin` or by a
 * non-zero `delegationDepth`, both written when the child session is created.
 * A durable `parentSession` is NOT that mark -- a forked or resumed
 * continuation of a conversation carries its predecessor's id while remaining
 * an ordinary session the user talks to, and constraining it would deny the
 * user their own session.
 *
 * @param session - the session to classify.
 * @returns whether a delegation started this session.
 */
function isSeat(session) {
  const header = session?.header;
  if (header === undefined) return false;
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0;
}

/**
 * The profile governing one call.
 *
 * Read once per seat and cached: the instruction cannot change while the seat
 * lives, and a session that no delegation started is never constrained.
 *
 * @param cache - seat session id -> profile.
 * @param agent - the agent making the call.
 * @returns the governing profile, or undefined for a non-seat session.
 */
function profileOf(cache, agent) {
  const session = agent?.session;
  if (session === undefined) return undefined;
  if (!isSeat(session)) return undefined;
  const id = session.id;
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  const profile = parseProfile(seatInstruction(session));
  cache.set(id, profile);
  return profile;
}

/**
 * Whether one command is a permitted dry run.
 *
 * @param command - the shell command the call supplied.
 * @returns whether it is a single, whitelisted, unchained command.
 */
function isDryRunCommand(command) {
  if (typeof command !== 'string') return false;
  if (SHELL_CHAINING.test(command)) return false;
  const trimmed = command.trim();
  return DRY_RUN_COMMANDS.some((pattern) => pattern.test(trimmed));
}

/**
 * Whether one path is inside the set an edit marker authorized.
 *
 * Compared by path suffix so that the same file named relatively, with a
 * leading "./", or by its absolute path all match. This is a guardrail against
 * a seat drifting outside its slice, not a filesystem sandbox.
 *
 * @param paths - the authorized paths.
 * @param candidate - the path the call supplied.
 * @returns whether the write is authorized.
 */
function isAuthorizedPath(paths, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const normalized = normalizePath(candidate);
  return paths.some((path) => normalized === path || normalized.endsWith('/' + path));
}

/**
 * Judge one call against the seat's profile.
 *
 * @param profile - the governing profile.
 * @param exec - the pending call.
 * @param ctx - the plugin context, used to identify delegation tools.
 * @returns a denial reason, or undefined to allow the call.
 */
function checkProfile(profile, exec, ctx) {
  const toolName = exec.name;
  if (toolName === PTC_TRANSPORT) return undefined;
  if (READ_ONLY_TOOLS.has(toolName)) return undefined;
  if (isDelegation(ctx, exec)) return checkChildAuthority(profile, exec.arguments?.prompt);
  if (profile.kind === 'review' && (toolName === 'bash' || toolName === 'pwsh')) {
    const command = exec.arguments?.command;
    if (isDryRunCommand(command)) return undefined;
    return [
      'The [审核] (review) profile governs this seat: it may run only read-only commands.',
      'Refused: ' + JSON.stringify(typeof command === 'string' ? command : null) + '.',
      'A permitted command is a single command from the dry-run set (git status/diff/log, ls, cat, grep, terraform plan, kubectl get, ...) with no shell chaining.',
      'Report the finding instead, or ask the delegator to re-issue the seat with [编辑: <paths>].',
    ].join(' ');
  }
  if (profile.kind === 'edit') {
    const argument = WRITTEN_PATH_ARGUMENT[toolName];
    if (argument !== undefined) {
      const candidate = exec.arguments?.[argument];
      if (isAuthorizedPath(profile.paths, candidate)) return undefined;
      return [
        'The [编辑] (edit) profile governs this seat: it may write only the files named in its instruction.',
        'Authorized: ' + (profile.paths.length === 0 ? 'none' : profile.paths.join(', ')) + '.',
        'Refused: ' + JSON.stringify(typeof candidate === 'string' ? candidate : null) + '.',
        'Report the needed change instead, or ask the delegator to re-issue the seat with that path added.',
      ].join(' ');
    }
  }
  const label = profile.kind === 'review' ? '审核' : profile.kind === 'edit' ? '编辑' : '只读';
  return [
    'The [' + label + '] profile governs this seat: ' + toolName + ' is not among the tools it may use.',
    'A seat receives only the authority its delegating instruction declares; an unmarked instruction is read-only.',
    'Grant more with [审核] (read-only commands) or [编辑: <paths>] (writing those files) in the delegating instruction.',
    'Report the blocked step to the delegator instead of working around it.',
  ].join(' ');
}


/**
 * Whether a tool's declared parameters include a child-route field.
 *
 * Keyed on the tool's own parameter schema, exactly as the delegation test is
 * keyed on its output schema: a tool that cannot accept a route has none to
 * name, and demanding one there would be a denial no value could satisfy.
 *
 * @param properties - the tool's declared parameter properties.
 * @returns whether the tool advertises `provider` and/or `model`.
 */
function declaresRoute(properties) {
  if (properties === undefined) return false;
  return properties.provider !== undefined || properties.model !== undefined;
}

/**
 * One route field, or undefined when the call named nothing usable.
 *
 * Whitespace-only counts as absent: the host rejects a zero-length value but
 * accepts `"   "`, which identifies no route while looking like it does.
 *
 * @param value - the value the call supplied.
 * @returns the value exactly as written, or undefined.
 */
function namedValue(value) {
  if (typeof value !== 'string') return undefined;
  return value.trim().length === 0 ? undefined : value;
}

/**
 * Judge the authority a seat grants to a child seat.
 *
 * Review and edit are not nested: review may run read-only commands but cannot
 * write, edit may write but cannot run commands. A rank comparison would let an
 * edit seat gain command execution through a review child, so only the same
 * profile or read-only is allowed. An edit child's paths must also be a subset
 * of its parent's, or the delegation would widen the files it may write.
 *
 * The host freezes `exec.arguments` and offers no replacement decision, so an
 * over-granting prompt is refused rather than rewritten.
 *
 * @param parent - the profile of the seat making the delegation.
 * @param childPrompt - the instruction the child seat would receive.
 * @returns a denial reason, or undefined when the child stays within the parent.
 */
function checkChildAuthority(parent, childPrompt) {
  const child = parseProfile(childPrompt);
  if (child.kind === 'readonly') return undefined;
  if (parent.kind === 'readonly' || child.kind !== parent.kind) {
    return [
      'This seat is governed by the [' + (parent.kind === 'review' ? '审核' : parent.kind === 'edit' ? '编辑' : '只读') + '] profile.',
      'A delegated seat may receive only the same profile or read-only.',
      'A child marker that exceeds the parent or grants a different non-read-only profile is refused.',
      'Keep the child at the parent profile or omit its marker, and report the blocked step to the delegator.',
    ].join(' ');
  }
  if (parent.kind === 'edit' && !child.paths.every((path) => isAuthorizedPath(parent.paths, path))) {
    return [
      'This seat may write only the files named in its own instruction.',
      'A delegated edit seat cannot name paths outside that set.',
      'Authorized: ' + (parent.paths.length === 0 ? 'none' : parent.paths.join(', ')) + '.',
    ].join(' ');
  }
  return undefined;
}

/**
 * Judge one delegation call against the pairing rule.
 *
 * An omitted route is not a defect: the host inherits the parent's route, which
 * is the delegator's own choice by construction. A *half* route is a defect —
 * `provider` without `model` identifies no route, and the host rejects it with
 * a less specific message further down. This gate therefore says nothing when
 * the call names neither field, and only speaks when the call names one.
 *
 * Effort is deliberately not required. Requiring it forced a route to be named
 * in every call, which cost 25 delegations across 524 sessions to a gate that
 * was protecting against a default the host had already chosen sensibly, and it
 * pushed the model into `list_subagent_models`, whose no-argument output
 * (`cpa — CPA`, a provider line) reads exactly like a model line and produced
 * two delegations to the non-existent route `cpa/CPA`. The host inherits the
 * parent's effort on an unchanged route, which is the same sensible default.
 *
 * @param ctx - the plugin context.
 * @param exec - the pending call.
 * @returns a denial reason, or undefined to allow the call.
 */
function checkRoute(ctx, exec) {
  if (!isDelegation(ctx, exec)) return undefined;
  const properties = ctx.tools.get(exec.name, exec.agent)?.parameters?.properties;
  if (!declaresRoute(properties)) return undefined;
  const args = exec.arguments;
  const provider = namedValue(args?.provider);
  const model = namedValue(args?.model);
  if (provider !== undefined && model !== undefined) return undefined;
  if (provider === undefined && model === undefined) return undefined;
  const named = provider === undefined ? '`model`' : '`provider`';
  const missing = provider === undefined ? '`provider`' : '`model`';
  return [
    'This delegation names ' + named + ' but not ' + missing + ', which identifies no route.',
    'Pass `provider` and `model` together, or omit both to inherit the route this session',
    'already runs on.',
  ].join(' ');
}

/**
 * The requirement appended to every delegation tool's own description.
 *
 * Root cannot follow a rule it never reads. The rule lives in AGENTS.md and in
 * the `delivery-discipline` skill, and was still missed in practice: a seat was
 * briefed with a prose tool allow-list and no marker, silently received the
 * read-only profile, and only discovered it when a step was refused a whole
 * round later. The tool description is the one place in front of the model at
 * the moment it decides to delegate, so the requirement is stated there too.
 *
 * Kept to the actionable minimum: which markers exist, that omitting one is
 * read-only, and that the marker must open the prompt.
 */
const MARKER_REQUIREMENT = [
  'The `prompt` MUST begin with an authority marker, which decides what the seat may do:',
  '`[只读]` (read files, search, research, report — also the default when no marker is given),',
  '`[审核]` (the above plus read-only commands such as `git status`/`git diff`),',
  '`[编辑: <paths>]` (the above plus writing exactly those files).',
  'A prompt with no marker grants read-only authority, and the seat is refused a write only',
  'when it reaches one — so state the marker deliberately. English spellings',
  '(`[readonly]`, `[review]`, `[edit: ...]`) are equivalent. When a seat delegates,',
  'the child may receive only the same profile or read-only — never a different',
  'non-read-only profile, and an edit child may name only paths the parent can write.',
].join(' ');

/**
 * The decomposition requirement appended to `todo_write`'s own description.
 *
 * The rule — decompose first, name who does each line — lives in AGENTS.md and
 * in the `delivery-discipline` skill, and a 25-minute session still skipped it:
 * it never wrote a list, so it never had a line to hand to a seat, and the whole
 * task ran single-threaded while its reasoning grew from ~220 to ~9000
 * characters per step re-deriving the same unresolved questions. Writing the
 * list is the moment the decision exists, so the requirement is stated there.
 */
const DECOMPOSITION_REQUIREMENT = [
  'Every todo names who does it, as a prefix: `[root]` for a line this session does',
  'itself, `[seat: <label>]` for a line handed to a subagent. Two lines with no',
  'dependency between them are written as two todos and started together — a list',
  'whose every entry is `[root]` is a statement that the whole task is one thread,',
  'which is the shape to look at twice before starting. Keep a delegated line',
  '`in_progress` until its seat reports, and give one line to one executor rather',
  'than splitting it across several.',
].join(' ');

/**
 * Render the delegation cue for one step.
 *
 * Two parts, in this order: the criterion, which is constant and belongs to
 * every session; then, only when this turn has actually spent something, the
 * specific `[root]` lines that are still open. A criterion with no instance is
 * the shape that already failed four times — it is read and applied to nothing —
 * while an instance with no criterion invites delegating everything.
 *
 * @param spentCalls - tool results this turn has produced.
 * @param rootLines - open todo contents still marked `[root]`, or `undefined` when the session has no list.
 * @returns the model-facing text, or `''` when this agent must not be told.
 */
function renderDelegationCue(spentCalls, rootLines) {
  const criterion =
    'A line that needs to read three independent sources and delivers only a conclusion is ' +
    'cheaper to hand to a seat than to run here: the seat returns the conclusion, and this ' +
    'context never holds the sources. Hand it out at the moment you split the work, not after ' +
    'you have read the first of them — by then the saving is already spent.';
  if (spentCalls < CUE_AFTER_CALLS || rootLines === undefined || rootLines.length === 0) {
    return criterion;
  }
  const named = rootLines.slice(0, 3).map((line) => `- ${line}`).join('\n');
  return (
    `${criterion}\n\n` +
    `This turn has already spent ${spentCalls} tool results, and these open lines are still ` +
    `marked \`[root]\`:\n${named}\n` +
    'If any of them is the shape above, delegate it now; if it is genuinely yours, the list is ' +
    'right and nothing needs to change.'
  );
}

/**
 * Remove every checkpoint this plugin owns on one session.
 *
 * `catalog()` rather than `list()`: a one-shot reminder that already fired is
 * `inactive` and absent from `list()`, but its row is still owned by this
 * session and would otherwise survive every later settlement. A model that
 * renews the checkpoint through `schedule_create` may also give it a new
 * title, so the stable prompt prefix identifies it as reliably as the title
 * did — including rows written under an earlier wait bound. Enumerated from
 * durable storage rather than remembered in memory so that "at most one live
 * checkpoint" survives a restart, which is exactly when a stale one would
 * otherwise fire on top of a fresh one.
 *
 * @param schedule - the reminder service.
 * @param sessionId - the delegating session.
 */
async function clearCheckpoints(schedule, sessionId) {
  for (const record of await schedule.catalog()) {
    if (record.sessionId !== sessionId) continue;
    if (record.title !== CHECKPOINT_TITLE && !record.prompt?.startsWith(CHECKPOINT_PROMPT_PREFIX)) continue;
    await schedule.delete({ sessionId, id: record.id });
  }
}

/**
 * Install the gate and the checkpoint lifecycle.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  /** Child session id -> durable parent session id, recorded while the child is live. */
  const parentOf = new Map();
  /** Parent session id -> its live child session ids. */
  const liveSeats = new Map();
  /**
   * Parent session id -> the tail of its checkpoint reconciliation chain.
   *
   * Lifecycle edges are published through a contained emitter that does NOT
   * await listeners, so a start and an end can interleave: without this chain a
   * short-lived seat's `create` can land after its own `delete`, leaving a
   * checkpoint that fires an hour later for a seat that is already gone.
   * Both handlers do their bookkeeping synchronously before touching this, so
   * enqueue order is the real event order.
   */
  const reconciles = new Map();
  /** Seat session id -> the profile its delegating instruction declared. */
  const profiles = new Map();
  /**
   * Session id -> the turn's running tool-call count, read by the delegation cue.
   *
   * Only the count survives the removal of the periodic cost reading: the cue
   * names a still-owned todo line once this turn has spent enough to make the
   * accusation worth making. Reset when the turn changes.
   */
  const spentBySession = new Map();
  /**
   * Session id -> the owner each todo line was last declared with.
   *
   * The host's `todo/write` payload has no owner field and is not ours to
   * change, so ownership is kept beside it rather than inside it: the host
   * snapshot stays exactly what its projection expects, and the cue reads the
   * owner from here. Cleared with the session, like the meter.
   */
  const ownersBySession = new Map();
  /** Session id -> Map<`${cwd}\0${normalizedTestCmd}`, workspaceFingerprint> for rule 7. */
  const lastTestBySession = new Map();
  /** Session id -> monotonic counter incremented on workspace-mutating tool calls. */
  const mutationEpochBySession = new Map();
  /** In-flight allowed test execution -> `{ sessionId, key, fingerprint }`. */
  const pendingTestRuns = new WeakMap();

  /**
   * Drive one session's checkpoint to match its current live seats.
   *
   * Converges rather than increments: clearing first makes "at most one
   * checkpoint" true no matter how the edges interleaved, so a missed edge can
   * never accumulate duplicates.
   *
   * @param sessionId - the delegating session.
   */
  async function syncCheckpoint(sessionId) {
    const schedule = ctx.get('schedule');
    if (schedule === undefined) return;
    await clearCheckpoints(schedule, sessionId);
    if ((liveSeats.get(sessionId)?.size ?? 0) === 0) return;
    await schedule.create(sessionId, {
      title: CHECKPOINT_TITLE,
      prompt: CHECKPOINT_PROMPT,
      after_seconds: CHECKPOINT_SECONDS,
    });
  }

  /**
   * Queue one reconciliation behind whatever is already queued for that session.
   *
   * @param sessionId - the delegating session.
   * @returns the queued reconciliation.
   */
  function reconcile(sessionId) {
    const previous = reconciles.get(sessionId) ?? Promise.resolve();
    // A failed predecessor must not skip this reconciliation: the desired state
    // is recomputed from live state, so it is safe — and necessary — to retry.
    const next = previous.then(
      () => syncCheckpoint(sessionId),
      () => syncCheckpoint(sessionId),
    );
    reconciles.set(sessionId, next);
    next.then(() => {
      if (reconciles.get(sessionId) === next && !liveSeats.has(sessionId)) reconciles.delete(sessionId);
    }, () => {});
    return next;
  }

  // Rule 1: the one-shot switch is refused before dispatch, so the delegating
  // session never enters the path that cannot report back. A denial here is a
  // tool error the model can correct on its next call.
  //
  // Scoped to tools that still declare the switch. dsh 0.2.1 removed
  // `run_in_background` and the one-shot path with it, so on that generation the
  // rule has nothing to refuse and stays silent rather than rejecting a
  // parameter the tool does not have.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.arguments?.run_in_background !== false) return next();
    if (!isDelegation(ctx, exec)) return next();
    if (!declaresBackgroundSwitch(ctx, exec)) return next();
    return {
      kind: 'deny',
      reason: [
        'One-shot subagents are banned: `run_in_background: false` takes the one-shot path,',
        'which returns a run id that cannot be continued with `send_message` and whose',
        'settlement is never announced, so this session would block until the execution cap.',
        'Omit `run_in_background` (or pass `true`) to start a continuable seat, then stop and',
        'wait for its settlement notification.',
      ].join(' '),
    };
  });

  // Rule 5: a delegation that names half a route is refused, because half a
  // route identifies none. Naming neither field is legal — the host inherits the
  // parent's route. Registered after rule 1 so a one-shot call is refused by the
  // rule that explains the sharper failure first.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = await checkRoute(ctx, exec);
    if (reason === undefined) return next();
    return { kind: 'deny', reason };
  });

  // Rule 4: a seat receives only the authority its own instruction declares.
  // The profile is read from that instruction and cached, because it cannot
  // change while the seat lives. The root session has no delegating parent, so
  // it is never constrained here. Delegation calls and every other call go
  // through the same decision, so the allow-list is never bypassed.
  ctx.on('tools/pre-execute', (exec, next) => {
    const profile = profileOf(profiles, exec.agent);
    if (profile === undefined) return next();
    const reason = checkProfile(profile, exec, ctx);
    if (reason === undefined) return next();
    return { kind: 'deny', reason };
  });

  // Rule 7: deny re-running the exact same test command in the same session
  // when no workspace files have changed since the previous run. Independent
  // seats have distinct session ids and are unaffected.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!SHELL_TOOLS.has(exec.name)) return next();
    const sessionId = exec.agent?.session?.id;
    if (sessionId === undefined) return next();
    const normalized = normalizeTestCommand(exec.arguments?.command);
    if (normalized === null) return next();
    const cwd = await resolveEffectiveWorkdir(ctx, exec);
    const key = `${cwd ?? ''}\0${normalized}`;
    const epoch = mutationEpochBySession.get(sessionId) ?? 0;
    const fingerprint = await computeWorkspaceFingerprint(cwd, exec.signal, epoch);
    const previous = lastTestBySession.get(sessionId)?.get(key);
    if (previous !== undefined && previous === fingerprint) {
      return {
        kind: 'deny',
        reason: [
          `Unchanged test re-run blocked: \`${normalized}\` already ran in this session with no workspace changes since.`,
          'Modify code or configuration before re-running the same test command, or delegate independent re-verification to a separate seat.',
        ].join(' '),
      };
    }
    pendingTestRuns.set(exec, { sessionId, key, fingerprint });
    return next();
  });

  // Rule 8: deny `git commit` when staged additions (or `-a` / chained `git add`)
  // still contain temporary `[DEBUG-` diagnostic markers.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = await checkCommitDebugMarkers(ctx, exec);
    if (reason === undefined) return next();
    return { kind: 'deny', reason };
  });

  // Rule 4, second half: state the marker requirement on the delegation tool
  // itself. A rule the delegator never reads is not enforced by being written
  // down elsewhere; this puts it in front of the model at the moment it decides
  // to delegate. Only the description is touched, and only on delegation tools.
  //
  // Rule 5, second half: the route requirement, which the host's own description
  // presents as optional.
  //
  // `context.scope` is the assembly's own scope and is what the registry must be
  // queried with: an assembly entry is a detached schema with no `agent` field,
  // and a delegation tool registered into the agent's layer is absent from the
  // global view. Without it both tests below answer false and this whole
  // listener becomes a no-op — which is exactly how the requirement went
  // missing from a real delegation.
  // Ownership as a declared field: the todo tool is registered again in the
  // agent's own scope, which the registry lets shadow the global one. A prefix
  // inside free text was adopted in form but never in substance (0 of 341
  // sessions wrote `[seat: ...]`), because a prefix is something to remember
  // while a required field is something to fill. The host snapshot is written
  // back unchanged — the owner lives beside it, not inside it.
  ctx.on('agent/created', ({ agent }) => {
    const sessionId = agent?.session?.id;
    const scoped = agent?.ctx;
    if (sessionId === undefined || scoped === undefined) return;
    scoped.tools.register(
      defineTool({
        name: 'todo_write',
        description:
          'Record and update a task list to plan multi-step work and show progress; skip it for ' +
          'trivial single-step tasks. Add one todo per concrete step before you start. Every todo ' +
          'names who does it: `owner: "root"` for a line this session does itself, `owner: "seat"` ' +
          'for a line handed to a subagent. Two lines with no dependency between them are two todos ' +
          'started together — a list whose every entry is `root` says the whole task is one thread, ' +
          'which is the shape to look at twice before starting.',
        parameters: {
          todos: {
            type: 'array',
            required: true,
            description: 'The COMPLETE task list, replacing any previous list.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true, description: 'What the task is — a short imperative line.' },
                status: {
                  type: 'string',
                  required: true,
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'pending (not started) | in_progress (now) | completed (done).',
                },
                owner: {
                  type: 'string',
                  required: true,
                  enum: ['root', 'seat'],
                  description: 'Who executes this line: "root" for this session, "seat" for a subagent.',
                },
              },
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              todos: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    content: { type: 'string', required: true },
                    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'] },
                  },
                },
              },
              counts: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  pending: { type: 'integer', required: true },
                  inProgress: { type: 'integer', required: true },
                  completed: { type: 'integer', required: true },
                },
              },
            },
          },
          render: (_args, value) =>
            [
              {
                type: 'text',
                text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`,
              },
            ],
        },
        execute(args) {
          const seen = new Set();
          const owners = new Map();
          const todos = args.todos.map((item) => {
            const content = item.content.trim();
            if (content.length === 0) throw new Error('invalid todo: `content` must be a non-empty string');
            if (seen.has(content)) throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`);
            seen.add(content);
            owners.set(content, item.owner);
            return { content, status: item.status };
          });
          agent.session.append('todo/write', { todos });
          ownersBySession.set(sessionId, owners);
          const count = (status) => todos.filter((todo) => todo.status === status).length;
          return Promise.resolve({
            todos,
            counts: { pending: count('pending'), inProgress: count('in_progress'), completed: count('completed') },
          });
        },
      }),
    );
  });

  // The delegation cue: the half of the host's own delegation slot that is
  // missing. Read through `ctx.get` rather than injected, so a host without the
  // prompt service keeps the gate and the wait bound instead of losing all of it.
  const prompts = ctx.get('systemPrompt');
  if (prompts !== undefined) {
    prompts.context({
      name: 'force-rules:delegation-cue',
      order: prompts.getContextOrder(DELEGATION_CUE_SLOT),
      text: (context) => {
        const agent = context.agent;
        // This cue is for the root session's own decomposition, not for a seat's
        // child delegation, whose authority is checked at tools/pre-execute.
        if (agent?.session?.header?.parentSession !== undefined) return '';
        const spent = spentBySession.get(agent?.session?.id);
        const todos = ctx.get('sessionProjections')?.stateOf(agent?.session, 'todos');
        const owners = ownersBySession.get(agent?.session?.id);
        const rootLines = todos === undefined || todos === null
          ? undefined
          : todos
              .filter((todo) => todo.status !== 'completed' && owners?.get(todo.content) === 'root')
              .map((todo) => todo.content);
        return renderDelegationCue(spent?.calls ?? 0, rootLines);
      },
    });
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    const scope = context?.scope;
    let touched = false;
    const tools = assembly.tools.map((tool) => {
      if (tool.name === 'todo_write') {
        touched = true;
        return { ...tool, description: tool.description + ' ' + DECOMPOSITION_REQUIREMENT };
      }
      if (!isDelegation(ctx, tool, scope)) return tool;
      touched = true;
      return { ...tool, description: tool.description + ' ' + MARKER_REQUIREMENT };
    });
    return touched ? { ...assembly, tools } : assembly;
  });

  // The cost meter: accumulate this turn's tool-call count. Counted from
  // `tools/result` rather than from the model's own narration, because a session
  // that believes it has "only checked a few things" is exactly the session the
  // delegation cue is for.
  ctx.on('tools/result', (exec) => {
    const sessionId = exec.agent?.session?.id;
    if (sessionId === undefined) return;
    const spent = spentBySession.get(sessionId) ?? { calls: 0, turn: undefined };
    spent.calls += 1;
    spentBySession.set(sessionId, spent);
  });

  // The counter created by `tools/result` does not know which turn it belongs to,
  // and the delegation cue's threshold is per turn: a fresh turn has spent nothing
  // yet. Stamp the counter on the first step that sees it, and drop it when the
  // turn changes. Nothing is emitted — this only keeps the cue's threshold honest.
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next();
    const sessionId = agent?.session?.id;
    if (sessionId === undefined) return decision;
    const spent = spentBySession.get(sessionId);
    if (spent === undefined) return decision;
    if (spent.turn === undefined) spent.turn = turn;
    else if (spent.turn !== turn) spentBySession.delete(sessionId);
    return decision;
  });

  // Rules 2 and 3: a seat that starts arms the wait bound; a seat that reports
  // normally removes it again. Arming on start rather than on the delegation
  // call is what closes the race — a seat that dies immediately still armed it.
  ctx.on('subagent/start', (info) => {
    const parentSessionId = ctx.agents.get(info.id)?.session?.header?.parentSession;
    if (parentSessionId === undefined) return;
    parentOf.set(info.id, parentSessionId);
    const seats = liveSeats.get(parentSessionId) ?? new Set();
    seats.add(info.id);
    liveSeats.set(parentSessionId, seats);
    return reconcile(parentSessionId);
  });

  ctx.on('subagent/end', (info) => {
    const parentSessionId = parentOf.get(info.id);
    if (parentSessionId === undefined) return;
    parentOf.delete(info.id);
    profiles.delete(info.id);
    const seats = liveSeats.get(parentSessionId);
    if (seats === undefined) return;
    seats.delete(info.id);
    if (seats.size === 0) liveSeats.delete(parentSessionId);
    return reconcile(parentSessionId);
  });

  // A local interrupt is not a settlement: the host cancels the turn but keeps
  // the activation resident, so `subagent/end` is never published. A resumed
  // seat does not emit `subagent/start` either. Lineage and authority stay
  // cached across both edges so a late `subagent/end` still clears the right
  // session and the woken seat keeps the profile its instruction declared.
  ctx.on('tools/result', (exec, result) => {
    if (result.isError) return;
    const callerSessionId = exec.agent?.session?.id;
    const childId = exec.arguments?.agent_id;
    if (callerSessionId === undefined || childId === undefined) return;
    const parentSessionId = parentOf.get(childId);
    if (parentSessionId === undefined || callerSessionId !== parentSessionId) return;

    if (exec.name === 'interrupt_agent') {
      const seats = liveSeats.get(parentSessionId);
      if (seats !== undefined) {
        seats.delete(childId);
        if (seats.size === 0) liveSeats.delete(parentSessionId);
      }
      return reconcile(parentSessionId);
    }
    if (exec.name !== 'send_message') return;
    const seats = liveSeats.get(parentSessionId);
    if (seats?.has(childId)) return;
    liveSeats.set(parentSessionId, (seats ?? new Set()).add(childId));
    return reconcile(parentSessionId);
  });

  // Rule 7 bookkeeping: record completed test runs and bump mutation epoch when
  // a workspace-mutating tool finishes cleanly.
  ctx.on('tools/result', (exec, result) => {
    if (result.isError) return;
    const sessionId = exec.agent?.session?.id;
    if (sessionId === undefined) return;
    const pending = pendingTestRuns.get(exec);
    if (pending !== undefined) {
      let table = lastTestBySession.get(pending.sessionId);
      if (table === undefined) {
        table = new Map();
        lastTestBySession.set(pending.sessionId, table);
      }
      table.set(pending.key, pending.fingerprint);
      return;
    }
    if (WORKSPACE_WRITE_TOOLS.has(exec.name)) {
      mutationEpochBySession.set(sessionId, (mutationEpochBySession.get(sessionId) ?? 0) + 1);
      return;
    }
    if (SHELL_TOOLS.has(exec.name)) {
      const cmd = typeof exec.arguments?.command === 'string' ? exec.arguments.command.trim() : '';
      if (cmd && !READONLY_SHELL_RE.test(cmd) && normalizeTestCommand(cmd) === null) {
        mutationEpochBySession.set(sessionId, (mutationEpochBySession.get(sessionId) ?? 0) + 1);
      }
    }
  });

  // The meter's counters are per session and the session is what outlives them:
  // without this, every session a long-running host ever opened would keep its
  // counters alive for the life of the process.
  ctx.on('agent/disposed', ({ agent }) => {
    spentBySession.delete(agent.session.id);
    ownersBySession.delete(agent.session.id);
    lastTestBySession.delete(agent.session.id);
    mutationEpochBySession.delete(agent.session.id);
  });
}
