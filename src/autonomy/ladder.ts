// The copilot-to-automation ladder.
//
// The product thesis (docs/PRD.md §5) is that a seller does not adopt automation
// by being told it is safe — they adopt it one rung at a time, after watching the
// rung below behave. So autonomy is not a boolean: it is five explicit levels,
// each with a promotion criterion the seller can check against their own
// numbers before climbing.
//
// Those criteria used to live only in this comment, which meant the ladder's
// central claim — that autonomy is EARNED against your own numbers rather than
// toggled — was a claim about a document. They are computed now, from finished
// shows, in `promotion.ts` and served at `GET /api/autonomy/readiness`.
//
//   L0 OBSERVE     classify chat, propose nothing. The baseline for measuring
//                  how much a show actually asks.
//   L1 SUGGEST     draft everything, send nothing. Promote when the seller's
//                  edit rate on drafts is under 20% over 3 shows.
//   L2 ONE_TAP     drafts are pre-approved for a single keystroke. Promote when
//                  the guardrail block rate is under 2% and no blocked reply was
//                  sent unedited over 3 shows.
//   L3 AUTO_REPLY  replies in ALLOW-LISTED intents that pass every guardrail and
//                  clear the confidence floor send themselves. Promote when L3's
//                  auto-sent replies show zero buyer corrections over 5 shows.
//   L4 AUTO_ACT    bounded writes (stock fixes, markdowns above the seller's
//                  floor) execute themselves inside the undo window.
//
// Two rules hold at every rung and are not configurable:
//   • A guardrail `block` NEVER auto-sends. The ladder can only ever act on a
//     draft the guards already allowed.
//   • Auto-acting is restricted to action kinds whose preflight is fully
//     decidable from catalog state. Anything needing judgement stays with the seller.

import type { ActionKind, AutonomyLevel, ChatIntent, Verdict } from "../domain/types.js";

/** Intents whose answers are pure policy or pure catalog lookup — the ones a
 *  deterministic guard can fully verify. Price and discount are deliberately NOT
 *  here: they move during a show and are where a wrong answer costs real money. */
export const AUTO_REPLY_INTENTS: ReadonlySet<ChatIntent> = new Set<ChatIntent>([
  "shipping", "returns", "sizing", "authenticity", "availability",
]);

/** Action kinds safe to execute without a human, given preflight passed. */
export const AUTO_ACT_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "adjust_stock", "markdown_price",
]);

/** Confidence floor for anything that sends itself. */
export const AUTO_CONFIDENCE_FLOOR = 0.8;

export const LADDER: AutonomyLevel[] = [
  "L0_OBSERVE", "L1_SUGGEST", "L2_ONE_TAP", "L3_AUTO_REPLY", "L4_AUTO_ACT",
];

export const rung = (l: AutonomyLevel): number => LADDER.indexOf(l);

export type ReplyDisposition =
  | { kind: "drop"; why: string }
  | { kind: "suggest" }
  | { kind: "needs_review"; why: string }
  | { kind: "blocked"; why: string }
  | { kind: "auto_send" };

export interface ReplyDecisionInput {
  level: AutonomyLevel;
  intent: ChatIntent | null;
  verdict: Verdict;
  confidence: number;
  abstained: boolean;
}

/** What happens to a drafted reply at the current rung. */
export function decideReply(i: ReplyDecisionInput): ReplyDisposition {
  if (i.level === "L0_OBSERVE") return { kind: "drop", why: "autonomy is L0 — observing only" };

  // Hard floor, at every rung: a blocked draft is never sendable without a human.
  if (i.verdict === "block") return { kind: "blocked", why: "a guardrail blocked this draft" };
  if (i.abstained) return { kind: "needs_review", why: "retrieval found no confident grounding" };
  if (i.verdict === "revise") return { kind: "needs_review", why: "a guardrail asked for a revision" };

  if (rung(i.level) >= rung("L3_AUTO_REPLY")) {
    if (!i.intent || !AUTO_REPLY_INTENTS.has(i.intent)) {
      return { kind: "needs_review", why: `intent "${i.intent ?? "unknown"}" is outside the auto-reply allow-list` };
    }
    if (i.confidence < AUTO_CONFIDENCE_FLOOR) {
      return { kind: "needs_review", why: `confidence ${i.confidence} is below the ${AUTO_CONFIDENCE_FLOOR} auto floor` };
    }
    return { kind: "auto_send" };
  }

  return { kind: "suggest" };
}

export type ActionDisposition =
  | { kind: "propose_only"; why: string }
  | { kind: "auto_commit" };

/** Whether a proposed action executes itself at the current rung. */
export function decideAction(level: AutonomyLevel, kind: ActionKind, preflightOk: boolean): ActionDisposition {
  if (!preflightOk) return { kind: "propose_only", why: "preflight did not pass" };
  if (rung(level) < rung("L4_AUTO_ACT")) return { kind: "propose_only", why: "autonomy is below L4" };
  if (!AUTO_ACT_KINDS.has(kind)) return { kind: "propose_only", why: `${kind} always needs a human` };
  return { kind: "auto_commit" };
}

export const LADDER_LABELS: Record<AutonomyLevel, string> = {
  L0_OBSERVE: "Observe — classify chat, suggest nothing",
  L1_SUGGEST: "Suggest — draft every reply, you send them",
  L2_ONE_TAP: "One-tap — drafts pre-approved for a single keystroke",
  L3_AUTO_REPLY: "Auto-reply — allow-listed intents that pass every guardrail send themselves",
  L4_AUTO_ACT: "Auto-act — bounded writes execute themselves, inside the undo window",
};
