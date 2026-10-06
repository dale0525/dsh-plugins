/**
 * dsh-delegation-guard — deterministic enforcement of the delegation norms.
 *
 * Three prose rules in the operating instructions are mechanized here, because
 * prose is advisory and each of these has already failed in practice:
 *
 *  1. A subagent seat is never one-shot. `run_in_background: false` is the only
 *     switch into the one-shot path, whose run id cannot be continued with
 *     `send_message` and whose settlement is never announced to the delegating
 *     session — so the delegator blocks until the execution cap expires. This
 *     plugin denies that call before dispatch.
 *  2. A delegating session must not poll or spin while a seat runs.
 *  3. Silence must have an upper bound: a seat that dies without ever emitting
 *     `subagent/end` would otherwise leave the delegator waiting forever.
 *
 *  4. A seat receives only the authority its own instruction declares. The
 *     delegating instruction opens with a profile marker -- `[只读]` (the
 *     default when no marker is present), `[审核]`, or `[编辑: <paths>]` --
 *     and every call the seat makes is checked against that profile.
 *
 * Rules 2 and 3 are one mechanism: the plugin keeps one durable self-waking
 * checkpoint on each delegating session for exactly as long as that session has
 * a live seat. A seat that reports normally removes it; a seat that dies
 * silently leaves it to fire.
 *
 * @module @logictan/dsh-delegation-guard
 */

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'delegation-guard';

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
 * Silence allowed before the checkpoint wakes the delegating session.
 *
 * The rule is "the order of magnitude of a normal run", not seconds: a seat
 * doing real work routinely runs for minutes, and a short checkpoint would turn
 * waiting into the polling it exists to replace.
 */
const CHECKPOINT_SECONDS = 600;

/** Durable title identifying this plugin's checkpoint among a session's reminders. */
const CHECKPOINT_TITLE = 'subagent checkpoint';

/** What the woken delegating session is told to do. */
const CHECKPOINT_PROMPT = [
  'A subagent seat you delegated has not reported within 10 minutes.',
  'Check the seats with `list_agents`:',
  '- finished: continue from its settlement notification;',
  '- still running: renew this checkpoint with `schedule_create` and wait again;',
  '- terminated abnormally or unreachable: apply the retry policy (retry, and only open a new seat after 3 failed attempts).',
  'Do not poll repeatedly; this checkpoint is the only wake-up you need.',
].join('\n');

/**
 * Whether one JSON Schema node declares the `continuable` outcome.
 *
 * The delegation tools are the only tools in the host that can return a
 * continuable seat, and they say so in their own output schema. Keying on that
 * declaration rather than on a tool name is what keeps this gate off `bash`,
 * `pwsh`, and `workflow`, which declare the same `run_in_background` parameter
 * but cannot produce a seat at all.
 *
 * @param node - one JSON Schema node from a tool's output declaration.
 * @returns whether the schema can produce a continuable seat.
 */
function declaresContinuable(node) {
  if (Array.isArray(node)) return node.some(declaresContinuable);
  if (node === null || typeof node !== 'object') return false;
  if (node.const === 'continuable') return true;
  return Object.values(node).some(declaresContinuable);
}

/**
 * Whether this call can start a subagent seat.
 *
 * @param ctx - the plugin context.
 * @param exec - the pending call.
 * @returns whether the called tool is a delegation tool.
 */
function isDelegation(ctx, exec) {
  const schema = ctx.tools.get(exec.name, exec.agent)?.output?.schema;
  return schema !== undefined && declaresContinuable(schema);
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
 * @returns a denial reason, or undefined to allow the call.
 */
function checkProfile(profile, exec) {
  const toolName = exec.name;
  if (toolName === PTC_TRANSPORT) return undefined;
  if (READ_ONLY_TOOLS.has(toolName)) return undefined;
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
  '(`[readonly]`, `[review]`, `[edit: ...]`) are equivalent.',
].join(' ');

/**
 * Remove every checkpoint this plugin owns on one session.
 *
 * Looked up by title rather than remembered in memory so that "at most one live
 * checkpoint" survives a restart, which is exactly when a stale one would
 * otherwise fire on top of a fresh one.
 *
 * @param schedule - the reminder service.
 * @param sessionId - the delegating session.
 */
async function clearCheckpoints(schedule, sessionId) {
  for (const record of await schedule.list({ sessionId })) {
    if (record.title === CHECKPOINT_TITLE) await schedule.delete({ sessionId, id: record.id });
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
   * checkpoint that fires ten minutes later for a seat that is already gone.
   * Both handlers do their bookkeeping synchronously before touching this, so
   * enqueue order is the real event order.
   */
  const reconciles = new Map();
  /** Seat session id -> the profile its delegating instruction declared. */
  const profiles = new Map();

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
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.arguments?.run_in_background !== false) return next();
    if (!isDelegation(ctx, exec)) return next();
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

  // Rule 4: a seat receives only the authority its own instruction declares.
  // The profile is read from that instruction and cached, because it cannot
  // change while the seat lives. The root session has no delegating parent, so
  // it is never constrained here.
  ctx.on('tools/pre-execute', (exec, next) => {
    const profile = profileOf(profiles, exec.agent);
    if (profile === undefined) return next();
    const reason = checkProfile(profile, exec);
    if (reason === undefined) return next();
    return { kind: 'deny', reason };
  });

  // Rule 4, second half: state the marker requirement on the delegation tool
  // itself. A rule the delegator never reads is not enforced by being written
  // down elsewhere; this puts it in front of the model at the moment it decides
  // to delegate. Only the description is touched, and only on delegation tools.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next();
    let touched = false;
    const tools = assembly.tools.map((tool) => {
      if (!isDelegation(ctx, tool)) return tool;
      touched = true;
      return { ...tool, description: tool.description + ' ' + MARKER_REQUIREMENT };
    });
    return touched ? { ...assembly, tools } : assembly;
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
}
