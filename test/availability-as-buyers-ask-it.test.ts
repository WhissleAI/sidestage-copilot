// Availability, in the words buyers actually use.
//
// The cue list asked how a SELLER talks — "in stock", "available", "sold" —
// and measured over the whole production corpus on 2026-09-28, 39 of 54
// questions fell into `other`. Eight were plainly availability, asked as
// possession or existence. Every string below is a real buyer question from
// that corpus.
//
// It costs more than a mislabel. `availability` is on `AUTO_REPLY_INTENTS` and
// the action proposer counts availability signals, so a question parked in
// `other` is invisible to both: it can never auto-reply, and it never
// contributes to a swap proposal. Across 14 production shows the proposer has
// fired zero times.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/ingest/classify.js";

describe("availability as buyers ask it", () => {
  for (const q of [
    "do you have any spiders?",
    "do you have any jewelry of hand spiders?",
    "Any men’s watches",
    "Any vintage?",
    "any dragons?",
    "Any monkeys? They were a great influence on the Beatles.",
    "Is there another color?",
    "is there another similar to the first one?",
  ]) {
    test(`"${q.slice(0, 44)}"`, () => {
      assert.equal(classify(q), "availability");
    });
  }

  test("a discount asked with the same opener is still a discount", () => {
    // `discount_request` is matched first, so `^any` cannot steal these.
    assert.equal(classify("any deals?"), "discount_request");
    assert.equal(classify("any bundle price"), "discount_request");
  });

  test("the seller's own vocabulary still classifies", () => {
    assert.equal(classify("is it still available"), "availability");
    assert.equal(classify("how many left"), "availability");
    assert.equal(classify("is that sold"), "availability");
  });

  test("hype that happens to start with a cue word is not a question", () => {
    assert.equal(classify("W"), "hype");
    assert.equal(classify("LETS GOOO"), "hype");
  });

  test("a bare product name is left alone, deliberately", () => {
    // "Nike Air?", "Mexican agate sphere?" are almost certainly availability
    // too, but a blanket noun-phrase rule also sweeps in "Its new?" — a
    // CONDITION question — and availability can auto-send at L3. Narrow cues
    // over a rule that guesses.
    assert.equal(classify("Nike Air?"), "other");
    assert.equal(classify("Its new?"), "other");
  });
});
