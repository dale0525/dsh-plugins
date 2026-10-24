import { MCP_SERVER_NAME } from "./config.mjs";
import { buildOvHeaders } from "./shared/ov-http.mjs";
import { parseExtraHeaders, resolveMcpActorPeerId } from "./shared/mcp-proxy-config.mjs";

/**
 * Build the dsh-mcp-client config for the OpenViking MCP endpoint.
 *
 * The server speaks MCP over streamable HTTP natively, so the bridge connects
 * to it directly. It used to start a stdio proxy per mount instead — one Node
 * process per root agent, which on this machine meant 26 processes and 705 MB
 * of phys_footprint to reach five distinct peers.
 *
 * The headers come from the same `buildOvHeaders` the runtime's own HTTP path
 * uses, so the tool surface and the recall path cannot drift on the actor
 * header that scopes recall to one workspace. The protocol headers are not
 * listed here on purpose: the transport owns `content-type`,
 * `mcp-protocol-version` and `mcp-session-id`, and derives `accept` itself.
 */
export function buildMcpConfig(config, peerId = undefined) {
  // A mount can be scoped to one session, whose peer is not the host's: the
  // host resolves its copy of the config against its own cwd, so a session in
  // another project must override it. Passing "" is a real answer — a session
  // outside any workspace has no peer, and inheriting the host's would file
  // its memories under whichever project happened to launch the host.
  const actorPeerId = resolveMcpActorPeerId({
    peerId: peerId === undefined ? config.peerId : peerId,
    recallPeerScope: config.recallPeerScope,
  });
  return {
    transport: "streamable-http",
    serverName: MCP_SERVER_NAME,
    url: config.mcpUrl,
    headers: buildOvHeaders(config, {
      actorPeerId,
      extraHeaders: parseExtraHeaders(process.env.OPENVIKING_EXTRA_HEADERS),
    }),
    toolCallTimeoutMs: config.mcpToolCallTimeoutMs,
  };
}
