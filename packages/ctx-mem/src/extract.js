/**
 * Programmatic extraction of hard facts from a session region.
 *
 * The core promise of this plugin: hard facts (file paths, shell commands,
 * error lines) survive compaction **byte-for-byte**. Nothing here normalizes,
 * re-quotes, shortens or paraphrases a value taken from the input; if a value
 * cannot be recovered faithfully it is not emitted at all ("verbatim or nothing").
 *
 * Two extraction paths exist because a session may run in PTC mode (a single
 * `run_code` call whose real sub-calls the host recorded as `tool/ptc-dispatch`
 * events), in default mode (direct tool calls in assistant messages), or both
 * in one region.
 *
 * @typedef {{ type?: string, seq?: number, data?: any }} SessionEvent
 *
 * @typedef {object} Region
 * @property {number[]} seqs
 * @property {number|null} startSeq
 * @property {number|null} endSeq
 * @property {SessionEvent[]} own
 * @property {Map<string, SessionEvent[]>} dispatchesByRoot
 *
 * @typedef {object} Facts
 * @property {string[]} intents   Verbatim user intent texts, in order.
 * @property {string[]} contexts  The assistant statement immediately preceding each
 *   intent, index-aligned with `intents`; `''` when the region holds no assistant
 *   text before that turn (e.g. the first user message). Same length as `intents`.
 * @property {string[]} files     Verbatim file paths touched, first-seen order, deduped.
 * @property {string[]} commands  Verbatim shell commands, in execution order (duplicates kept).
 * @property {string[]} errors    Verbatim error first-lines, each prefixed with its tool name.
 */

/** Argument keys carrying a file path (first present non-empty string wins). */
const FILE_ARG_KEYS = ['file_path', 'absolute_path', 'notebook_path', 'path', 'glob', 'pattern']

/** Argument keys carrying a shell command (first present non-empty string wins). */
const COMMAND_ARG_KEYS = ['command', 'cmd', 'script']

/** English error signal, matched against a result's first non-empty line. */
const ERROR_PATTERN_EN =
  /(error|failed|failure|fatal|exception|enoent|eacces|eperm|denied|refused|not found|cannot |unable |exit code [1-9])/i

/** Chinese error signal, applied in addition to the English one. */
const ERROR_PATTERN_ZH = /(失败|错误|报错|异常|找不到|未找到|不存在|无法|拒绝|超时|崩溃|致命)/

/**
 * A line reporting a test case that PASSED. The runner's own verdict, which
 * outranks a failure keyword appearing in the case name — see
 * {@link isMisclassifiedError}.
 */
const PASS_LINE = /[\u2714\u2713]/

/** A line reporting a test case that FAILED. Vetoes both drop rules. */
const FAIL_LINE = /[\u2718\u2717\u00d7]/

/**
 * Start of a serialized tool payload (`[{"conclusion":"failure",...}]`) — data
 * rather than a diagnostic.
 */
const JSON_BLOB = /^\[\s*\{/

/**
 * How much of a line {@link isMisclassifiedError} judges.
 *
 * Both shape predicates are claims about how a line *starts* — a checkmark the
 * runner printed in front of a case name, or a payload that opens with `[`.
 * Applied to the whole line they also fire on a checkmark buried tens of
 * thousands of characters into a heredoc leak, which drops the entry for a
 * reason the predicate does not describe. Bounding the window to the line's
 * head makes the test mean what it says.
 *
 * Measured on the real archive: two 46K-character heredoc leaks were being
 * dropped only because a `✔` sat ~37,600 characters in. Bounding restores both,
 * so the archive replay yields 43 entries rather than 41 — see
 * `tests/extract.test.js` A5d.
 */
const MISCLASSIFIED_HEAD_LIMIT = 200

/**
 * Failure keyword, matched anywhere in a line to exempt it from the
 * decoration-shape test — see {@link isDecorationLine}.
 *
 * The trailing word boundary is omitted on purpose so a single stem covers
 * `fail` / `failed` / `failure` / `failures` / `FAILED` and
 * `assert` / `assertion`.
 */
const FAILURE_KEYWORD = /\b(?:fail|error|panic|assert|fatal|exception)/i

/** Tool-name prefix used when a result cannot be paired back to its call. */
const UNKNOWN_TOOL_PREFIX = 'tool'

/** The PTC root tool whose sub-calls are recorded as dispatch events. */
const RUN_CODE_TOOL = 'run_code'

/**
 * Extract hard facts from one session region.
 *
 * @param {Region|undefined|null} region Region object produced by `src/region.js`.
 *   Treated as read-only: this function never mutates it.
 * @returns {Facts}
 */
export function extractFacts(region) {
  /** @type {Facts} */
  const facts = { intents: [], contexts: [], files: [], commands: [], errors: [] }

  const own = Array.isArray(region?.own) ? region.own : []
  if (own.length === 0) return facts

  const dispatchesByRoot = region?.dispatchesByRoot instanceof Map ? region.dispatchesByRoot : new Map()

  // callId -> tool name, so a result can be reported under its tool's name.
  const callNameById = new Map()
  // Call ids whose facts already come from an assistant message block, so an
  // optional log-only `tool/call` duplicate of the same call cannot double-count.
  const sourcedFromAssistant = new Set()

  for (const event of own) {
    if (event?.type !== 'assistant/message') continue
    for (const block of assistantBlocks(event)) {
      if (block.type !== 'tool-call' || typeof block.id !== 'string') continue
      sourcedFromAssistant.add(block.id)
      if (typeof block.name === 'string') callNameById.set(block.id, block.name)
    }
  }
  for (const event of own) {
    if (event?.type !== 'tool/call') continue
    const { callId, name } = event.data ?? {}
    if (typeof callId === 'string' && typeof name === 'string' && !callNameById.has(callId)) {
      callNameById.set(callId, name)
    }
  }

  const seenFiles = new Set()

  // The most recent non-empty assistant statement, waiting to be paired with the
  // next genuine user intent. Reset to '' once consumed (see the
  // `user/message` branch) so a statement is never reused across turns.
  let pendingAssistant = ''

  // Root call ids that already have at least one recorded dispatch. A `run_code`
  // call in this set sources its facts from the dispatches alone; parsing its
  // program source as well would double-count the same sub-calls.
  //
  // `dispatchesByRoot` is the authoritative container: `regionOf` builds it by
  // walking the very same region events, so every `tool/ptc-dispatch` in `own`
  // is already a key here. Scanning `own` again would only re-derive the same
  // set.
  const dispatchedRoots = new Set()
  for (const [rootCallId, dispatches] of dispatchesByRoot) {
    if (Array.isArray(dispatches) && dispatches.length > 0) dispatchedRoots.add(rootCallId)
  }

  for (const event of own) {
    switch (event?.type) {
      case 'assistant/message': {
        // The statement an intent is answering. Recorded BEFORE the tool-call
        // walk below so a message that both speaks and calls tools keeps its
        // text; only a non-empty text overwrites, so a tool-call-only turn
        // cannot erase the last thing actually said.
        const statement = concatenatedText(event.data?.message?.content)
        if (statement !== '') pendingAssistant = statement

        // Path B: default-mode calls, arguments carried as a JSON string.
        for (const block of assistantBlocks(event)) {
          if (block.type !== 'tool-call' || typeof block.name !== 'string') continue
          collectFromCall(block.id, block.name, parseArguments(block.arguments), facts, seenFiles)
        }
        break
      }

      case 'tool/call': {
        // Optional log-only duplicate of a call: source facts from it only when
        // the assistant message for the same call is absent from the region.
        const { callId, name, arguments: rawArguments } = event.data ?? {}
        if (typeof callId === 'string' && sourcedFromAssistant.has(callId)) break
        if (typeof name !== 'string') break
        collectFromCall(callId, name, parseArguments(rawArguments), facts, seenFiles)
        break
      }

      case 'tool/ptc-dispatch': {
        // Path A: the authoritative record of a real sub-call.
        const data = event.data ?? {}
        collectFromCall(data.subCallId, data.name, data.arguments, facts, seenFiles)
        if (data.isError === true || looksLikeFailure(dispatchBlocks(data))) {
          recordError(facts, data.name, dispatchBlocks(data), data.isError === true)
        }
        break
      }

      case 'tool/result': {
        const result = firstToolResultBlock(event)
        const callId = event.data?.message?.source?.callId
        const name = typeof callId === 'string' ? callNameById.get(callId) : undefined
        if (result.isError || looksLikeFailure(result.content)) {
          recordError(facts, name, result.content, result.isError)
        }
        break
      }

      case 'user/message': {
        if (isGenuineUserMessage(event)) {
          const text = concatenatedText(event.data?.content)
          if (text !== '') {
            facts.intents.push(text)
            facts.contexts.push(pendingAssistant)
            // Pair each intent with only the statement immediately before it:
            // reusing it would attach turn N's words to turn N+1's question.
            pendingAssistant = ''
          }
        }
        break
      }

      default:
        break
    }
  }

  return facts

  /**
   * Source file paths and commands from one tool call's structured arguments.
   *
   * `run_code` is special: its real sub-calls are recorded as
   * `tool/ptc-dispatch` events, and those are the authoritative source. Only
   * when a `run_code` call has **no** dispatch logged for its id do we fall
   * back to parsing the program source — never both, which would double-count.
   *
   * @param {unknown} callId
   * @param {unknown} name
   * @param {Record<string, unknown>|null} args
   * @param {Facts} target
   * @param {Set<string>} seen
   */
  function collectFromCall(callId, name, args, target, seen) {
    if (typeof name !== 'string' || name === '') return

    if (name === RUN_CODE_TOOL) {
      const rootCallId = typeof callId === 'string' ? callId : ''
      // Suppress source parsing only when dispatches actually exist for this
      // root: nothing is recorded otherwise, so the fallback recovers facts
      // that would be lost.
      if (!dispatchedRoots.has(rootCallId)) collectFromRunCodeSource(args, target)
      return
    }

    if (args === null || typeof args !== 'object') return

    const file = firstStringValue(args, FILE_ARG_KEYS)
    if (file !== undefined && !seen.has(file)) {
      seen.add(file)
      target.files.push(file)
    }

    const command = firstStringValue(args, COMMAND_ARG_KEYS)
    if (command !== undefined) target.commands.push(command)
  }
}

export default extractFacts

/* ------------------------------------------------------------------ helpers */

/** Content blocks of an `assistant/message` event. */
function assistantBlocks(event) {
  const content = event?.data?.message?.content
  return Array.isArray(content) ? content : []
}

/** Logged content blocks of a `tool/ptc-dispatch` event. */
function dispatchBlocks(data) {
  return Array.isArray(data?.content) ? data.content : []
}

/**
 * The first `tool-result` block of a `tool/result` event.
 *
 * @returns {{ isError: boolean, content: unknown[] }}
 */
function firstToolResultBlock(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return { isError: false, content: [] }
  for (const block of content) {
    if (block?.type === 'tool-result') {
      return { isError: block.isError === true, content: Array.isArray(block.content) ? block.content : [] }
    }
  }
  return { isError: false, content: [] }
}

/**
 * Parse a tool call's arguments. Default-mode calls carry a JSON string; PTC
 * dispatches carry an already-structured object. On parse failure the call is
 * treated as having no structured arguments — never a guess.
 *
 * @param {unknown} raw
 * @returns {Record<string, unknown>|null}
 */
function parseArguments(raw) {
  if (raw !== null && typeof raw === 'object') return /** @type {Record<string, unknown>} */ (raw)
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * First key of `keys` holding a non-empty string value, else undefined.
 *
 * @param {Record<string, unknown>} args
 * @param {string[]} keys
 * @returns {string|undefined}
 */
function firstStringValue(args, keys) {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * Concatenate the `text` blocks of a message, verbatim.
 *
 * @param {unknown} content
 * @returns {string}
 */
function concatenatedText(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * Joined text of a result's content blocks, or '' when there is none.
 *
 * @param {unknown} content
 * @returns {string}
 */
function joinedText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') parts.push(block)
    else if (typeof block?.text === 'string') parts.push(block.text)
    else if (typeof block?.content === 'string') parts.push(block.content)
  }
  return parts.join('\n')
}

/**
 * Host wrapper markers that occupy a line of their own in a tool result.
 *
 * These are presentation, not output. Only `[stderr]` is a bare marker;
 * `dsh-bash-local` and `dsh-tool-bash` prefix captured stderr with it. The
 * bracketed failure markers (`[exit code: N]`, signals, timeouts, sandbox
 * denials) carry their detail inside the brackets and are matched by pattern in
 * {@link isWrapperMarker}.
 *
 * The set is deliberately closed to what the host emits. A speculative marker
 * that no host code produces would silently swallow a real output line that
 * happened to equal it.
 */
const BARE_WRAPPER_MARKERS = new Set(['[stderr]'])

/**
 * True for a host wrapper marker line.
 *
 * The bracketed forms are matched exactly as the host builds them:
 * `dsh-tool-bash` appends `[exit code: N]` / `[killed by signal: X]` /
 * `[timed out after Nms]`, and `dsh-sandbox` builds
 * `[sandbox: file access denied under <mode> mode]`.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isWrapperMarker(line) {
  const trimmed = line.trim()
  if (BARE_WRAPPER_MARKERS.has(trimmed)) return true
  return /^\[(exit code: -?\d+|killed by signal: .+|timed out after \d+ms|sandbox: [^\]]+)\]$/.test(trimmed)
}

/**
 * First line of a result that carries actual output, skipping wrapper markers.
 *
 * This is what error detection must read. The first physical line of a failed
 * bash command is the `[stderr]` wrapper, so testing that line against the error
 * patterns matches nothing and silently drops the error — the exact hard fact
 * this backend exists to preserve.
 *
 * Returns the marker line itself when the result is nothing but markers, so an
 * `[exit code: N]`-only failure is still reportable.
 *
 * @param {unknown} content
 * @returns {string}
 */
function firstMeaningfulLine(content) {
  let first = ''
  for (const line of joinedText(content).split('\n')) {
    if (line.trim() === '') continue
    if (first === '') first = line
    if (!isWrapperMarker(line)) return line
  }
  return first
}

/**
 * True when a result reports a failure — by the host's own marker, or by an
 * error signal in its first line of real output.
 *
 * @param {unknown} content
 * @returns {boolean}
 */
function looksLikeFailure(content) {
  const text = joinedText(content)
  if (/\[exit code: (?!0\])\d+\]/.test(text)) return true
  if (/\[(killed by signal: .+|timed out after \d+ms|sandbox: .+)\]/.test(text)) return true
  return matchesErrorPattern(firstMeaningfulLine(content))
}

/**
 * True when a line carries an English or Chinese error signal.
 *
 * @param {string} line
 * @returns {boolean}
 */
function matchesErrorPattern(line) {
  if (line === '') return false
  return ERROR_PATTERN_EN.test(line) || ERROR_PATTERN_ZH.test(line)
}

/**
 * Pick the line representing the error in a tool result.
 *
 * Scans for the first line carrying an explicit error signal, so progress lines
 * or banners preceding the diagnostic do not mask the real error. Falls back to
 * the first meaningful non-marker line when no error pattern matches (preserving
 * diagnostics that carry no keyword, such as `ls: /x: No such file or directory`).
 *
 * @param {unknown} content
 * @returns {string}
 */
function firstErrorLine(content) {
  for (const line of joinedText(content).split('\n')) {
    if (line.trim() === '' || isWrapperMarker(line)) continue
    if (matchesErrorPattern(line)) return line
  }
  return firstMeaningfulLine(content)
}

/**
 * Push a `"<tool>: <error line>"` error entry, when there is a line and the
 * entry is not dropped noise.
 *
 * @param {Facts} facts
 * @param {unknown} name
 * @param {unknown} content
 * @param {boolean} [isError=false]
 */
function recordError(facts, name, content, isError = false) {
  const line = firstErrorLine(content)
  if (line === '') return
  if (isNoiseExitError(content, line, isError)) return
  if (isMisclassifiedError(content, line, isError)) return
  const prefix = typeof name === 'string' && name !== '' ? name : UNKNOWN_TOOL_PREFIX
  facts.errors.push(`${prefix}: ${line}`)
}

/**
 * True when an entry reached `recordError` on an error signal that does not
 * actually describe a failure.

 * Two shapes produce that, both measured on the real archive:

 * - **A passing test line.** A test runner prints `✔ zip-security: 重复条目名拒绝`
 *   for a case that *passed*, and the case name carries a Chinese failure word
 *   (`拒绝`), so `ERROR_PATTERN_ZH` fires on the name and the success line is
 *   recorded as an error. The checkmark is the runner's own verdict, which
 *   outranks a keyword in a case name.
 * - **A serialized tool payload.** A `--json` tool result such as
 *   `[{"conclusion":"failure",...}]` is data, not a diagnostic; the word
 *   `failure` inside it is a field value. Its first line begins with `[`.

 * Both predicates are **shape** tests, never "the line matched no error
 * pattern" — that weaker rule is what the previous plan already disproved: a
 * genuine `ls: /x: No such file or directory` matches no pattern either, so
 * absence of a match would silently discard real diagnostics.

 * The host's own `isError` ruling always wins, and any explicit failure
 * checkmark anywhere in the content vetoes both rules — a run that both passed
 * and failed some case must keep its error.
 *
 * Both shape tests read only the line's first {@link MISCLASSIFIED_HEAD_LIMIT}
 * characters, because both are claims about how the line starts. A checkmark
 * deep inside a leaked heredoc is not a runner verdict, and the veto above
 * (which reads the *whole* content, deliberately) is what keeps a genuine
 * failure from being masked.

 * @param {unknown} content
 * @param {string} line
 * @param {boolean} isError
 * @returns {boolean}
 */
function isMisclassifiedError(content, line, isError) {
  if (isError) return false
  if (FAIL_LINE.test(joinedText(content))) return false
  const head = line.trim().slice(0, MISCLASSIFIED_HEAD_LIMIT)
  return PASS_LINE.test(head) || JSON_BLOB.test(head)
}

/**
 * True for a decoration line — a banner the command itself printed, not output.
 *
 * The noise this predicate targets is a shell probe that echoed a section
 * heading and then exited nonzero for a reason the heading cannot express
 * (`grep` finding nothing, `ls` missing a path). A heading is recognizable by
 * shape alone: a run of three or more `=`/`#`/`*`/`_`/`~`/`+`/`-`, or an
 * ATX markdown heading.
 *
 * Shape, deliberately, rather than "the line matches no error pattern": a real
 * diagnostic such as `ls: /x: No such file or directory` matches neither
 * pattern either, so pattern-absence would silently discard it. Both pinned
 * tests in `tests/extract.test.js` (the wrapped `ls` diagnostic and the
 * `some stdout` result) exist precisely to catch that — they are not
 * distinguishable from a bare word like `dsh-scope` by any text rule, so the
 * conservative direction is to keep them and only drop lines that *look* like
 * decoration.
 *
 * Shape alone is nevertheless too coarse, because real test frameworks print
 * their failures in exactly that shape. `go test` emits
 * `--- FAIL: TestAdd (0.00s)` and `jest` emits `--- FAIL ./sum.test.js ---`;
 * both are runs of three or more `-` and would be classified as banners,
 * silently discarding a genuine failure from the checkpoint. So a
 * decoration-shaped line that **names a failure** is not decoration: the
 * failure keyword is checked first, and only a line with no failure word is
 * eligible for the shape test.
 *
 * The keyword test has no trailing word boundary on purpose, so one stem covers
 * `fail` / `failed` / `failure` / `failures` / `FAILED` and likewise
 * `assert` / `assertion`. It stays narrow enough to leave real banners alone: a
 * section delimiter such as cargo's `---- tests::add stdout ----` carries no
 * failure word, so it is still dropped — correctly, since it delimits output
 * rather than stating a failure.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isDecorationLine(line) {
  const trimmed = line.trim()
  if (trimmed === '') return false
  if (FAILURE_KEYWORD.test(trimmed)) return false
  if (/^#{1,6}\s+\S/.test(trimmed)) return true
  return /[=#*_~+-]{3,}/.test(trimmed)
}

/**
 * True when an error entry should be dropped as executor noise (contract A8).
 *
 * A command that printed only a decoration banner and exited nonzero is
 * recorded as an error because `looksLikeFailure` reads the exit-code marker.
 * Such an entry is noise unless the host explicitly marked it failed, it was
 * killed by signal / timed out / denied by sandbox, its first line carries an
 * error signal, its first line is the marker itself (nothing but markers), or
 * its first line is not decoration — which includes a decoration-shaped line
 * that names a failure, such as `--- FAIL: TestAdd (0.00s)` (see
 * {@link isDecorationLine}).
 *
 * @param {unknown} content
 * @param {string} line
 * @param {boolean} isError
 * @returns {boolean}
 */
function isNoiseExitError(content, line, isError) {
  if (isError) return false
  if (isWrapperMarker(line)) return false
  if (matchesErrorPattern(line)) return false
  if (!isDecorationLine(line)) return false
  const text = joinedText(content)
  if (/\[(killed by signal: .+|timed out after \d+ms|sandbox: .+)\]/.test(text)) return false
  return /\[exit code: (?!0\])\d+\]/.test(text)
}

/**
 * True for a real user message — a human's own turn, not a framework row.
 *
 * The predicate is `source.kind === 'user'`, which is the host's own rule
 * (`dsh-api-session-controller` uses exactly this to detect a prompt, and the
 * Chat UI projects every other kind as `role: 'inject'`). Enumerating the
 * excluded kinds instead would be a standing invitation to miss the next one
 * the host adds.
 *
 * What the excluded kinds actually carry, from 200 archived sessions:
 * `agent-instructions` (the whole `AGENTS.md` body) and `skill-catalog` (the
 * whole skill list) are `user/message` rows too, and together run to ~10K
 * characters. Admitting them turns `### User Intents` into a transcript dump
 * that buries the request it is supposed to preserve.
 *
 * A missing source is treated as genuine: the host always sets one, so an
 * absent source means a hand-built or legacy event, and dropping a possible
 * human turn is worse than admitting one framework row.
 *
 * @param {SessionEvent} event
 * @returns {boolean}
 */
function isGenuineUserMessage(event) {
  const kind = event?.data?.source?.kind
  return kind === undefined || kind === 'user'
}

/**
 * Build the pattern matching `key: <quoted literal>` and capturing the raw body.
 *
 * The capture is a **backreference to the opening quote**, which is required
 * here. A quote-excluding class such as `[^'"]*` is WRONG: extracted commands
 * routinely contain inner quotes (`echo "=== plugins ==="`), and such a class
 * stops at the first inner quote and silently emits a corrupted command
 * (`echo `). The body alternative is additionally escape-aware, so a
 * backslash-escaped quote inside a double-quoted literal does not end the
 * match early.
 *
 * The opening character must stay restricted to an actual quote. Widening it to
 * `[\s\S]` — so that "any delimiter" could open a match — makes the pattern
 * accept an UNQUOTED value and then fabricate a command out of its middle:
 * `tools.bash({command: cmd})` would yield `b`. That is the same silent
 * corruption the backreference exists to prevent, so a non-literal value must
 * simply not match.
 *
 * @param {string} key
 * @returns {RegExp}
 */
function quotedValuePattern(key) {
  return new RegExp(`${key}\\s*:\\s*(['"])((?:\\\\[\\s\\S]|(?!\\1)[^\\\\])*)\\1`)
}

/** Matches a `command: '<literal>'` pair inside a call's argument text. */
const COMMAND_SOURCE_PATTERN = quotedValuePattern('command')

/** Call site of a program-level tool, e.g. `tools.bash(`. */
const TOOL_CALL_SITE = /tools\.([A-Za-z_$][\w$]*)\s*\(/g

/** Escape sequences decoded when a source literal body is recovered. */
const ESCAPES = { '\\': '\\', "'": "'", '"': '"', n: '\n', t: '\t', r: '\r' }

/**
 * Decode the escapes of a recovered source literal body. Only escapes a
 * program literal can plausibly carry are decoded; any other backslash
 * sequence is left untouched rather than guessed at.
 *
 * @param {string} body
 * @returns {string}
 */
function unescapeSourceBody(body) {
  return body.replace(/\\([\s\S])/g, (match, char) => (char in ESCAPES ? ESCAPES[char] : match))
}

/**
 * Path C — best-effort recovery of sub-calls from a `run_code` program source.
 *
 * Used ONLY for a `run_code` call with no recorded dispatches. Recovers the
 * tool name plus a `command` value where one is present; it deliberately does
 * not attempt to reconstruct full argument objects.
 *
 * @param {Record<string, unknown>|null} args
 * @param {Facts} facts
 */
function collectFromRunCodeSource(args, facts) {
  const code = typeof args?.code === 'string' ? args.code : null
  if (code === null) return
  TOOL_CALL_SITE.lastIndex = 0
  let match
  while ((match = TOOL_CALL_SITE.exec(code)) !== null) {
    const callArguments = sliceCallArguments(code, match.index + match[0].length - 1)
    const command = COMMAND_SOURCE_PATTERN.exec(callArguments)
    if (command !== null) facts.commands.push(unescapeSourceBody(command[2]))
  }
}

/**
 * Slice the argument text of a call whose `(` sits at `openIndex`, honoring
 * string literals so a parenthesis inside a command cannot unbalance the scan.
 *
 * @param {string} code
 * @param {number} openIndex
 * @returns {string}
 */
function sliceCallArguments(code, openIndex) {
  let depth = 0
  let quote = null
  for (let i = openIndex; i < code.length; i += 1) {
    const char = code[i]
    if (quote !== null) {
      if (char === '\\') i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return code.slice(openIndex + 1, i)
    }
  }
  return code.slice(openIndex + 1)
}
