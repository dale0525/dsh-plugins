/**
 * Region recovery for a compaction backend.
 *
 * A compaction backend's `summarize(input, agent, signal)` receives only
 * `input.messages` — the derived LLM messages — and never the seq numbers of the
 * region being compacted. `agent.session` is reachable, so the region is
 * recovered by mapping each derived message's *object identity* back to the seq
 * it was derived from.
 *
 * Attribution over the region is done by RANGE (`[startSeq, endSeq]`), never by
 * membership in the region's own seq set. `tool/ptc-dispatch` is a log-only
 * event: it derives to no message, its seq interleaves with the surface nodes,
 * and it is not a member of the region's own seqs. Membership testing therefore
 * reports zero dispatches — a silent, total loss of PTC tool-call facts.
 *
 * @typedef {import('@deepseek-ai/dsh-session').Session} Session
 * @typedef {import('@deepseek-ai/dsh-session').SessionEvent} SessionEvent
 * @typedef {import('@deepseek-ai/dsh-session').Message} Message
 */

/**
 * Recover the seq region of a compaction from the messages it was handed.
 *
 * @param {Session} session - live session; `agent.session` on the backend.
 * @param {{ tools?: unknown, messages: readonly Message[] }} input - the
 *   compaction input; only `messages` is read.
 * @returns {{
 *   seqs: number[],
 *   startSeq: number | null,
 *   endSeq: number | null,
 *   own: readonly SessionEvent[],
 *   dispatchesByRoot: Map<string, SessionEvent[]>,
 * }} the region. Every field is empty / null when nothing maps.
 */
export function regionOf(session, input) {
  const messages = input?.messages ?? [];

  // 1. Map every derived message back to its seq. A message object is derived
  //    from at most one seq in practice; if one is already present, keep the
  //    first (lowest) seq because the walk is ascending.
  /** @type {Map<Message, number>} */
  const seqByMessage = new Map();
  const seqCount = session.seq;
  for (let seq = 0; seq < seqCount; seq++) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    const message = session.deriveEventMessage(event);
    if (message === null || typeof message !== 'object') continue;
    if (!seqByMessage.has(message)) seqByMessage.set(message, seq);
  }

  // 2. Resolve each input message by object identity. Unmatched messages are
  //    skipped silently — they may be synthesized or belong to another prefix.
  /** @type {Set<number>} */
  const seqSet = new Set();
  for (const message of messages) {
    const seq = seqByMessage.get(message);
    if (seq !== undefined) seqSet.add(seq);
  }

  // 3-4. Sorted, deduped seqs and their min/max bounds.
  const seqs = [...seqSet].sort((a, b) => a - b);
  if (seqs.length === 0) {
    return { seqs: [], startSeq: null, endSeq: null, own: [], dispatchesByRoot: new Map() };
  }
  const startSeq = seqs[0];
  const endSeq = seqs[seqs.length - 1];

  // 5. The region's own events: the inclusive range [startSeq, endSeq], i.e. the
  //    half-open [startSeq, endSeq + 1). This deliberately includes log-only
  //    events that carry no derived message — that is what makes PTC
  //    attribution correct.
  const own = session.snapshotEvents(startSeq, endSeq + 1);

  // 6. Group log-only PTC dispatches by their root call, preserving seq order.
  /** @type {Map<string, SessionEvent[]>} */
  const dispatchesByRoot = new Map();
  for (const event of own) {
    if (event.type !== 'tool/ptc-dispatch') continue;
    const rootCallId = event.data.rootCallId;
    const bucket = dispatchesByRoot.get(rootCallId);
    if (bucket === undefined) {
      dispatchesByRoot.set(rootCallId, [event]);
    } else {
      bucket.push(event);
    }
  }

  return { seqs, startSeq, endSeq, own, dispatchesByRoot };
}
