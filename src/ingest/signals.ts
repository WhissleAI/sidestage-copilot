// Normalising Whissle live-signal distributions.
//
// The gateway sends emotion and intent as DISTRIBUTIONS on the live-signal
// stream (docs/live-signal-stream.md §4.5), wrapped in an RTVI `server-message`
// envelope:
//
//   { label:"rtvi-ai", type:"server-message",
//     data:{ kind:"signal", type:"emotion",
//            data:{ top_k:[{label,p}…], top_label, top_p, changed, prev_label,
//                   held_ms, flips, trusted } } }
//
// Two things this module exists to get right:
//
//  * Labels arrive SCREAMING_SNAKE and namespaced ("EMOTION_NEUTRAL"). An
//    operator reading a live console should see "neutral".
//  * A bare label must never be synthesised into a fake distribution. If only a
//    label arrives, it becomes a one-entry top_k with its own probability, and
//    `trusted` carries through — so the UI can show that it is thin.

import type { SignalDistribution } from "../domain/types.js";

type Raw = Record<string, unknown> | string | null | undefined;

/** "EMOTION_NEUTRAL" -> "neutral"; "INTENT_QUESTION" -> "question". */
export function prettyLabel(raw: string): string {
  return String(raw || "")
    .replace(/^(EMOTION|INTENT|SENTIMENT)_/i, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .trim();
}

export function normalizeDistribution(raw: Raw): SignalDistribution | null {
  if (!raw) return null;

  // A bare label is honest but thin: keep it, do not dress it up.
  if (typeof raw === "string") {
    const label = prettyLabel(raw);
    return label
      ? { topLabel: label, topP: 0, topK: [{ label, p: 0 }], changed: false, prevLabel: null, heldMs: null, flips: null, trusted: false }
      : null;
  }

  const o = raw as Record<string, unknown>;
  // Unwrap one level when the caller handed us the whole signal event.
  const d = (o.data && typeof o.data === "object" ? (o.data as Record<string, unknown>) : o);

  const topKRaw = Array.isArray(d.top_k) ? d.top_k : Array.isArray(d.topK) ? d.topK : [];
  const topK = topKRaw
    .map((e) => e as { label?: unknown; p?: unknown })
    .filter((e) => typeof e.label === "string")
    .map((e) => ({ label: prettyLabel(String(e.label)), p: typeof e.p === "number" ? e.p : 0 }))
    .sort((a, b) => b.p - a.p);

  const topLabel = prettyLabel(String(d.top_label ?? d.topLabel ?? d.label ?? topK[0]?.label ?? ""));
  if (!topLabel) return null;

  const topP = typeof d.top_p === "number" ? d.top_p
    : typeof d.topP === "number" ? d.topP
    : typeof d.p === "number" ? d.p
    : topK.find((k) => k.label === topLabel)?.p ?? 0;

  return {
    topLabel,
    topP,
    topK: topK.length ? topK : [{ label: topLabel, p: topP }],
    changed: d.changed === true,
    prevLabel: typeof d.prev_label === "string" ? prettyLabel(d.prev_label) : null,
    heldMs: typeof d.held_ms === "number" ? d.held_ms : null,
    flips: typeof d.flips === "number" ? d.flips : null,
    trusted: d.trusted !== false,
  };
}
