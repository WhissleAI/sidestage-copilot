// The persona's boundaries, turned into rules the guards already enforce.
//
// Nothing here is a new guard. `policyGuard` has checked every draft against
// the account's never-say rules since the first migration, on the reply path
// and again at the moment of sending; a boundary that arrived through a second
// mechanism would be a second thing to keep in step with it, and the two would
// eventually disagree about a phrase. So a boundary becomes a `NeverSayRule`
// and is merged into the policy the guard reads — which also means it is pushed
// to the agent as Layer A by the same save that arms Layer B, and holds on the
// voice and embed channels this app is not in the loop for.
//
// The asymmetry worth reading twice:
//
//   never_claim / never_discuss  are things that must NOT be in the reply.
//     A never-say rule is exactly that shape, so it becomes one and blocks.
//
//   must_disclose                is something that MUST be in the reply.
//     A never-say rule cannot express that, and the trap is that it looks like
//     it nearly can. Inverting it — "block any reply that does not contain
//     'written with AI assistance'" — blocks "yes, still available" and every
//     other correct short answer, and an operator whose copilot blocks its own
//     best replies turns the guardrail off. Worse, a block teaches the model
//     nothing: the draft is refused after it is written, with no route to a
//     version that complies. A disclosure belongs where the reply is composed,
//     so `prompts.ts` carries it as a standing requirement and the model writes
//     it in. It is a prompt requirement, not a blocker, and that is a decision
//     about where a requirement is cheapest to satisfy, not a softening of it.

import type { NeverSayRule, SellerGuardrailPolicy } from "../guardrails/policy.js";
import type { Persona } from "./store.js";

/**
 * Boundaries as never-say rules.
 *
 * Literal, never regex. An operator writing "no medical claims" into a text box
 * is typing a phrase, not a pattern, and `neverSayMatchers` escapes a literal
 * before compiling it — so a boundary containing a bracket or a plus cannot
 * throw inside the guard, and a guard that throws blocks every reply
 * (chain.ts). `settings.invalidPatterns` guards the settings form against that;
 * this file avoids needing to.
 */
export function boundaryRules(p: Persona | null): NeverSayRule[] {
  if (!p) return [];
  const rules: NeverSayRule[] = [];
  for (const phrase of p.boundaries.never_claim) {
    rules.push({ pattern: phrase, why: `${p.name || "the operator"} never claims that` });
  }
  for (const topic of p.boundaries.never_discuss) {
    rules.push({ pattern: topic, why: `${p.name || "the operator"} does not discuss ${topic}` });
  }
  return rules;
}

/**
 * The account's policy with the persona's boundaries armed in it.
 *
 * Appended rather than merged over: the seller's own never-say list and the
 * persona's boundaries are two different people's decisions about the same
 * reply (the account's settings, and the voice writing it), and both hold. A
 * duplicate phrase is harmless — the guard returns on the first match — so
 * deduping would add a case to reason about for no behaviour.
 *
 * Returns the SAME object when there is nothing to add, so an account with no
 * persona is handed the identical policy instance it would have been handed
 * before this file existed.
 */
export function withBoundaries(
  policy: SellerGuardrailPolicy,
  persona: Persona | null,
): SellerGuardrailPolicy {
  const extra = boundaryRules(persona);
  if (!extra.length) return policy;
  return { ...policy, neverSay: [...policy.neverSay, ...extra] };
}

/**
 * What the reply must say, because the persona says it always does.
 *
 * `disclosure` is the persona's standing one-liner; `must_disclose` is the list
 * of things it must cover. Both reach the prompt; neither blocks. A room's own
 * disclosure requirement is a different thing and lives on `surface_rooms`,
 * because that requirement belongs to the room rather than to the operator.
 */
export function disclosureRequirements(p: Persona | null): string[] {
  if (!p) return [];
  const out = [...p.boundaries.must_disclose];
  if (p.disclosure) out.unshift(p.disclosure);
  return out;
}
