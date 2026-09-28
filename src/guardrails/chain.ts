// The chain. Runs every guard, always, and aggregates.
//
// Every guard runs even after one has already blocked. That costs microseconds
// and buys two things: the operator sees the COMPLETE picture of what is wrong
// with a draft rather than just the first problem, and the guardrail eval can
// measure each guard's precision independently instead of only the first to fire.

import type { GuardName, GuardResult, Verdict } from "../domain/types.js";
import { GUARDS, MODEL_ONLY_GUARDS } from "./guards.js";
import { na, type GuardInput } from "./types.js";

export interface ChainResult {
  guards: GuardResult[];
  verdict: Verdict;
  /** Guard failures, shaped for the composer's repair pass. */
  failures: { guard: string; reason: string }[];
  confidence: number;
}

export interface ChainOptions {
  evidenceQuality?: number;
  abstained?: boolean;
  /**
   * WHO wrote the words being checked.
   *
   * `model` (the default) is a draft this system composed, and every guard
   * applies — including the ones that check the machine's own citation
   * discipline. `human` is text the operator typed: they are asserting it
   * themselves, not citing our evidence set, so a guard whose entire subject is
   * "did the model cite a fact id it was actually given" has nothing to say
   * about it and reports `n/a` rather than a failure. See MODEL_ONLY_GUARDS.
   *
   * Everything that protects the BUYER or the ROOM — price, availability,
   * policy, PII, tone, community rules, sponsor obligations — runs either way.
   * An operator can be wrong about the price too.
   */
  authoredBy?: "model" | "human";
}

export function runChain(i: GuardInput, opts: ChainOptions = {}): ChainResult {
  const human = opts.authoredBy === "human";
  const guards: GuardResult[] = GUARDS.map((g) => {
    if (human && MODEL_ONLY_GUARDS.has(g.name)) return na(g.name);
    try {
      return g.run(i);
    } catch (e) {
      // A guard that throws must fail CLOSED. A crashing safety check that
      // silently passes is worse than having no check at all.
      return { guard: g.name, verdict: "block", reason: `guard error: ${(e as Error).message}` } as GuardResult;
    }
  });

  const blocked = guards.filter((g) => g.verdict === "block");
  const revise = guards.filter((g) => g.verdict === "revise");
  // Three verdicts, three different consequences, and they are not
  // interchangeable. `block` is a reply that must not reach the buyer without a
  // human rewriting it. `revise` is a draft that is WRONG IN ITS WORDING, not in
  // its substance — an emoji, a 401st character, a claim that cites nothing —
  // and it earns exactly one composer repair pass (pipeline.ts), after which it
  // reaches the seller as `needs_review`: sendable, editable, regeneratable.
  //
  // Collapsing `revise` into `block` gives the three softest checks in the file
  // the same force as the PII guard, disables the repair pass, and leaves a
  // correct reply with an emoji in it unusable. Each guard's own result still
  // reports its own verdict either way, so the pills and the audit entry name
  // which check asked for what.
  const verdict: Verdict = blocked.length ? "block" : revise.length ? "revise" : "allow";

  const failures = [...blocked, ...revise].map((g) => ({ guard: g.guard, reason: g.reason || "failed" }));

  return { guards, verdict, failures, confidence: confidenceOf(guards, opts, i.draft.claims.length) };
}

/** A reply that cited nothing cannot be trusted at the evidence's confidence.
 *  Low enough to sit under `AUTO_CONFIDENCE_FLOOR` with room to spare, high
 *  enough to stay distinct from an abstention's 0.1. */
const UNCITED_CEILING = 0.35;

/**
 * Confidence is a reported quantity, not a model output. It falls out of how
 * good the grounding was, whether the reply USED it, and how many checks the
 * draft tripped — so it means the same thing on every reply, and the autonomy
 * ladder can threshold on it.
 *
 * The middle clause was missing, and it is the one the ladder depends on.
 * Confidence read the quality of what RETRIEVAL found and never asked what the
 * draft did with it, so on a simulated show:
 *
 *   "how much for the chicago 1s"
 *   -> "The host will cover that shortly, dre_23."
 *      claims 0 · groundless false · confidence 0.82
 *
 * Retrieval returned good facts, the draft used none of them, and the number
 * the auto-send gate thresholds on reported 0.82 against a floor of 0.80. The
 * gate exists to stop a bad answer reaching a buyer unreviewed, and it could
 * not see that this answer was empty — it was reading the evidence's score,
 * which was excellent.
 *
 * Three states, now distinguishable:
 *   retrieval found nothing                      0.10  (abstained)
 *   retrieval found things, the reply ignored them  <= 0.35
 *   the reply cited what it was given            0.45 - 0.98
 */
export function confidenceOf(
  guards: GuardResult[],
  opts: { evidenceQuality?: number; abstained?: boolean },
  claimCount = 1,
): number {
  if (opts.abstained) return 0.1;
  let c = 0.45 + 0.5 * clamp01(opts.evidenceQuality ?? 0.5);
  // Applied before the guard penalties, so a draft that both cites nothing and
  // trips a check still scores below one that only does the first.
  if (claimCount === 0) c = Math.min(c, UNCITED_CEILING);
  for (const g of guards) {
    if (g.verdict === "block") c -= 0.6;
    else if (g.verdict === "revise") c -= 0.22;
  }
  return Number(clamp(c, 0.03, 0.98).toFixed(2));
}

const clamp01 = (x: number) => clamp(x, 0, 1);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export const emptyGuardBlocks = (): Record<GuardName, number> => ({
  price: 0, availability: 0, policy: 0, claim_grounding: 0, tone: 0, pii: 0,
  community_rule: 0, sponsor: 0,
});
