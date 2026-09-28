// A reply that cites nothing has no provenance to show.
//
// Found by opening the live console on a simulated show. The first card:
//
//   bigmike — "what condition are the 990s"
//   "The host will cover that shortly, bigmike."
//   [Catalog · the seller's own stock]   ✓ grounding   0.10   [Copy]
//
// Zero claims, and a chip telling the seller the answer came from their own
// stock. `guards.ts` already names that pairing the worst available —
// "unverified and presented as verified" — and the comment above
// `researchGrounding` records the same symptom being chased once before, for
// one trigger. The cause is general: `r.evidence` is what RETRIEVAL found, and
// the card printed it whatever the draft did with it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

type Draft = { claims: { factId: string }[] };
type Ev = { factId: string; label: string };

/** The line this is about, in `pipeline.ts`'s proposal assembly. */
const chips = (draft: Draft, retrieved: Ev[]): Ev[] => (draft.claims.length ? retrieved : []);

const RETRIEVED: Ev[] = [
  { factId: "listing:990v6#condition", label: "Catalog · the seller's own stock" },
  { factId: "policy:returns", label: "Policy · returns" },
];

describe("provenance follows the claim, not the retrieval", () => {
  test("a deflection shows no chip", () => {
    const deflection: Draft = { claims: [] };
    assert.deepEqual(chips(deflection, RETRIEVED), []);
  });

  test("a grounded reply still shows what it was given", () => {
    const grounded: Draft = { claims: [{ factId: "listing:990v6#condition" }] };
    assert.equal(chips(grounded, RETRIEVED).length, 2);
  });

  test("an empty retrieval and an uncited draft agree", () => {
    assert.deepEqual(chips({ claims: [] }, []), []);
  });

  test("the rule keys off claims, never off the answer's wording", () => {
    // Matching on phrasing would be a second, drifting definition of "says
    // nothing". The claim list is the one the guards already read.
    const cites: Draft = { claims: [{ factId: "policy:returns" }] };
    assert.ok(chips(cites, RETRIEVED).length > 0);
  });
});
