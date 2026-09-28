// Abstention is the loudest thing this system does, and it recorded only that
// it happened.
//
// A production show abstained on all thirteen of its questions against a
// catalog of 53 good lots — "do you have any spiders?" with a Labradorite
// Spider in the lineup. Nothing stored said which of the three conditions
// fired, or whether the index even held those lots. Recovering it took a copy
// of the show's rows into a local database, a Retriever built over them, and
// six hypotheses that each died on contact with evidence. The container logs
// from the window had already rotated.
//
// Four numbers, written once per draft, would have answered it in one query.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Retriever } from "../src/retrieval/retriever.js";
import { rig, cleanup, type Rig } from "./helpers.js";

let r: Rig;

describe("retrieval reports why it abstained", () => {
  test("the three conditions and the index size all come back", async () => {
    r = await rig();
    const ret = new Retriever(r.repo);
    await ret.rebuild();

    const out = ret.retrieve("what is the capital of france", { pinnedId: null });

    assert.equal(typeof out.why.structuredCount, "number");
    assert.equal(typeof out.why.bm25Top, "number");
    assert.equal(typeof out.why.indexedFacts, "number");
    assert.ok("inventoryQuery" in out.why);

    // The one that separates "we looked and found nothing" from "there was
    // nothing to look at". A seeded rig has facts; an empty index would not.
    assert.ok(out.why.indexedFacts > 0, "a seeded show has an index to search");
  });

  test("a grounded question reports a structured hit, not an abstention", async () => {
    const ret = new Retriever(r.repo);
    await ret.rebuild();
    const out = ret.retrieve("how much for the chicagos", { pinnedId: null });
    assert.equal(out.abstain, false);
    assert.ok(out.why.structuredCount > 0 || out.why.bm25Top >= 4.0);
  });

  test("the numbers are the ones the decision was actually made from", async () => {
    // Not recomputed for the report: `bm25Top` is the same value the abstain
    // expression read, or the record explains a decision that was not taken.
    const ret = new Retriever(r.repo);
    await ret.rebuild();
    const out = ret.retrieve("zzzz nonexistent gibberish token", { pinnedId: null });
    if (out.abstain) {
      assert.equal(out.why.structuredCount, 0);
      assert.ok(out.why.bm25Top < 4.0, `${out.why.bm25Top}`);
      assert.equal(out.why.inventoryQuery, null);
    }
    await cleanup();
  });
});
