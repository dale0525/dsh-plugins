/**
 * Draft-state capacity prefill. A row the user just adopted from the endpoint
 * listing is still a form draft: the host has written nothing, and its two
 * capacity inputs are empty. This module computes what the saved-row autofill
 * would declare, as plain strings the official inputs can parse, so the value
 * is visible and editable before Save.
 *
 * @module dsh-better-reasoning-effort/client/draft-capacity
 */

import { capacityFillOf } from '../autofill.js'
import {
  matchKnowledgeBase,
  suggestEfforts,
  type CompatSuggestion,
  type EndpointFacts,
  type InputModalities,
  type ReasoningEfforts,
  type RouteFacts,
  type ThinkingLevel,
} from '../knowledge.js'

/**
 * The reasoning parameters to show for a freshly adopted, still-unsaved row.
 * Only a curated knowledge-base match is safe to prefill automatically;
 * protocol and name heuristics stay behind the explicit Auto-adapt UI, and an
 * endpoint that explicitly reports no reasoning suppresses the suggestion.
 */
export interface DraftEffortDeclaration {
  efforts: ReasoningEfforts
  compat?: CompatSuggestion
  defaultEffort?: ThinkingLevel
  input?: InputModalities
}

/**
 * The same curated declaration the saved-row autofill writes, computed from
 * the one suggestion source so the draft and the persisted row cannot drift.
 * @param modelId - the model id as typed/adopted in this row.
 * @param route - the typed route facts (protocol, endpoint, display name).
 * @param endpoint - the endpoint listing's reasoning signal, when probed.
 */
export function draftEffortDeclarationOf(
  modelId: string,
  route: RouteFacts,
  endpoint?: EndpointFacts,
): DraftEffortDeclaration | undefined {
  const suggestion = suggestEfforts(modelId, route, endpoint)
  if (suggestion.matched !== true || suggestion.efforts === undefined || suggestion.efforts === false) return undefined
  return {
    efforts: suggestion.efforts,
    ...(suggestion.compat === undefined ? {} : { compat: suggestion.compat }),
    ...(suggestion.defaultEffort === undefined ? {} : { defaultEffort: suggestion.defaultEffort }),
    ...(suggestion.input === undefined ? {} : { input: suggestion.input }),
  }
}

/** The initial editor props a draft row shows before Save. */
export interface DraftEffortProps {
  efforts?: ReasoningEfforts
  compat?: CompatSuggestion
  defaultEffort?: ThinkingLevel
  input?: InputModalities
}

/**
 * The visible prefill for one draft row. When the official Models page owns
 * the reasoning-levels control, the plugin must not put a ladder in its own
 * editor: that control is the single surface for the level set. The other
 * parts still come from the same curated suggestion.
 * @param modelId - the model id as typed/adopted in this row.
 * @param route - the typed route facts.
 * @param officialReasoning - whether the official control owns the ladder.
 */
export function draftEffortPropsOf(
  modelId: string,
  route: RouteFacts,
  officialReasoning: boolean,
): DraftEffortProps {
  const declaration = draftEffortDeclarationOf(modelId, route)
  if (declaration === undefined) return {}
  return {
    ...(officialReasoning ? {} : { efforts: declaration.efforts }),
    ...(declaration.compat === undefined ? {} : { compat: declaration.compat }),
    ...(declaration.defaultEffort === undefined ? {} : { defaultEffort: declaration.defaultEffort }),
    ...(declaration.input === undefined ? {} : { input: declaration.input }),
  }
}

/** The two official capacity inputs, in the host's parseable plain-number form. */
export interface DraftCapacity {
  contextWindow: string
  maxTokens: string
}

/**
 * The capacity to show for one model row, or undefined when the row must stay
 * untouched. Both inputs have to be empty: one already filled is either a
 * candidate disclosure or a user decision, and neither may be overwritten.
 * Entries without a maximum output are left alone for the same reason the
 * saved-row autofill skips them -- the window cannot be derived without it.
 */
export function draftCapacityOf(
  modelId: string,
  contextWindowValue: string,
  maxTokensValue: string,
): DraftCapacity | undefined {
  if (contextWindowValue.trim().length > 0 || maxTokensValue.trim().length > 0) return undefined
  const entry = matchKnowledgeBase(modelId)
  if (entry?.contextWindow === undefined || entry.maxTokens === undefined) return undefined
  const capacity = capacityFillOf(entry.contextWindow, entry.maxTokens)
  return {
    contextWindow: String(capacity.contextWindow),
    maxTokens: String(capacity.maxTokens),
  }
}
