// Retrieval must not ground a reply on a catalog it can prove is out of date.
//
// A live show abstained on all thirteen of its questions against 53 good lots
// — "do you have any spiders?" with a Labradorite Spider in the lineup. Run
// against a Retriever built over those same rows, every one of them answers.
// So the index at question time did not hold what the database held.
//
// Every write path is supposed to rebuild. One of them forgetting is invisible:
// retrieval finds nothing, the copilot abstains, and the catalog looks empty
// from the only place anyone would look. This makes that self-correcting.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Retriever } from "../src/retrieval/retriever.js";
import { listingEpochOf } from "../src/domain/repo.js";
import { rig, cleanup, type Rig } from "./helpers.js";

let r: Rig;
before(async () => { r = await rig(); });
after(async () => { await cleanup(); });

describe("a retriever knows when its index is behind", () => {
  test("a fresh rebuild is not stale", async () => {
    const ret = new Retriever(r.repo);
    await ret.rebuild();
    assert.equal(ret.stale, false);
  });

  test("a listing write makes it stale, whoever wrote it", async () => {
    const ret = new Retriever(r.repo);
    await ret.rebuild();
    const before = listingEpochOf(r.repo.showId);

    // Straight through the repo, with no refresh — the shape of the bug.
    const [lot] = await r.repo.listings();
    await r.repo.mutateListing(lot!.id, { priceCents: lot!.priceCents + 100 });

    assert.ok(listingEpochOf(r.repo.showId) > before, "the write was counted");
    assert.equal(ret.stale, true, "and the index knows it is behind");
  });

  test("rebuilding clears it", async () => {
    const ret = new Retriever(r.repo);
    await ret.rebuild();
    assert.equal(ret.stale, false);
  });

  test("a read does not make it stale", async () => {
    // Only INSERT/UPDATE/DELETE on listings counts; a SELECT must not force a
    // rebuild on every draft.
    const ret = new Retriever(r.repo);
    await ret.rebuild();
    await r.repo.listings();
    await r.repo.pinned();
    assert.equal(ret.stale, false);
  });

  test("two Retrievers over the same show agree", async () => {
    // The count is keyed by show, not by instance, because `bind()` makes a
    // second Repo for every transaction — a per-instance counter would lose
    // exactly the writes inside a two-phase commit.
    const a = new Retriever(r.repo);
    const b = new Retriever(r.repo);
    await a.rebuild();
    await b.rebuild();
    const [lot] = await r.repo.listings();
    await r.repo.mutateListing(lot!.id, { priceCents: lot!.priceCents + 1 });
    assert.equal(a.stale, true);
    assert.equal(b.stale, true);
  });
});
