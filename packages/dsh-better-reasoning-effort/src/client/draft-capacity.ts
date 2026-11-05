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
import { matchKnowledgeBase } from '../knowledge.js'

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
