// The number the auto-send gate thresholds on could not see an empty answer.
//
// Found on a simulated show, in the live console:
//
//   "how much for the chicago 1s"
//   -> "The host will cover that shortly, dre_23."
//      claims 0 · groundless false · confidence 0.82 · verdict allow
//
// Retrieval returned good facts. The draft used none of them. Confidence was
// computed as 0.45 + 0.5 * evidenceQuality — the quality of what retrieval
// FOUND — and never asked what the reply did with it, so it reported 0.82
// against an `AUTO_CONFIDENCE_FLOOR` of 0.80.
//
// The gate exists to keep a bad answer from reaching a buyer unreviewed. It
// was reading the evidence's score, which was excellent, on a reply that said
// nothing.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { confidenceOf, runChain } from "../src/guardrails/chain.js";
import { AUTO_CONFIDENCE_FLOOR, decideReply } from "../src/autonomy/ladder.js";
import type { GuardInput } from "../src/guardrails/types.js";

const input = (answer: string, claims: GuardInput["draft"]["claims"]): GuardInput => ({
  draft: { answer, claims, parsedOk: true },
  question: "is shipping free on the chicagos",
  asker: "dre_23",
  facts: [],
  factById: new Map(),
  currentListings: new Map(),
  slots: {},
  policies: [],
  surface: { delivery: "api", communityRules: false, sponsor: false },
} as unknown as GuardInput);

// Excellent retrieval — the case that produced 0.82.
const GOOD = { evidenceQuality: 0.74, abstained: false };

describe("confidence counts what the reply used", () => {
  test("a draft that cites nothing cannot clear the auto floor", () => {
    const c = runChain(input("The host will cover that shortly, dre_23.", []), GOOD).confidence;
    assert.ok(c < AUTO_CONFIDENCE_FLOOR, `${c} still clears the ${AUTO_CONFIDENCE_FLOOR} floor`);
  });

  // Straight at the function, because a fixture rich enough for all eight
  // guards to pass would be testing the fixture.
  test("with nothing tripped, citing beats not citing over the same evidence", () => {
    const clean: never[] = [];
    const cited = confidenceOf(clean, GOOD, 2);
    const uncited = confidenceOf(clean, GOOD, 0);
    assert.equal(cited, 0.82, "the number the console showed, for a reply that earns it");
    assert.ok(uncited < AUTO_CONFIDENCE_FLOOR, `${uncited} must sit under the floor`);
    assert.ok(uncited < cited);
  });

  test("the cap binds only when it is lower — weak evidence is not promoted", () => {
    const weak = { evidenceQuality: 0, abstained: false };
    const uncited = confidenceOf([], weak, 0);
    assert.ok(uncited <= 0.35, `${uncited}`);
    assert.ok(uncited <= confidenceOf([], weak, 1), "capping must never raise a score");
  });

  test("an abstention still reports its own number", () => {
    assert.equal(confidenceOf([], { evidenceQuality: 0, abstained: true }, 0), 0.1);
  });

  test("the ladder refuses to auto-send it, on an allow-listed intent", () => {
    // `returns` IS on the auto-reply allow-list, so the confidence gate is the
    // only thing standing between an empty answer and a buyer.
    const c = runChain(input("The host will cover that shortly.", []), GOOD).confidence;
    const d = decideReply({
      level: "L3_AUTO_REPLY", intent: "returns", verdict: "allow",
      confidence: c, abstained: false, delivery: "api",
    });
    assert.notEqual(d.kind, "auto_send", JSON.stringify(d));
  });
});
