import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { claimGroundingGuard } from "../src/guardrails/guards.js";
import type { GuardInput } from "../src/guardrails/types.js";
import { capabilitiesOf } from "../src/surfaces/types.js";

// A deferral that addresses the buyer by name.
//
// Observed live on eBay Live: three replies in a row, all of them "the host
// will get to that shortly", and the two that named the asker were flagged for
// citing no grounding fact while the one that did not name anybody passed.
// The difference was not the assertion — there was none in any of them. It was
// that `dw2ks` and `jgomez1331` contain digits, and the checkability test fires
// on any digit. Marketplace handles nearly always carry one, so the guard was
// wrong about most personally-addressed replies on the surface we demo.

const input = (answer: string, asker?: string): GuardInput => ({
  draft: { answer, claims: [], parsedOk: true, raw: answer },
  question: "aftermarket dial?",
  ...(asker ? { asker } : {}),
  facts: [],
  factById: new Map(),
  currentListings: new Map(),
  slots: { listingIds: [], viaAnaphora: false } as unknown as GuardInput["slots"],
  policies: [],
  surface: capabilitiesOf("ebaylive"),
  community: [],
});

describe("claim grounding: the asker's handle is address, not a claim", () => {
  test("a deferral passes uncited whether or not it names the asker", () => {
    assert.equal(
      claimGroundingGuard.run(input("The host will get to that shortly.")).verdict,
      "allow",
    );
    assert.equal(
      claimGroundingGuard.run(
        input("dw2ks, the host will cover the aftermarket dial question shortly.", "dw2ks"),
      ).verdict,
      "allow",
      "a digit in the buyer's handle must not make a deferral look checkable",
    );
    assert.equal(
      claimGroundingGuard.run(
        input("Thanks for the shout-out, jgomez1331! The host will get to it shortly.", "jgomez1331"),
      ).verdict,
      "allow",
    );
  });

  test("an @handle is stripped even when we were not told who asked", () => {
    assert.equal(
      claimGroundingGuard.run(input("@dw2ks the host will get to that shortly.")).verdict,
      "allow",
    );
  });

  test("a real figure still needs a citation, handle or no handle", () => {
    assert.equal(
      claimGroundingGuard.run(input("dw2ks, that one is $380 shipped.", "dw2ks")).verdict,
      "revise",
      "stripping the vocative must not strip the price",
    );
    assert.equal(
      claimGroundingGuard.run(input("dw2ks, we ship free and returns are 30 days.", "dw2ks")).verdict,
      "revise",
    );
  });
});
