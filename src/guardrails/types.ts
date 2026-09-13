import type { GuardName, GuardResult, PolicyClause, Verdict } from "../domain/types.js";
import type { Fact } from "../retrieval/facts.js";
import type { Slots } from "../retrieval/slots.js";
import type { ListingWithDescription } from "../domain/repo.js";
import type { Draft } from "../compose/composer.js";

export interface GuardInput {
  draft: Draft;
  question: string;
  /** The facts the draft was GIVEN. A citation outside this set is fabricated. */
  facts: Fact[];
  factById: Map<string, Fact>;
  /** CURRENT listing state, read fresh at guard time — not the state retrieval
   *  saw. The gap between the two is exactly what the price guard exists to catch. */
  currentListings: Map<string, ListingWithDescription>;
  slots: Slots;
  policies: PolicyClause[];
}

export interface Guard {
  readonly name: GuardName;
  run(i: GuardInput): GuardResult;
}

export const allow = (guard: GuardName): GuardResult => ({ guard, verdict: "allow" });
export const na = (guard: GuardName): GuardResult => ({ guard, verdict: "n/a" });
export const fail = (
  guard: GuardName,
  verdict: Exclude<Verdict, "allow">,
  reason: string,
  detail?: { expected?: string; found?: string },
): GuardResult => (detail ? { guard, verdict, reason, detail } : { guard, verdict, reason });

/** Split on sentence boundaries so a guard can reason about the clause a number
 *  actually appears in — "I can't do $380" must not read as "I can do $380". */
export function sentences(s: string): string[] {
  return s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
}
