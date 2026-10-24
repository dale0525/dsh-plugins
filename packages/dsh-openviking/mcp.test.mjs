import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@deepseek-ai/dsh-mcp-client";
import { resolveConfig } from "./config.mjs";
import { apply } from "./index.mjs";
import { buildMcpConfig, mountOpenVikingMcp } from "./mcp.mjs";

/**
 * Run `fn` with an env whose credential files live in a throwaway directory,
 * so a developer's own ~/.openviking never leaks into what is forwarded.
 */
function withCredentialFiles({ ovcli = null, ov = null } = {}, fn) {
  const dir = mkdtempSync(join(tmpdir(), "ov-dsh-mcp-"));
  try {
    const env = {
      OPENVIKING_CLI_CONFIG_FILE: join(dir, "ovcli.conf"),
      OPENVIKING_CONFIG_FILE: join(dir, "ov.conf"),
      OPENVIKING_HOME: join(dir, "home"),
    };
    if (ovcli) writeFileSync(env.OPENVIKING_CLI_CONFIG_FILE, JSON.stringify(ovcli));
    if (ov) writeFileSync(env.OPENVIKING_CONFIG_FILE, JSON.stringify(ov));
    return fn({ env, dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the mount config validates against the pinned bridge's own schema", () => {
  const config = resolveConfig({
    endpoint: "http://127.0.0.1:1933",
    apiKey: "secret",
    workspacePeer: false,
  }, {});
  const parsed = Config(buildMcpConfig(config));

  // streamable-http, not stdio: the server speaks MCP over HTTP natively, so a
  // stdio bridge would cost one Node process (~17 MB phys_footprint) per root
  // agent — 26 of them on this machine, 705 MB, for five distinct peers.
  assert.equal(parsed.transport, "streamable-http");
  assert.equal(parsed.serverName, "openviking");
  assert.equal(parsed.url, "http://127.0.0.1:1933/mcp");
  assert.equal(parsed.toolCallTimeoutMs, 60000);
  // Startup must not be fatal: recall, capture, and commit keep working when
  // only the MCP endpoint is down, and the bridge reconnects on its own.
  assert.equal(parsed.failOnStartupError, false);
  assert.equal(parsed.reconnect.enabled, true);
});

test("the mounted headers are the ones the stdio proxy used to send", () => {
  const config = resolveConfig({
    endpoint: "https://ov.example.com/",
    apiKey: "secret",
    account: "acme",
    user: "casey",
    peerId: "workspace-peer",
    recallPeerScope: "actor",
    workspacePeer: false,
  }, {});
  const parsed = Config(buildMcpConfig(config, "session-peer"));

  // Same construction the runtime talks through, so the two halves cannot
  // drift on the actor header that scopes recall to one workspace.
  assert.deepEqual(parsed.headers, {
    "Content-Type": "application/json",
    "Authorization": "Bearer secret",
    "X-OpenViking-Account": "acme",
    "X-OpenViking-User": "casey",
    "X-OpenViking-Actor-Peer": "session-peer",
    "User-Agent": config.userAgent,
  });
});

test("broad recall sends no actor header, exactly as the proxy did", () => {
  const config = resolveConfig({
    endpoint: "https://ov.example.com",
    apiKey: "secret",
    peerId: "workspace-peer",
    workspacePeer: false,
  }, {});
  const parsed = Config(buildMcpConfig(config, "session-peer"));

  // `recallPeerScope` defaults to all, and a proxy that sent the peer anyway
  // would hide every other workspace's memories from the tools.
  assert.equal(parsed.headers["X-OpenViking-Actor-Peer"], undefined);
});

test("identity headers follow the resolved auth mode, not the mount", () => {
  const trusted = resolveConfig({
    endpoint: "https://ov.example.com",
    apiKey: "secret",
    account: "acme",
    user: "casey",
    authMode: "trusted",
    workspacePeer: false,
  }, {});
  assert.equal(Config(buildMcpConfig(trusted)).headers["X-OpenViking-Account"], "acme");

  // An api_key server reads the identity out of the key and ignores the
  // headers, so naming the operator to it would leak without buying anything.
  const keyed = resolveConfig({
    endpoint: "https://ov.example.com",
    apiKey: "secret",
    account: "acme",
    user: "casey",
    authMode: "api_key",
    workspacePeer: false,
  }, {});
  assert.equal(Config(buildMcpConfig(keyed)).headers["X-OpenViking-Account"], undefined);
});

test("credentials resolved from the credential files reach the mount headers", async () => {
  await withCredentialFiles({ ovcli: { url: "https://ov.example.com/", api_key: "cli-key" } }, ({ env: files, dir }) => {
    const config = resolveConfig({ workspacePeer: false }, files, dir);
    assert.equal(config.apiKey, "cli-key");

    // The mount no longer hands its answer to a child process, so the header
    // block is the only channel the resolved credential travels on.
    assert.equal(Config(buildMcpConfig(config)).headers.Authorization, "Bearer cli-key");
  });
});

test("a key the plugin left empty sends no Authorization header", async () => {
  // ovcli.conf naming only a url pins the chain to that file, so the runtime
  // sends no key — and the mount must not invent one from the machine's root key.
  await withCredentialFiles({
    ovcli: { url: "https://ov.example.com" },
    ov: { server: { root_api_key: "root-key" } },
  }, ({ env: files, dir }) => {
    const config = resolveConfig({ workspacePeer: false }, files, dir);
    assert.equal(config.apiKey, "");

    const parsed = Config(buildMcpConfig(config));
    assert.equal(parsed.url, "https://ov.example.com/mcp");
    assert.equal(parsed.headers.Authorization, undefined);
  });
});

test("an anonymous local server sends no key or identity", () => {
  withCredentialFiles({}, ({ env: files, dir }) => {
    const config = resolveConfig({ endpoint: "http://127.0.0.1:1933", workspacePeer: false }, files, dir);
    assert.deepEqual(Config(buildMcpConfig(config)).headers, {
      "Content-Type": "application/json",
      "User-Agent": config.userAgent,
    });
  });
});

test("mounting passes the bridge plugin and its config to the host context", () => {
  const mounted = [];
  mountOpenVikingMcp(
    { plugin: (plugin, config) => mounted.push({ plugin, config }) },
    resolveConfig({ endpoint: "http://127.0.0.1:1933", workspacePeer: false }, {}),
  );

  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].plugin.name, "mcp-client");
  assert.equal(typeof mounted[0].plugin.apply, "function");
  assert.equal(mounted[0].config.serverName, "openviking");
});

test("apply mounts the tool surface instead of registering tools itself", () => {
  const mounted = [];
  const registered = [];
  apply({
    logger: { debug() {} },
    provide() {},
    effect(execute) {
      execute();
      return async () => {};
    },
    plugin: (plugin, config) => mounted.push({ plugin, config }),
    tools: { register: definition => registered.push(definition) },
    agents: { roots: () => [] },
    on() {},
  }, { endpoint: "http://127.0.0.1:1933", workspacePeer: false });

  assert.deepEqual(registered, []);
  const bridge = mounted.find(entry => entry.plugin.name === "mcp-client");
  assert.ok(bridge, "the MCP bridge must be mounted");
  assert.equal(bridge.config.url, "http://127.0.0.1:1933/mcp");
});

test("a scoped mount carries the session's peer instead of the host's", () => {
  // Actor scope is the only one that puts a peer on the wire, so this is the
  // configuration where the host's peer would leak into another session's
  // search if the mount ignored the argument.
  const config = resolveConfig({
    endpoint: "http://127.0.0.1:1933",
    apiKey: "secret",
    peerId: "host-resolved-peer",
    recallPeerScope: "actor",
    workspacePeer: false,
  }, {});

  // The root mount keeps the host's answer: it is the fallback for a session
  // the runtime has not seen yet.
  assert.equal(Config(buildMcpConfig(config)).headers["X-OpenViking-Actor-Peer"], "host-resolved-peer");
  // A session-scoped mount carries that session's own peer.
  assert.equal(Config(buildMcpConfig(config, "session-peer")).headers["X-OpenViking-Actor-Peer"], "session-peer");
  // A session with no peer must stay empty rather than inherit the host's,
  // which would scope a non-repository session to whatever project the host
  // happened to be started in.
  assert.equal(Config(buildMcpConfig(config, "")).headers["X-OpenViking-Actor-Peer"], undefined);
});

test("each root agent mounts a bridge carrying its own session's peer", () => {
  const dir = mkdtempSync(join(tmpdir(), "ov-agent-peer-"));
  try {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(
      join(dir, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:volcengine/OpenViking.git\n',
    );

    const handlers = new Map();
    const rootMounts = [];
    // The host enters an agent into its registry before it announces it, and
    // only ownerless agents are roots — so this list holds the agent by the
    // time the event reaches the plugin.
    const roots = [];
    apply({
      logger: { debug() {}, error() {}, warn() {}, info() {} },
      provide() {},
      effect(execute) {
        execute();
        return async () => {};
      },
      plugin: (plugin, config) => rootMounts.push({ plugin, config }),
      tools: { register: () => () => {} },
      agents: { roots: () => roots },
      on(event, handler) {
        handlers.set(event, handler);
      },
    }, { endpoint: "http://127.0.0.1:1933", recallPeerScope: "actor", workspacePeer: true });

    const agentMounts = [];
    const agent = {
      session: { id: "session-a", header: { cwd: dir, origin: "user" } },
      status: "working",
      inject() {},
      ctx: {
        effect(execute) {
          execute();
          return async () => {};
        },
        plugin: (plugin, config) => agentMounts.push({ plugin, config }),
      },
    };
    roots.push(agent);
    handlers.get("agent/created")({ agent });

    assert.equal(agentMounts.length, 1, "the agent scope must get its own bridge");
    assert.equal(agentMounts[0].plugin.name, "mcp-client");
    assert.equal(agentMounts[0].config.serverName, "openviking");
    assert.equal(
      agentMounts[0].config.headers["X-OpenViking-Actor-Peer"],
      "github.com-volcengine-openviking",
    );
    // The root mount remains, as the fallback for a session that never starts,
    // and it carries the host's own answer — not the session's.
    const rootBridges = rootMounts.filter(entry => entry.plugin.name === "mcp-client");
    assert.equal(rootBridges.length, 1);
    assert.notEqual(
      rootBridges[0].config.headers["X-OpenViking-Actor-Peer"],
      "github.com-volcengine-openviking",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
