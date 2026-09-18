// The chain. Runs every guard, always, and aggregates.
//
// Every guard runs even after one has already blocked. That costs microseconds
// and buys two things: the operator sees the COMPLETE picture of what is wrong
// with a draft rather than just the first problem, and the guardrail eval can
// measure each guard's precision independently instead of only the first to fire.

import type { GuardName, GuardResult, Verdict } from "../domain/types.js";
import { GUARDS } from "./guards.js";
import type { GuardInput } from "./types.js";

export interface ChainResult {
  guards: GuardResult[];
  verdict: Verdict;
  /** Guard failures, shaped for the composer's repair pass. */
  failures: { guard: string; reason: string }[];
  confidence: number;
}

export function runChain(i: GuardInput, opts: { evidenceQuality?: number; abstained?: boolean } = {}): ChainResult {
  const guards: GuardResult[] = GUARDS.map((g) => {
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
  // A guard that asks for a revision no longer earns the draft a repair pass:
  // the chain reports `block`, so the pipeline's `revise` branch (the single
  // composer.repair call, pipeline.ts) is never taken and the card reaches the
  // seller as held. Each guard's own result still says `revise`, so the pills
  // and the audit entry still name which check asked for what.
  const verdict: Verdict = blocked.length || revise.length ? "block" : "allow";

  const failures = [...blocked, ...revise].map((g) => ({ guard: g.guard, reason: g.reason || "failed" }));

  return { guards, verdict, failures, confidence: confidenceOf(guards, opts) };
}

/**
 * Confidence is a reported quantity, not a model output. It falls out of how
 * good the grounding was and how many checks the draft tripped — so it means
 * the same thing on every reply, and the autonomy ladder can threshold on it.
 */
function confidenceOf(
  guards: GuardResult[],
  opts: { evidenceQuality?: number; abstained?: boolean },
): number {
  if (opts.abstained) return 0.1;
  let c = 0.45 + 0.5 * clamp01(opts.evidenceQuality ?? 0.5);
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
});
