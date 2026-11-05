/**
 * Offline model-id catalog: normalized official/canonical spelling -> KNOWLEDGE_BASE id.
 *
 * Curated from the 2026-11-05 snapshots of two public directories:
 *   - models.dev/api.json (MIT, https://github.com/anomalyco/models.dev)
 *   - OpenRouter /api/v1/models (id + canonical_slug; runtime reference only)
 * plus the official Claude Opus 5.5 spellings. Only dated vendor canonical
 * slugs and explicitly curated official spellings are admitted: plain catalog
 * ids equal KNOWLEDGE_BASE patterns and belong to the substring tier, where
 * they must keep their longest-boundary semantics. No fuzzy stripping, no
 * :batch/:free generalization. Keys are lowercase with all non-alphanumerics
 * removed; provider prefixes are registered both with and without the prefix.
 *
 * This is data, not a runtime dependency: the host never reads the network.
 * Update by hand when the knowledge base changes.
 */
export const MODEL_ID_CATALOG: Readonly<Record<string, string>> = {
  "anthropicclaude45opus20251124": "anthropic-claude-opus-4-5",
  "anthropicclaude46opus20260205": "anthropic-claude-4-6",
  "anthropicclaude46sonnet20260217": "anthropic-claude-4-6",
  "anthropicclaude47opus20260416": "anthropic-claude-opus-4-high",
  "anthropicclaude48opus20260528": "anthropic-claude-opus-4-high",
  "anthropicclaude5fable20260609": "anthropic-claude-5",
  "anthropicclaudefable5120260831": "anthropic-claude-5-1",
  "anthropicclaudeopus520260723": "anthropic-claude-5",
  "anthropicclaudeopus55": "anthropic-claude-5",
  "anthropicclaudeopus5520260921": "anthropic-claude-5",
  "anthropicclaudesonnet520260630": "anthropic-claude-5",
  "claude45opus20251124": "anthropic-claude-opus-4-5",
  "claude46opus20260205": "anthropic-claude-4-6",
  "claude46sonnet20260217": "anthropic-claude-4-6",
  "claude47opus20260416": "anthropic-claude-opus-4-high",
  "claude48opus20260528": "anthropic-claude-opus-4-high",
  "claude5fable20260609": "anthropic-claude-5",
  "claudefable5120260831": "anthropic-claude-5-1",
  "claudeopus520260723": "anthropic-claude-5",
  "claudeopus55": "anthropic-claude-5",
  "claudeopus5520260921": "anthropic-claude-5",
  "claudesonnet520260630": "anthropic-claude-5",
  "deepseekdeepseekv41flash20260910": "deepseek-v4-1-flash",
  "deepseekv41flash20260910": "deepseek-v4-1-flash",
  "glm4620251208": "glm-vision",
  "glm5220260616": "glm-5-2",
  "glm5320260816": "glm-5-3",
  "glm53flash20260826": "glm-5-3-flash",
  "gpt5120251113": "openai-gpt-5-1",
  "gpt51codex20251113": "openai-gpt-5-1-codex",
  "gpt5220251211": "openai-gpt-5-2",
  "gpt52chat20251211": "openai-chat",
  "gpt52codex20260114": "openai-gpt-5-2-codex",
  "gpt5420260305": "openai-gpt-5-4",
  "gpt5520260423": "openai-gpt-5-5",
  "gpt6astra20260903": "openai-gpt-6-astra",
  "gptchatlatest20260505": "openai-chat",
  "grok4320260430": "xai-grok-4-3",
  "grok4520260708": "xai-grok-4-5",
  "grok4620260810": "xai-grok-high",
  "grok4720260916": "xai-grok-4-7",
  "hy4preview20260827": "hunyuan-hy4",
  "kimik2620260420": "kimi-k2-vision",
  "kimik320260715": "kimi-k3",
  "mimov2520260422": "mimo-v2-6",
  "mimov25pro20260422": "mimo-v2-5-pro",
  "minimaxm320260531": "minimax-m3",
  "minimaxminimaxm320260531": "minimax-m3",
  "mistralaimistralmedium3520260430": "mistral-medium-3",
  "mistralmedium3520260430": "mistral-medium-3",
  "moonshotaikimik2620260420": "kimi-k2-vision",
  "moonshotaikimik320260715": "kimi-k3",
  "openaigpt5120251113": "openai-gpt-5-1",
  "openaigpt51codex20251113": "openai-gpt-5-1-codex",
  "openaigpt5220251211": "openai-gpt-5-2",
  "openaigpt52chat20251211": "openai-chat",
  "openaigpt52codex20260114": "openai-gpt-5-2-codex",
  "openaigpt5420260305": "openai-gpt-5-4",
  "openaigpt5520260423": "openai-gpt-5-5",
  "openaigpt6astra20260903": "openai-gpt-6-astra",
  "openaigptchatlatest20260505": "openai-chat",
  "qwen3827b20260814": "qwen-3-8-27b",
  "qwenqwen3827b20260814": "qwen-3-8-27b",
  "tencenthy4preview20260827": "hunyuan-hy4",
  "xaigrok4320260430": "xai-grok-4-3",
  "xaigrok4520260708": "xai-grok-4-5",
  "xaigrok4620260810": "xai-grok-high",
  "xaigrok4720260916": "xai-grok-4-7",
  "xiaomimimov2520260422": "mimo-v2-6",
  "xiaomimimov25pro20260422": "mimo-v2-5-pro",
  "zaiglm4620251208": "glm-vision",
  "zaiglm5220260616": "glm-5-2",
  "zaiglm5320260816": "glm-5-3",
  "zaiglm53flash20260826": "glm-5-3-flash",
}
