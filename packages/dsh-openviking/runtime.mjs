import { isCaptureEnabled } from "./shared/capture-utils.mjs";
import { buildProfileBlock } from "./shared/profile-inject.mjs";
import { buildRecallBlock, isRecallEnabled } from "./shared/recall-core.mjs";
import {
  dequeue,
  enqueue,
  listPending,
  replayPending,
} from "./shared/pending-queue.mjs";
import { isRetryableFailure } from "./shared/retryable.mjs";
import { resolveWorkspaceSettings } from "./shared/plugin-config.mjs";
import { resolveWorkspaceIdentity } from "./shared/workspace-identity.mjs";
import { resolveEffectivePeerId } from "./shared/workspace-peer.mjs";
import {
  captureEvent,
  isOpenVikingPluginMessage,
  pluginMessage,
  promptText,
} from "./capture.mjs";
import { deriveDshSessionId } from "./session-id.mjs";

export class OpenVikingRuntime {
  /**
   * @param resolveConfigFor - Rebuild the plugin config against a directory, so
   *   one process can serve sessions in several workspaces. The loader's boot
   *   copy is resolved against the launch cwd, which is no session's project.
   */
  constructor(client, config, logger = console, resolveConfigFor = null) {
    this.client = client;
    this.config = config;
    this.logger = logger;
    // A runtime built without the hook (tests, embedders) still has to resolve
    // each session's peer from that session's own directory: falling back to
    // the boot copy would attribute every session to the launch project.
    this.resolveConfigFor = resolveConfigFor ?? ((cwd, uncached) => {
      const cfg = {
        peerId: config.explicitPeerId,
        peerSource: config.peerSource,
        workspacePeer: config.workspacePeer,
        harness: config.harness,
      };
      // A workspace names its own peer in `.openviking/config.json`, and the
      // session's directory is the only place that file can be found.
      if (!cfg.peerId) {
        const declared = resolveWorkspaceSettings(cwd).settings.peerId;
        if (declared) cfg.peerId = declared;
      }
      const peer = resolveEffectivePeerId({
        cfg,
        cwd,
        identity: uncached === true ? resolveWorkspaceIdentity({ cwd, cache: false }) : null,
      });
      return {
        peerId: peer.peerId,
        legacyPeerId: peer.legacyPeerId,
        peerUnresolved: peer.source === "none" && peer.origin === "unresolved",
      };
    });
    this.states = new Map();
    this.drainTimer = null;
    this.drainRunning = false;
    this.drainPromise = Promise.resolve();
    this.drainHealth = null;
  }

  stateFor(session) {
    const existing = this.states.get(session.id);
    if (existing) {
      if (existing.peerUnresolved) this.resolvePeer(existing, session);
      return existing;
    }
    const state = {
      dshSessionId: String(session.id),
      ovSessionId: deriveDshSessionId(session.id),
      config: { ...this.config },
      peerUnresolved: false,
      ready: false,
      profileBlock: "",
      profileDelivered: false,
      toolNames: new Map(),
      injectedTurn: undefined,
      injectedUris: new Set(),
      writes: Promise.resolve(),
      initializationRetryable: false,
      hasPendingWrites: false,
      pendingCreatedAt: 0,
      disposing: null,
    };
    this.resolvePeer(state, session);
    this.states.set(session.id, state);
    return state;
  }

  /**
   * Resolve the peer against the session's own directory, and keep re-resolving
   * it while the answer is "no peer".
   *
   * One session keeps one peer, but an empty one is not an answer worth
   * keeping: it is what a directory that is not a workspace *yet* returns, and
   * a repository created mid-session would otherwise file every memory of that
   * session at the user level for the rest of its life. An explicit
   * `workspacePeer: false` is a decision and stays cached.
   */
  resolvePeer(state, session) {
    const cwd = session.header?.cwd || process.cwd();
    // Rebuild the whole config against THIS session's directory rather than
    // patching the boot copy. `explicitPeerId` is not the host's input: the
    // loader fills it from whichever workspace the process was launched in, so
    // reading it here would stamp the launch project's peer onto every session
    // in every other project. Going back through `resolveConfig` re-runs the
    // documented precedence (host input, then env, then this workspace's own
    // `.openviking/config.json`) with the right `cwd`.
    //
    // `state.peerUnresolved` drops the loader's "not a workspace" cache, which
    // would otherwise keep a directory that only BECAME a repository mid-session
    // at the user level for the rest of that session.
    const resolved = this.resolveConfigFor(cwd, state.peerUnresolved);
    state.config.peerId = resolved.peerId;
    state.config.legacyPeerId = resolved.legacyPeerId;
    state.peerUnresolved = resolved.peerUnresolved;
  }

  async initialize(agent) {
    const state = this.stateFor(agent.session);
    return this.ensureState(state);
  }

  async ensureState(state) {
    if (state.ready) return state;
    if (state.initializing) return state.initializing;
    state.initializing = this.initializeState(state).finally(() => {
      state.initializing = null;
    });
    return state.initializing;
  }

  async initializeState(state) {
    state.initializationRetryable = false;
    const health = await this.client.healthResult();
    if (!health.ok) {
      state.initializationRetryable = isRetryableFailure(health);
      return state;
    }
    const ensured = await this.client.ensureSessionResult(
      state.ovSessionId,
      state.config.peerId,
    );
    if (
      !ensured.ok
      && !(ensured.status === 409 && ensured.error?.code === "ALREADY_EXISTS")
    ) {
      state.initializationRetryable = isRetryableFailure(ensured);
      return state;
    }
    // Replay is a write, so it stays behind the same toggle: a backlog queued
    // while capture was on waits for a session that still writes.
    if (isCaptureEnabled(state.config)) {
      await this.replayPendingQueue();
    }
    await this.refreshPendingState(state);
    const profile = await buildProfileBlock(
      (path, init, options) => this.client.fetchJSON(path, init, options),
      state.config.profileTokenBudget,
      state.config.peerId,
      state.config,
    );
    state.profileBlock = profile?.block
      ? [
          '<openviking-context source="profile">',
          profile.block,
          "</openviking-context>",
        ].join("\n")
      : "";
    state.ready = true;
    return state;
  }

  async profileMessage(agent) {
    const state = await this.initialize(agent);
    if (!state.ready || !state.profileBlock || state.profileDelivered) return null;
    if (hasStartupProfile(agent)) {
      state.profileDelivered = true;
      return null;
    }
    state.profileDelivered = true;
    return pluginMessage(state.profileBlock, { form: "instructions" });
  }

  async recallMessage(agent, messages, position = {}) {
    const state = await this.initialize(agent);
    if (!state.ready || !isRecallEnabled(state.config)) return null;
    const query = promptText(messages);
    if (!query || query.length < state.config.minQueryLength) return null;
    if (position.turn !== state.injectedTurn) {
      state.injectedTurn = position.turn;
      state.injectedUris.clear();
    }
    const block = await buildRecallBlock(
      (path, init, options) => this.client.fetchJSON(path, init, options),
      state.config,
      query,
      {
        actorPeerId: state.config.peerId,
        legacyPeerId: state.config.legacyPeerId,
        sessionId: state.ovSessionId,
        excludeUris: state.config.recallExcludeUris,
        log: (stage, data) => this.log(stage, data),
      },
    );
    if (!block) return null;
    // Recall fires once per STEP, and the server answers each call with a full
    // budgeted block: in a measured 51-turn session 217 firings carried 4242
    // URI slots for 342 distinct URIs. What this turn already put in front of
    // the model is not worth a second copy, so the repeats are dropped here —
    // the server's `exclude_uris` was measured to change WHICH entries come
    // back, not how much, so filtering the returned block is the only way to
    // actually shrink the injection.
    const kept = dropInjectedMemories(block, state.injectedUris);
    if (!kept) return null;
    return pluginMessage(kept, { form: "recall" });
  }

  /**
   * Forget what this session already injected. Compaction rewrites the history
   * those blocks were part of, so a URI dropped by the summary is no longer in
   * front of the model and has to be injectable again — the same trade-off the
   * loader makes for AGENTS.md.
   */
  forgetInjected(session) {
    this.stateFor(session).injectedUris.clear();
  }

  capture(session, event) {
    const state = this.stateFor(session);
    if (!isCaptureEnabled(state.config)) return;
    const payload = captureEvent(event, state.config, state.toolNames);
    if (!payload) return;
    this.enqueueWrite(state, async () => {
      if (state.hasPendingWrites) {
        await this.enqueuePendingMessage(state, payload);
        return;
      }
      if (!state.ready && !(await this.ensureState(state)).ready) {
        if (state.initializationRetryable) {
          await this.enqueuePendingMessage(state, payload);
        }
        return;
      }
      if (state.hasPendingWrites) {
        await this.enqueuePendingMessage(state, payload);
        return;
      }
      const response = await this.client.addMessage(
        state.ovSessionId,
        payload,
        state.config.peerId,
      );
      if (isRetryableFailure(response)) {
        await this.enqueuePendingMessage(state, payload);
      }
    });
  }

  maybeCommit(session, event) {
    // DSH appends compaction/start before it summarizes and rewrites history,
    // so commit there regardless of the threshold, like PreCompact elsewhere.
    const boundary = event.type === "compaction/start";
    if (event.type !== "turn/end" && !boundary) return;
    const state = this.stateFor(session);
    if (!isCaptureEnabled(state.config)) return;
    this.enqueueWrite(state, async () => {
      if (state.hasPendingWrites) return;
      if (!state.ready && !(await this.ensureState(state)).ready) return;
      if (!boundary) {
        const metadata = await this.client.getSession(
          state.ovSessionId,
          state.config.peerId,
        );
        if (Number(metadata?.pending_tokens || 0) < state.config.commitTokenThreshold) return;
      }
      const response = await this.client.commitSession(
        state.ovSessionId,
        state.config.peerId,
      );
      this.log(boundary ? "compaction_commit" : "commit", {
        sessionId: state.ovSessionId,
        ok: response.ok,
        trace_id: response.result?.trace_id || response.traceId,
        error: response.ok ? undefined : response.error?.message || response.error?.code,
      });
      if (isRetryableFailure(response)) {
        await this.enqueueFinalCommit(state, { keep_recent_count: 0 });
      }
    });
  }

  dispose(session) {
    const state = this.states.get(session.id);
    if (!state) return;
    if (state.disposing) return state.disposing;
    state.disposing = (async () => {
      this.enqueueWrite(state, async () => {
        if (!isCaptureEnabled(state.config)) return;
        const commitPayload = { keep_recent_count: 0 };
        if (state.hasPendingWrites) {
          await this.enqueueFinalCommit(state, commitPayload);
          return;
        }
        if (!state.ready && !(await this.ensureState(state)).ready) return;
        const response = await this.client.commitSession(
          state.ovSessionId,
          state.config.peerId,
          { timeoutMs: Math.min(3000, Number(state.config.requestTimeoutMs) || 3000) },
        );
        this.log("shutdown_commit", {
          sessionId: state.ovSessionId,
          ok: response.ok,
          trace_id: response.result?.trace_id || response.traceId,
        });
        if (isRetryableFailure(response)) {
          await this.enqueueFinalCommit(state, commitPayload);
        }
      });
      try {
        await state.writes;
      } finally {
        if (this.states.get(session.id) === state) this.states.delete(session.id);
      }
    })();
    return state.disposing;
  }

  async disposeAll() {
    await Promise.all([...this.states.values()].map(state => this.dispose({
      id: state.dshSessionId,
    })));
  }

  enqueueWrite(state, operation) {
    state.writes = state.writes
      .then(operation)
      .catch(error => this.log("write_error", {
        sessionId: state.ovSessionId,
        error: error instanceof Error ? error.message : String(error),
      }));
  }

  async enqueuePending(state, type, payload) {
    const createdAt = Math.max(Date.now(), state.pendingCreatedAt + 1);
    state.pendingCreatedAt = createdAt;
    const result = await enqueue(type, state.ovSessionId, payload, { createdAt });
    if (result.ok) {
      // Log the latch transition only: every message that follows while the
      // latch holds takes the cheap enqueue path, so this fires once per
      // outage, not once per message.
      if (!state.hasPendingWrites) {
        this.log("pending_latched", { sessionId: state.ovSessionId, type });
      }
      state.hasPendingWrites = true;
    }
    if (!result.ok) {
      this.log("pending_enqueue_error", {
        sessionId: state.ovSessionId,
        type,
        error: result.error,
      });
    }
    return result;
  }

  async enqueueFinalCommit(state, payload) {
    await this.removePendingCommits(state);
    return this.enqueuePending(state, "commitSession", payload);
  }

  async enqueuePendingMessage(state, payload) {
    const result = await this.enqueuePending(state, "addMessage", payload);
    if (result.ok) await this.removePendingCommits(state);
    return result;
  }

  async removePendingCommits(state) {
    const pending = await listPending();
    for (const item of pending) {
      if (
        item.entry?.type === "commitSession"
        && item.entry.sessionId === state.ovSessionId
      ) {
        await dequeue(item.filename);
      }
    }
  }

  async refreshPendingState(state) {
    const wasPending = state.hasPendingWrites;
    const pending = (await listPending()).filter(
      item => item.entry?.sessionId === state.ovSessionId,
    );
    state.hasPendingWrites = pending.length > 0;
    state.pendingCreatedAt = pending.reduce(
      (latest, item) => Math.max(latest, Number(item.entry?.createdAt || 0)),
      state.pendingCreatedAt,
    );
    // Only the flip back to direct sends is logged: the recovery moment that
    // proves the drainer worked, once per outage.
    if (wasPending && !state.hasPendingWrites) {
      this.log("pending_cleared", { sessionId: state.ovSessionId });
    }
  }

  /**
   * Replay the pending queue through this runtime's client. Session
   * initialization calls it without options and keeps consuming retries; the
   * drainer passes consumeRetries:false so transient failures stay retryable.
   */
  async replayPendingQueue(options = {}) {
    await replayPending(
      (path, init) => this.client.fetchJSON(path, init),
      (stage, data) => this.log(stage, data),
      options,
    );
  }

  /**
   * One drainer tick, following the session-initialization replay flow: probe
   * health first and only replay when the server answers. Replays run without
   * consuming retry budgets, then every session's latch is re-derived from
   * the queue. An empty queue clears the latches with zero HTTP traffic, so
   * once a transient write failure recovers, capture and commit resume on
   * their own without restarting the long-lived dsh process.
   */
  async drainTick() {
    if (this.drainRunning) return;
    this.drainRunning = true;
    try {
      const pending = await listPending();
      if (pending.length > 0) {
        const health = await this.client.healthResult();
        if (!health.ok) {
          // Only the flip into the outage is logged, not every 60s probe.
          if (this.drainHealth !== false) {
            this.log("drain_health_down", { status: health.status || 0 });
          }
          this.drainHealth = false;
        } else {
          if (this.drainHealth === false) {
            this.log("drain_health_restored", {});
          }
          this.drainHealth = true;
          await this.replayPendingQueue({ consumeRetries: false });
        }
      }
      for (const state of this.states.values()) {
        await this.refreshPendingState(state);
      }
    } finally {
      this.drainRunning = false;
    }
  }

  /**
   * Start the background drainer. The interval is fixed per process; each tick
   * is single-flight, so a slow replay run never overlaps the next one.
   */
  startDrainer() {
    if (this.drainTimer) return this.drainTimer;
    const parsed = parseInt(process.env.OPENVIKING_PENDING_DRAIN_INTERVAL_MS || "", 10);
    const intervalMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
    this.drainTimer = setInterval(() => {
      this.drainPromise = this.drainTick().catch(error => this.log("drain_error", {
        error: error instanceof Error ? error.message : String(error),
      }));
    }, intervalMs);
    this.drainTimer.unref?.();
    return this.drainTimer;
  }

  stopDrainer() {
    if (!this.drainTimer) return;
    clearInterval(this.drainTimer);
    this.drainTimer = null;
  }

  async flush(session) {
    const state = this.states.get(session.id);
    if (state) await state.writes;
  }

  log(stage, data) {
    this.logger?.debug?.(`[openviking:dsh] ${stage} ${JSON.stringify(data)}`);
  }
}

function hasStartupProfile(agent) {
  const session = agent.session;
  const ownEvents = typeof session?.ownEvents === "function"
    ? session.ownEvents()
    : (session?.events || []).slice(session?.header?.seedLength ?? 0);
  const inHistory = ownEvents.some(event => (
    event?.type === "user/message" && isStartupProfile(event.data)
  ));
  if (inHistory) return true;
  return [agent.inbox?.nextTurn, agent.inbox?.nextStep].some(messages => (
    (messages || []).some(isStartupProfile)
  ));
}

function isStartupProfile(message) {
  return isOpenVikingPluginMessage(message)
    && message.source.form === "instructions";
}

// The self-closing form must come FIRST: the server renders `detail="uri"` and
// `detail="abstract"` entries as `<memory ... />`, and an alternation that tried
// the paired form first would read such a tag as an opening one and swallow
// every element up to the next `</memory>` — verified against a real block,
// where it collapsed 20 elements into 15 and dropped a fresh entry's text.
const MEMORY_ELEMENT_RE = /<memory\b[^>]*\/>|<memory\b[^>]*>[\s\S]*?<\/memory>/g;
const MEMORY_URI_RE = /\buri="([^"]+)"/;

/**
 * Keep only the memories this turn has not injected yet, and return the block
 * minus the repeated ones — or "" when nothing is left.
 *
 * The server renders the block, so the unit that can be dropped without
 * breaking it is the `<memory>` element: the envelope and its instruction line
 * are shared by every entry. A block with no element at all is passed through
 * untouched, because then there is nothing to compare against.
 */
function dropInjectedMemories(block, injected) {
  const elements = block.match(MEMORY_ELEMENT_RE);
  if (!elements?.length) return block;
  const kept = [];
  for (const element of elements) {
    const uri = MEMORY_URI_RE.exec(element)?.[1];
    if (uri === undefined) {
      kept.push(element);
      continue;
    }
    if (injected.has(uri)) continue;
    injected.add(uri);
    kept.push(element);
  }
  if (kept.length === elements.length) return block;
  if (kept.length === 0) return "";
  return block.replace(MEMORY_ELEMENT_RE, () => kept.shift() ?? "");
}
