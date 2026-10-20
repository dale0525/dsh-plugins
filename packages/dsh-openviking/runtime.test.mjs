import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { enqueue, listPending } from "./shared/pending-queue.mjs";
import { deriveWorkspacePeerId } from "./shared/workspace-peer.mjs";
import { OPENVIKING_PLUGIN_KIND } from "./capture.mjs";
import { OpenVikingRuntime } from "./runtime.mjs";

const originalPendingDir = process.env.OPENVIKING_PENDING_DIR;
const originalStateDir = process.env.OPENVIKING_STATE_DIR;
const tempDirs = [];

afterEach(async () => {
  if (originalPendingDir === undefined) delete process.env.OPENVIKING_PENDING_DIR;
  else process.env.OPENVIKING_PENDING_DIR = originalPendingDir;
  if (originalStateDir === undefined) delete process.env.OPENVIKING_STATE_DIR;
  else process.env.OPENVIKING_STATE_DIR = originalStateDir;
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test("runtime uses a portable OpenViking id for DSH IM sessions", () => {
  const runtime = new OpenVikingRuntime({}, config(), { debug() {} });
  const state = runtime.stateFor({
    id: "im:weixin_fixture:dm:1790750070550:chat_fixture@im.wechat",
    header: { cwd: "/workspace" },
  });

  assert.equal(
    state.ovSessionId,
    "dsh-im_weixin_fixture_dm_1790750070550_chat_fixture@im.wechat__eb8b3dae7d74",
  );
});

test("capture queues retryable failures but drops permanent client errors", async () => {
  for (const [status, expectedPending] of [[400, 0], [503, 1]]) {
    const pendingDir = await mkdtemp(join(tmpdir(), `dsh-memory-${status}-`));
    tempDirs.push(pendingDir);
    process.env.OPENVIKING_PENDING_DIR = pendingDir;

    const runtime = new OpenVikingRuntime({
      async addMessage() {
        return { ok: false, status, error: { code: "FAILED" } };
      },
    }, config(), { debug() {} });
    const session = { id: `session-${status}`, header: { cwd: "/workspace" } };
    runtime.stateFor(session).ready = true;

    runtime.capture(session, userEvent(`Remember the ${status} behavior.`));
    await runtime.flush(session);

    assert.equal((await listPending()).length, expectedPending, `HTTP ${status}`);
  }
});

test("initialization queues capture only when the failure is retryable", async () => {
  for (const [status, expectedPending] of [[401, 0], [503, 1]]) {
    const pendingDir = await mkdtemp(join(tmpdir(), `dsh-memory-init-${status}-`));
    tempDirs.push(pendingDir);
    process.env.OPENVIKING_PENDING_DIR = pendingDir;

    const runtime = new OpenVikingRuntime({
      async healthResult() {
        return { ok: false, status, error: { code: "FAILED" } };
      },
    }, config(), { debug() {} });
    const session = { id: `init-${status}`, header: { cwd: "/workspace" } };

    runtime.capture(session, userEvent(`Remember the init ${status} behavior.`));
    await runtime.flush(session);

    assert.equal((await listPending()).length, expectedPending, `HTTP ${status}`);
  }
});

test("existing OpenViking sessions are reusable on DSH resume", async () => {
  const pendingDir = await mkdtemp(join(tmpdir(), "dsh-memory-resume-"));
  tempDirs.push(pendingDir);
  process.env.OPENVIKING_PENDING_DIR = pendingDir;

  const runtime = new OpenVikingRuntime({
    async healthResult() {
      return { ok: true };
    },
    async ensureSessionResult() {
      return {
        ok: false,
        status: 409,
        error: { code: "ALREADY_EXISTS", message: "session exists" },
      };
    },
    async fetchJSON() {
      return { ok: false, status: 503, error: { code: "UNAVAILABLE" } };
    },
  }, config(), { debug() {} });

  const state = await runtime.initialize({
    session: { id: "resume", header: { cwd: "/workspace" } },
  });

  assert.equal(state.ready, true);
  assert.equal(state.initializationRetryable, false);
});

test("a retryable threshold commit failure is queued", async () => {
  const pendingDir = await mkdtemp(join(tmpdir(), "dsh-memory-commit-"));
  tempDirs.push(pendingDir);
  process.env.OPENVIKING_PENDING_DIR = pendingDir;
  const runtime = new OpenVikingRuntime({
    async getSession() {
      return { pending_tokens: 20000 };
    },
    async commitSession() {
      return { ok: false, status: 503, error: { code: "UNAVAILABLE" } };
    },
  }, config(), { debug() {} });
  const session = { id: "commit-failure", header: { cwd: "/workspace" } };
  runtime.stateFor(session).ready = true;

  runtime.maybeCommit(session, { type: "turn/end" });
  await runtime.flush(session);

  assert.deepEqual((await listPending()).map(item => item.entry.type), [
    "commitSession",
  ]);
});

test("compaction/start commits below the token threshold without reading session metadata", async () => {
  const pendingDir = await mkdtemp(join(tmpdir(), "dsh-memory-compaction-"));
  tempDirs.push(pendingDir);
  process.env.OPENVIKING_PENDING_DIR = pendingDir;
  let getSessionCalls = 0;
  let commitCalls = 0;
  const runtime = new OpenVikingRuntime({
    async getSession() {
      getSessionCalls += 1;
      return { pending_tokens: 5 };
    },
    async commitSession() {
      commitCalls += 1;
      return { ok: true };
    },
  }, config(), { debug() {} });
  const session = { id: "compaction-commit", header: { cwd: "/workspace" } };
  runtime.stateFor(session).ready = true;

  runtime.maybeCommit(session, { type: "compaction/start" });
  await runtime.flush(session);

  assert.equal(getSessionCalls, 0);
  assert.equal(commitCalls, 1);

  runtime.maybeCommit(session, { type: "compaction/end" });
  await runtime.flush(session);

  assert.equal(getSessionCalls, 0);
  assert.equal(commitCalls, 1);
});

test("once a write is queued, later messages and the final commit stay ordered on disk", async () => {
  const pendingDir = await mkdtemp(join(tmpdir(), "dsh-memory-order-"));
  tempDirs.push(pendingDir);
  process.env.OPENVIKING_PENDING_DIR = pendingDir;
  let addCalls = 0;
  let commitCalls = 0;
  const runtime = new OpenVikingRuntime({
    async addMessage() {
      addCalls += 1;
      return { ok: false, status: 503, error: { code: "UNAVAILABLE" } };
    },
    async commitSession() {
      commitCalls += 1;
      return { ok: true };
    },
  }, config(), { debug() {} });
  const session = { id: "ordered", header: { cwd: "/workspace" } };
  runtime.stateFor(session).ready = true;

  runtime.capture(session, userEvent("First queued message."));
  runtime.capture(session, userEvent("Second queued message."));
  runtime.maybeCommit(session, { type: "turn/end" });
  await runtime.flush(session);
  assert.deepEqual((await listPending()).map(item => item.entry.type), [
    "addMessage",
    "addMessage",
  ]);
  await runtime.dispose(session);

  const pending = await listPending();
  assert.deepEqual(pending.map(item => item.entry.type), [
    "addMessage",
    "addMessage",
    "commitSession",
  ]);
  assert.deepEqual(
    pending.map(item => (
      item.entry.type === "commitSession"
        ? item.entry.payload
        : item.entry.payload.parts?.[0]?.text || item.entry.payload.content
    )),
    ["First queued message.", "Second queued message.", { keep_recent_count: 0 }],
  );
  assert.deepEqual(
    pending.map(item => item.entry.createdAt),
    [...pending.map(item => item.entry.createdAt)].sort((left, right) => left - right),
  );
  assert.equal(addCalls, 1);
  assert.equal(commitCalls, 0);
});

test("new queued messages move an older pending commit behind them", async () => {
  const pendingDir = await mkdtemp(join(tmpdir(), "dsh-memory-reorder-"));
  tempDirs.push(pendingDir);
  process.env.OPENVIKING_PENDING_DIR = pendingDir;
  await enqueue("commitSession", "dsh-reorder", { keep_recent_count: 10 });
  const runtime = new OpenVikingRuntime({
    async healthResult() {
      return { ok: true };
    },
    async ensureSessionResult() {
      return { ok: true };
    },
    async fetchJSON() {
      return { ok: false, status: 503, error: { code: "UNAVAILABLE" } };
    },
  }, config(), { debug() {} });
  const session = { id: "reorder", header: { cwd: "/workspace" } };

  runtime.capture(session, userEvent("Message after an offline commit."));
  await runtime.flush(session);
  assert.deepEqual((await listPending()).map(item => item.entry.type), [
    "addMessage",
  ]);

  await runtime.dispose(session);
  assert.deepEqual((await listPending()).map(item => item.entry.type), [
    "addMessage",
    "commitSession",
  ]);
});

test("flush waits only for the requested session", async () => {
  const runtime = new OpenVikingRuntime({}, config(), { debug() {} });
  const first = { id: "first", header: { cwd: "/workspace/first" } };
  const second = { id: "second", header: { cwd: "/workspace/second" } };
  let releaseSecond;
  runtime.stateFor(first).writes = Promise.resolve();
  runtime.stateFor(second).writes = new Promise(resolve => {
    releaseSecond = resolve;
  });

  await runtime.flush(first);
  releaseSecond();
  await runtime.flush(second);
});

test("dispose waits for the final commit before deleting session state", async () => {
  let releaseCommit;
  let commitOptions;
  const committed = new Promise(resolve => {
    releaseCommit = resolve;
  });
  const runtime = new OpenVikingRuntime({
    async commitSession(_sessionId, _peerId, options) {
      commitOptions = options;
      await committed;
      return { ok: true, result: { trace_id: "shutdown" } };
    },
  }, config(), { debug() {} });
  const session = { id: "dispose", header: { cwd: "/workspace" } };
  runtime.stateFor(session).ready = true;

  let settled = false;
  const disposing = runtime.dispose(session).then(() => {
    settled = true;
  });
  await Promise.resolve();

  assert.equal(settled, false);
  assert.equal(runtime.states.has(session.id), true);
  assert.deepEqual(commitOptions, { timeoutMs: 3000 });
  releaseCommit();
  await disposing;
  assert.equal(runtime.states.has(session.id), false);
});

test("persisted profile delivery survives dispose and re-seed", async () => {
  const runtime = new OpenVikingRuntime({
    async commitSession() {
      return { ok: true };
    },
  }, config(), { debug() {} });
  const session = {
    id: "profile-resume",
    header: { cwd: "/workspace" },
    events: [],
  };
  const firstState = runtime.stateFor(session);
  firstState.ready = true;
  firstState.profileBlock = "profile v1";

  const profile = await runtime.profileMessage({ session });
  assert.equal(profile?.source?.kind, OPENVIKING_PLUGIN_KIND);
  assert.equal(profile?.source?.form, "instructions");
  session.events.push({ type: "user/message", data: profile });
  await runtime.dispose(session);

  const resumedSession = {
    id: session.id,
    header: session.header,
    events: [...session.events],
  };
  const resumedState = runtime.stateFor(resumedSession);
  resumedState.ready = true;
  resumedState.profileBlock = "profile v2";
  assert.equal(await runtime.profileMessage({ session: resumedSession }), null);
  assert.equal(resumedState.profileDelivered, true);

  const pendingSession = {
    id: "profile-pending",
    header: { cwd: "/workspace" },
    events: [],
  };
  const pendingState = runtime.stateFor(pendingSession);
  pendingState.ready = true;
  pendingState.profileBlock = "pending profile";
  assert.equal(await runtime.profileMessage({
    session: pendingSession,
    inbox: { nextTurn: [], nextStep: [profile] },
  }), null);

  const otherSession = {
    id: "profile-other",
    header: { cwd: "/workspace", seedLength: 1 },
    events: [{ type: "user/message", data: profile }],
  };
  const otherState = runtime.stateFor(otherSession);
  otherState.ready = true;
  otherState.profileBlock = "other profile";
  assert.equal(
    (await runtime.profileMessage({ session: otherSession }))?.source?.form,
    "instructions",
  );
});

test("profile delivery uses current DSH session-owned history on resume and fork", async () => {
  const profile = {
    type: "user/message",
    data: {
      role: "user",
      content: [{ type: "text", text: "stored profile" }],
      source: { kind: "plugin:openviking-memory", form: "instructions" },
    },
  };
  for (const [id, ownEvents, expected] of [
    ["resumed", [profile], null],
    ["forked", [], "instructions"],
    ["forked-resumed", [profile], null],
  ]) {
    const runtime = new OpenVikingRuntime({}, config(), { debug() {} });
    let historyReads = 0;
    const session = {
      id,
      header: { cwd: "/workspace", isSeeded: id !== "resumed" },
      ownEvents() {
        historyReads += 1;
        return ownEvents;
      },
    };
    const state = runtime.stateFor(session);
    state.ready = true;
    state.profileBlock = "current profile";

    const message = await runtime.profileMessage({ session });

    assert.equal(message?.source?.form ?? null, expected, id);
    assert.equal(historyReads, 1, id);
    assert.equal(state.profileDelivered, true, id);
    assert.equal(await runtime.profileMessage({ session }), null, id);
  }
});

test("disposeAll drains every live session", async () => {
  const committed = [];
  const runtime = new OpenVikingRuntime({
    async commitSession(sessionId) {
      committed.push(sessionId);
      return { ok: true };
    },
  }, config(), { debug() {} });
  for (const id of ["one", "two"]) {
    runtime.stateFor({ id, header: { cwd: `/workspace/${id}` } }).ready = true;
  }

  await runtime.disposeAll();

  assert.deepEqual(committed.sort(), ["dsh-one", "dsh-two"]);
  assert.equal(runtime.states.size, 0);
});

// dsh and pi had no recall switch at all: every other harness could turn recall
// off and these two retrieved on every prompt regardless.
test("autoRecall false stops the recall request", async () => {
  const runtime = new OpenVikingRuntime({
    async fetchJSON() {
      throw new Error("recall must not reach the server when it is switched off");
    },
  }, { ...config(), autoRecall: false }, { debug() {} });
  runtime.initialize = async () => ({ ready: true, config: { ...config(), autoRecall: false } });

  assert.equal(await runtime.recallMessage({}, [{ role: "user", content: "what did we decide" }]), null);
});

// A batch of injected context alone (time-context, job notices) carries no
// user query, so it must not trigger a recall request.
test("injected context alone does not trigger recall", async () => {
  const runtime = new OpenVikingRuntime({
    async fetchJSON() {
      throw new Error("recall must not run without user input");
    },
  }, { ...config(), minQueryLength: 0 }, { debug() {} });
  runtime.initialize = async () => ({ ready: true, config: { ...config(), minQueryLength: 0 } });

  assert.equal(await runtime.recallMessage({}, [{
    role: "user",
    content: [{ type: "text", text: "Current time: 2026-10-05 21:20" }],
    source: { kind: "time-context" },
  }]), null);
});

// recall-core reads options.excludeUris, but the DSH runtime built its options
// without it, so nothing a user configured could stop a subtree from being
// recalled: generated directory files came back as ordinary hits.
test("recallExcludeUris reaches the search request", async () => {
  const bodies = [];
  const runtime = new OpenVikingRuntime({
    async fetchJSON(path, init) {
      if (/\/search\/search$/.test(path)) bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        result: {
          context: "<openviking-context>\nrecalled\n</openviking-context>",
          stats: {},
        },
      };
    },
  }, { ...config(), recallExcludeUris: ["viking://user/default/skills", "viking://agent/skills"] }, { debug() {} });
  runtime.initialize = async () => ({
    ready: true,
    config: { ...config(), recallExcludeUris: ["viking://user/default/skills", "viking://agent/skills"] },
  });

  await runtime.recallMessage({}, [{ role: "user", content: "what did we decide" }]);

  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].exclude_uris, ["viking://user/default/skills", "viking://agent/skills"]);
});

test("recall sends no exclude_uris when recallExcludeUris is unset", async () => {
  const bodies = [];
  const runtime = new OpenVikingRuntime({
    async fetchJSON(path, init) {
      if (/\/search\/search$/.test(path)) bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        result: { context: "<openviking-context>\nrecalled\n</openviking-context>", stats: {} },
      };
    },
  }, config(), { debug() {} });
  runtime.initialize = async () => ({ ready: true, config: config() });

  await runtime.recallMessage({}, [{ role: "user", content: "what did we decide" }]);

  assert.equal(bodies.length, 1);
  assert.equal("exclude_uris" in bodies[0], false);
});

// One turn fires recall once per step, not once per turn, and the server's own
// `dedup_turns` window still answers with 10 entries per call. Measured over a
// 51-turn session: 217 firings carried 4242 URI slots but only 342 distinct
// URIs, 78% of the repeats one turn apart, and 142 of the firings shared a URI
// with an earlier firing of the same turn. Re-injecting what this turn already
// put in front of the model is pure dilution — the same reason the loader does
// not re-send AGENTS.md before a compaction.
test("a URI already injected in this turn is not injected again", async () => {
  const bodies = [];
  const runtime = new OpenVikingRuntime({
    async fetchJSON(path, init) {
      if (!/\/search\/search$/.test(path)) return { ok: true, result: {} };
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        result: {
          entries: [],
          rendered: [
            '<memory uri="viking://user/dsh/a.md" score="0.9">\na\n</memory>',
            '<memory uri="viking://user/dsh/b.md" score="0.9" detail="uri" />',
          ].join("\n"),
          stats: {},
        },
      };
    },
  }, config(), { debug() {} });
  const session = { id: "same-turn", header: { cwd: "/workspace" } };
  runtime.stateFor(session).ready = true;
  runtime.initialize = async () => runtime.stateFor(session);

  const first = await runtime.recallMessage({ session }, [{ role: "user", content: "what did we decide" }], { turn: 1 });
  const second = await runtime.recallMessage({ session }, [{ role: "user", content: "what did we decide" }], { turn: 1 });

  assert.match(first.content[0].text, /a\.md/);
  assert.match(first.content[0].text, /b\.md/);
  assert.equal(second, null);
  // The server's exclude_uris was measured to change WHICH entries come back,
  // not how many, so the repeat is dropped from the block, not the request.
  assert.equal("exclude_uris" in bodies[1], false);
});

// The server renders `detail="uri"` and `detail="abstract"` entries as
// `<memory ... />`, and a real block interleaves them with the paired form. An
// alternation that tried the paired form first reads such a tag as an opening
// one and swallows everything up to the next `</memory>`: measured on a real
// block, 20 elements collapsed to 15 and one entry's text disappeared.
test("a self-closing entry does not swallow the next one", async () => {
  const rendered = [
    '<memory uri="viking://user/dsh/self.md" score="0.9" detail="uri" />',
    '<memory uri="viking://user/dsh/paired.md" score="0.9" detail="overview">\npaired body\n</memory>',
  ].join("\n");
  let served = 0;
  const runtime = new OpenVikingRuntime({
    async fetchJSON(path) {
      if (!/\/search\/search$/.test(path)) return { ok: true, result: {} };
      served += 1;
      return {
        ok: true,
        result: {
          entries: [],
          rendered: served === 1
            ? rendered
            : rendered.replace('uri="viking://user/dsh/paired.md"', 'uri="viking://user/dsh/fresh.md"'),
          stats: {},
        },
      };
    },
  }, config(), { debug() {} });
  const session = { id: "self-closing", header: { cwd: "/workspace" } };
  runtime.stateFor(session).ready = true;
  runtime.initialize = async () => runtime.stateFor(session);

  await runtime.recallMessage({ session }, [{ role: "user", content: "x" }], { turn: 1 });
  const second = await runtime.recallMessage({ session }, [{ role: "user", content: "x" }], { turn: 1 });

  // The fresh entry survived as its own element; the repeated self-closing one
  // is gone, and the fresh body did not travel attached to it.
  assert.match(second.content[0].text, /fresh\.md/u);
  assert.doesNotMatch(second.content[0].text, /self\.md/u);
  assert.match(second.content[0].text, /paired body/u);
});

test("a new turn may inject a URI an earlier turn already injected", async () => {
  const runtime = new OpenVikingRuntime({
    async fetchJSON(path) {
      if (!/\/search\/search$/.test(path)) return { ok: true, result: {} };
      return {
        ok: true,
        result: {
          entries: [],
          rendered: '<memory uri="viking://user/dsh/a.md" score="0.9">\na\n</memory>',
          stats: {},
        },
      };
    },
  }, config(), { debug() {} });
  const session = { id: "next-turn", header: { cwd: "/workspace" } };
  runtime.stateFor(session).ready = true;
  runtime.initialize = async () => runtime.stateFor(session);

  await runtime.recallMessage({ session }, [{ role: "user", content: "what did we decide" }], { turn: 1 });
  const second = await runtime.recallMessage({ session }, [{ role: "user", content: "what did we decide" }], { turn: 2 });

  assert.match(second.content[0].text, /a\.md/);
});

// Compaction rewrites the surface history those blocks were part of, so what it
// dropped is no longer in front of the model and must be injectable again.
test("compaction/end forgets the URIs this turn injected", async () => {
  const runtime = new OpenVikingRuntime({
    async fetchJSON(path) {
      if (!/\/search\/search$/.test(path)) return { ok: true, result: {} };
      return {
        ok: true,
        result: {
          entries: [],
          rendered: '<memory uri="viking://user/dsh/a.md" score="0.9">\na\n</memory>',
          stats: {},
        },
      };
    },
  }, config(), { debug() {} });
  const session = { id: "compacted", header: { cwd: "/workspace" } };
  runtime.stateFor(session).ready = true;
  runtime.initialize = async () => runtime.stateFor(session);

  await runtime.recallMessage({ session }, [{ role: "user", content: "what did we decide" }], { turn: 1 });
  runtime.forgetInjected(session);
  const after = await runtime.recallMessage({ session }, [{ role: "user", content: "what did we decide" }], { turn: 1 });

  assert.match(after.content[0].text, /a\.md/);
});

test("syncTurns false sends nothing: no capture, no commit, no dispose flush, no replay", async () => {
  const pendingDir = await mkdtemp(join(tmpdir(), "dsh-memory-sync-off-"));
  tempDirs.push(pendingDir);
  process.env.OPENVIKING_PENDING_DIR = pendingDir;
  await enqueue("addMessage", "dsh-earlier", { content: "queued while capture was on" });

  const writes = [];
  const runtime = new OpenVikingRuntime({
    async healthResult() {
      return { ok: true };
    },
    async ensureSessionResult() {
      return { ok: true };
    },
    async fetchJSON(path, init) {
      if (init?.method === "POST" && /\/(messages|commit)$/.test(path)) writes.push(path);
      return { ok: false, status: 503, error: { code: "UNAVAILABLE" } };
    },
    async addMessage() {
      writes.push("addMessage");
      return { ok: true };
    },
    async getSession() {
      return { pending_tokens: 1000000 };
    },
    async commitSession() {
      writes.push("commitSession");
      return { ok: true };
    },
  }, { ...config(), syncTurns: false }, { debug() {} });
  const session = { id: "sync-off", header: { cwd: "/workspace" } };

  runtime.capture(session, userEvent("Never sent."));
  runtime.maybeCommit(session, { type: "turn/end" });
  // The recall path reaches initialization even when nothing is captured, and
  // the toggle takes the replay out of it without taking the reads with it.
  assert.equal((await runtime.initialize({ session })).ready, true);
  await runtime.flush(session);
  await runtime.dispose(session);

  assert.deepEqual(writes, []);
  const pending = await listPending();
  assert.deepEqual(pending.map(item => item.entry.sessionId), ["dsh-earlier"]);
  assert.ok(!pending[0].entry.retries);
});

test("the per-session peer honors peerSource", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "dsh-memory-peer-")));
  tempDirs.push(root);
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(
    join(root, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:volcengine/OpenViking.git\n',
  );
  process.env.OPENVIKING_STATE_DIR = join(root, ".state");
  const session = { id: "peer", header: { cwd: root } };

  const byGit = new OpenVikingRuntime({}, {
    ...config(),
    workspacePeer: true,
  }, { debug() {} }).stateFor(session).config;
  const byCwd = new OpenVikingRuntime({}, {
    ...config(),
    workspacePeer: true,
    peerSource: "cwd",
  }, { debug() {} }).stateFor(session).config;

  assert.equal(byGit.peerId, "github.com-volcengine-openviking");
  assert.equal(byGit.legacyPeerId, deriveWorkspacePeerId(root));
  assert.equal(byCwd.peerId, deriveWorkspacePeerId(root));
});

test("a session re-resolves a peer that was empty when it started", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "dsh-memory-peer-late-")));
  tempDirs.push(root);
  process.env.OPENVIKING_STATE_DIR = join(root, ".state");

  const payloads = [];
  const runtime = new OpenVikingRuntime({
    async addMessage(_sessionId, payload) {
      payloads.push(payload);
      return { ok: true };
    },
  }, { ...config(), workspacePeer: true }, { debug() {} });
  const session = { id: "late-peer", header: { cwd: root } };

  // Opened in a directory that is not a workspace yet: no peer is sent, and
  // that answer must not outlive the directory.
  assert.equal(runtime.stateFor(session).config.peerId, "");
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(
    join(root, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:volcengine/OpenViking.git\n',
  );

  runtime.stateFor(session).ready = true;
  runtime.capture(session, userEvent("This directory is a repository now."));
  await runtime.flush(session);

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].peer_id, "github.com-volcengine-openviking");
});

test("a session peer honors the workspace's .openviking/config.json", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "dsh-memory-ws-peer-")));
  tempDirs.push(root);
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(
    join(root, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:volcengine/OpenViking.git\n',
  );
  await mkdir(join(root, ".openviking"), { recursive: true });
  await writeFile(
    join(root, ".openviking", "config.json"),
    JSON.stringify({ version: 1, peer: { id: "declared-peer" } }),
  );
  process.env.OPENVIKING_STATE_DIR = join(root, ".state");

  const session = { id: "ws-peer", header: { cwd: root } };
  const cfg = new OpenVikingRuntime({}, {
    ...config(),
    workspacePeer: true,
  }, { debug() {} }).stateFor(session).config;

  assert.equal(cfg.peerId, "declared-peer");
});

function config() {
  return {
    explicitPeerId: "",
    workspacePeer: false,
    peerId: "",
    syncTurns: true,
    captureAssistantTurns: true,
    captureToolResults: false,
    captureToolMaxChars: 1000000,
    captureMaxLength: 24000,
    captureMode: "semantic",
    commitKeepRecentCount: 10,
  };
}

function userEvent(text) {
  return {
    type: "user/message",
    data: {
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user" },
    },
  };
}
