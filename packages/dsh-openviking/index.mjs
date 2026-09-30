import { OpenVikingClient } from "./client.mjs";
import { resolveConfig } from "./config.mjs";
import { mountOpenVikingMcp } from "./mcp.mjs";
import { OpenVikingRuntime } from "./runtime.mjs";
import { mountOpenVikingSkills } from "./skills.mjs";
import { guardVikingUri, noticeVikingUri } from "./uri-guard.mjs";

export const name = "openviking-memory";
export const inject = ["agents", "sessions", "tools"];

export function apply(ctx, input = {}) {
  const config = resolveConfig(input);
  const client = new OpenVikingClient(config);
  const runtime = new OpenVikingRuntime(client, config, ctx.logger);
  const skipMemory = session => (
    config.skipSubagentSessions && session?.header?.origin === "subagent"
  );
  ctx.provide("openvikingMemory", runtime);
  ctx.effect(
    () => () => runtime.disposeAll(),
    "openvikingMemory.disposeAll()",
  );
  // The pending-queue drainer is the in-process recovery path: without it a
  // single transient write failure latches capture/commit until the next dsh
  // restart. Started here so every session shares one single-flight drainer.
  runtime.startDrainer();
  ctx.effect(
    () => () => runtime.stopDrainer(),
    "openvikingMemory.stopDrainer()",
  );

  // A memory tool surface belongs to the session, not the host. The root mount
  // below resolved its peer against the host's own cwd, which is no session's
  // project, so a session in another workspace would search — and be scoped by
  // — whatever project launched the host. Each root agent gets its own mount
  // carrying the peer that session resolved, and it shadows the root
  // registration for that agent alone: the tool registry resolves the nearest
  // scope first, and `agent.ctx` carries the agent's own scope.
  //
  // Subagents are excluded twice over: by owner, since `roots()` holds only
  // ownerless agents, and by the same `skipSubagentSessions` toggle that
  // governs the rest of the plugin — every mount starts its own proxy process.
  const attached = new Map();
  const attach = agent => {
    if (attached.has(agent) || skipMemory(agent.session)) return;
    if (!ctx.agents.roots().includes(agent)) return;
    attached.set(agent, ctx.effect(() => agent.ctx.effect(() => {
      mountOpenVikingMcp(
        agent.ctx,
        config,
        runtime.stateFor(agent.session).config.peerId,
      );
      return () => runtime.dispose(agent.session);
    }, "openvikingMemory.disposeSession()")));
  };
  ctx.on("agent/created", ({ agent }) => {
    attach(agent);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    const detach = attached.get(agent);
    if (detach === undefined) return;
    attached.delete(agent);
    detach();
  });
  for (const agent of ctx.agents.roots()) attach(agent);

  // prepend: downstream waterfall listeners run first, so this plugin sees
  // the final claimed batch and appends after every other contributor.
  // Profile + recall are independent after `next()`; run them concurrently so
  // the agent/pre-step waterfall (which currently gates user/message push in
  // dsh-agent-loop) spends less wall time (#4515).
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    if (skipMemory(agent.session)) return decision;
    if (decision.kind !== "enter" || signal.aborted) return decision;
    const [profile, recall] = await Promise.all([
      runtime.profileMessage(agent),
      runtime.recallMessage(agent, decision.messages),
    ]);
    if (signal.aborted) return decision;
    const additions = [profile, recall].filter(Boolean);
    return additions.length > 0
      ? { kind: "enter", messages: [...decision.messages, ...additions] }
      : decision;
  }, { prepend: true });

  ctx.on("session/event", (session, event) => {
    if (skipMemory(session)) return;
    runtime.capture(session, event);
    runtime.maybeCommit(session, event);
  });

  ctx.on("session/flush", async session => {
    if (skipMemory(session)) return;
    await runtime.flush(session);
  });

  ctx.on("tools/pre-execute", guardVikingUri);
  ctx.on("tools/post-execute", noticeVikingUri);

  // Mounted last, and deliberately not awaited: the bridge's apply blocks on
  // its first tools/list, so a server that accepts the connection but never
  // answers would otherwise hold up every registration above it.
  mountOpenVikingMcp(ctx, config);
  mountOpenVikingSkills(ctx);
}
