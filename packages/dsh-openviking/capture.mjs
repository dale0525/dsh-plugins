import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  extractPartsFromPayload,
  extractTextFromPayload,
  shouldCaptureText,
} from "./shared/capture-utils.mjs";

/**
 * Producer-owned source kind stamped on every message this plugin injects.
 *
 * Session format v4 refuses the retired `{ kind: 'plugin', plugin }` wrapper at
 * native admission (`format v4 message requires a producer-owned source kind`),
 * so a plugin's identity has to live in `kind` itself. The `plugin:` prefix is
 * the host's documented V4 mapping for a producer that is not one of its
 * same-name first-party plugins, and it is also what this plugin's v3-era
 * messages become when a session is migrated — so a read-back predicate written
 * against this value keeps working on both fresh and migrated history.
 */
export const OPENVIKING_PLUGIN_SOURCE = "plugin:openviking-memory";

/**
 * Kinds that carry a real conversation turn.
 *
 * Everything else is a producer's synthetic context — recall blocks,
 * time-context snapshots, guard notices, compaction checkpoints — which is
 * model input rather than human input. Under v3 every such producer shared the
 * single `plugin` kind, so a blacklist could name them all at once; under v4
 * each producer owns its own kind, so the only stable test is this whitelist of
 * the three kinds a conversation actually produces.
 */
const CONVERSATION_KINDS = new Set(["user", "model", "tool"]);

export function pluginMessage(content, source) {
  // dsh's own constructor: identity, normalization, and any future Message
  // invariants come from the pinned peer instead of a hand-built object.
  return createUserMessage({
    content: [{ type: "text", text: content }],
    source: {
      kind: OPENVIKING_PLUGIN_SOURCE,
      ...source,
    },
  });
}

export function captureEvent(event, config, toolNames = new Map()) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "tool/call") {
    if (config.captureToolResults === true) {
      toolNames.set(String(event.data.callId), event.data.name);
    }
    return null;
  }

  const message = eventMessage(event);
  if (!message) return null;
  const toolCallId = event.type === "tool/result"
    ? String(message.source?.callId || message.content?.[0]?.toolCallId || "")
    : "";
  try {
    return captureMessage(event, message, config, toolNames);
  } finally {
    if (toolCallId) toolNames.delete(toolCallId);
  }
}

function captureMessage(event, message, config, toolNames) {
  // Whitelist by source: only a real conversation turn is memory-worthy.
  // Plugin-injected context (this plugin's recall blocks, time-context
  // snapshots, any other producer's context) is model input, not human input —
  // mirroring it would launder synthetic text into memory as if a person said
  // it. A kind blacklist cannot express that under session format v4, where
  // every producer owns its own kind instead of sharing `plugin`, so the test
  // is the closed set of conversation kinds rather than one retired name.
  if (!CONVERSATION_KINDS.has(message.source?.kind)) return null;
  if (message.role === "assistant" && config.captureAssistantTurns === false) {
    return null;
  }
  if (message.source?.kind === "tool" && config.captureToolResults !== true) {
    return null;
  }

  const role = message.role === "assistant" ? "assistant" : "user";
  const toolNameById = Object.fromEntries(toolNames);
  const rawText = extractTextFromPayload(message, {
    toolMaxChars: config.captureToolMaxChars,
  });
  const parts = extractPartsFromPayload(message, {
    toolMaxChars: config.captureToolMaxChars,
    toolNameById,
  });
  const decision = shouldCaptureText(rawText, role, config);
  const structuredParts = parts.filter(part => part?.type !== "text");
  if (!decision.shouldCapture && structuredParts.length === 0) return null;

  const hasTextPart = parts.some(part => part?.type === "text");
  const bodyParts = [
    ...(hasTextPart && decision.shouldCapture && decision.text
      ? [{ type: "text", text: decision.text }]
      : []),
    ...structuredParts,
  ];
  const payload = bodyParts.length > 0
    ? { role, parts: bodyParts }
    : { role, content: decision.text };
  const createdAt = eventCreatedAt(event);
  if (createdAt) payload.created_at = createdAt;
  if (config.peerId) payload.peer_id = config.peerId;
  return payload;
}

export function promptText(messages) {
  return (messages || [])
    .filter(message => message?.source?.kind !== OPENVIKING_PLUGIN_SOURCE)
    .map(message => extractTextFromPayload(message))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function eventMessage(event) {
  switch (event.type) {
    case "user/message":
      return event.data;
    case "assistant/message":
    case "tool/result":
      return event.data?.message;
    default:
      return null;
  }
}

function eventCreatedAt(event) {
  const time = Number(event?.time);
  if (!Number.isFinite(time) || time < 0) return "";
  try {
    return new Date(time).toISOString();
  } catch {
    return "";
  }
}
