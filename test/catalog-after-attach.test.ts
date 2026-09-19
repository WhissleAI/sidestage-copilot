/**
 * A catalog applied AFTER attach — which is the only sequence a real show has.
 *
 * The seeded demo show is built catalog-first: `seed()` writes the listings and
 * only then is a runtime constructed over them. Every action test in this suite
 * runs on that show, so the write path was only ever exercised against a
 * marketplace mirror that happened to be seeded before it was used.
 *
 * A real show is the other way round. Attach opens an empty show, the catalog is
 * imported afterwards (`POST /api/shows/:id/catalog/apply`, and the same step
 * inside attach), and live lots are discovered later still. Both tests here run
 * that order.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

// The shared test catalogs directory is READ here and never written, so this
// file needs no private copy of it (see attach-surfaces.test.ts for why the
// writers do).
import { db, migrate, closeDb } from "../src/db/pg.js";
import { ShowRuntime } from "../src/shows/runtime.js";
import { applyCatalog, getCatalog } from "../src/shows/catalogs.js";

const { buildApp } = await import("../src/api/server.js");

const created: string[] = [];
const silent = { emit: () => {} };

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
let auth: Record<string, string>;
let accountId: string;

before(async () => {
  ({ app, ctx } = await buildApp());
  const seller = (
    await app.inject({
      method: "POST", url: "/api/auth/register",
      headers: { "content-type": "application/json" },
      payload: {
        email: `after-attach${Date.now()}${Math.random().toString(16).slice(2)}@test.local`,
        password: "password-123", displayName: "after-attach suite",
      },
    })
  ).json();
  auth = { authorization: `Bearer ${seller.token}` };
  accountId = seller.account.id;
});

after(async () => {
  await app.close();
  await ctx.stop();
  const d = db();
  for (const id of created.splice(0)) {
    await d.query("DELETE FROM shows WHERE id = $1", [id]).catch(() => {});
  }
  await closeDb();
});

async function emptyShow(): Promise<ShowRuntime> {
  await migrate(db());
  const showId = `test_after_${process.pid.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  created.push(showId);
  const rt = new ShowRuntime({
    showId,
    title: "eBay Live — after attach",
    sellerHandle: "@kicksbyrae",
    source: "ebaylive",
    externalId: showId,
    readOnly: false,
    events: silent,
  });
  await rt.init();
  return rt;
}

test("a lot imported after attach can be marked down — the mirror is re-seeded, not seeded once", async () => {
  const rt = await emptyShow();
  // Attach really does start here: nothing to sell, nothing to mirror.
  assert.equal((await rt.repo.listings()).length, 0, "a freshly attached show has no listings");

  const catalog = getCatalog("kicksbyrae");
  assert.ok(catalog, "the seeded test catalog must exist");
  await applyCatalog(rt.repo, catalog);
  // What the catalog/apply route and the attach route both do next.
  await rt.refreshIndex();

  const lot = (await rt.repo.listings()).find((l) => l.state === "live" && l.priceCents > l.floorPriceCents);
  assert.ok(lot, "the catalog must contain a live lot with room above its floor");

  // A shallow markdown: above the floor, above cost, inside the discount cap.
  const next = Math.max(lot.floorPriceCents, lot.costCents + 100, Math.round(lot.priceCents * 0.97));
  assert.ok(next < lot.priceCents, "the test markdown must actually be a markdown");

  const a = await rt.executor.propose("markdown_price", lot.id, { newPriceCents: next }, `Mark down ${lot.title}`, "regression");
  assert.equal(a.preflight.ok, true, JSON.stringify(a.preflight.checks));

  // Before the fix this failed with "listing lst_… does not exist remotely":
  // the mirror was seeded once, in `init()`, from a show that had no lots yet.
  const committed = await rt.executor.approve(a.id);
  assert.equal(committed.status, "committed", committed.error ?? "");
  assert.equal((await rt.repo.listing(lot.id))!.priceCents, next);
  assert.equal(rt.market.snapshot(lot.id)!.priceCents, next, "the marketplace mirror must agree");

  await rt.close();
});

test("a lot the show OBSERVES mid-session is mirrored too", async () => {
  const rt = await emptyShow();
  // What `upsertObservedLot` does when a live lot hits the screen: a listing
  // appears that no catalog import ever wrote.
  const { listing } = await rt.repo.upsertObservedLot({
    title: "Lot 12 — Air Jordan 1 Chicago",
    priceCents: 22000,
    soldOut: false,
    highBidder: null,
  });
  await rt.refreshIndex();

  const mirrored = rt.market.snapshot(listing.id);
  assert.ok(mirrored, "an observed lot must exist in the marketplace mirror before anyone can act on it");
  assert.equal(mirrored.version, listing.version, "the mirror is seeded at the version the catalog holds now");

  await rt.close();
});

test("swapping the catalog mid-show answers with what landed, and indexes it after it lands", async () => {
  // A show already on air, the way the console has one: attached first, with
  // no catalog behind it yet.
  const external = `swap${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const rt = await ctx.shows.attach(`simulated:${external}`, { ownerAccountId: accountId });
  created.push(rt.showId);

  const r = await app.inject({
    method: "POST", url: `/api/shows/${rt.showId}/catalog/apply`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { catalogId: "kicksbyrae" },
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();

  // Before the fix `applyCatalog` was assigned UNAWAITED, so the response
  // spread a pending promise — `{}` — and the rebuild on the next line ran
  // over the catalog the seller had just replaced.
  assert.equal(typeof body.total, "number", `the apply response must carry counts: ${JSON.stringify(body)}`);
  assert.ok(body.total > 0, "a catalog that imported nothing is not an applied catalog");
  assert.equal(body.catalogId, "kicksbyrae");
  assert.ok(body.comps > 0, "the comparables in the file must land, not be swallowed by a failed insert");

  // And the import is finished by the time the index is built over it: every
  // imported lot is retrievable straight after the response.
  const listings = await rt.repo.listings();
  assert.equal(listings.length, body.total);
  const lot = listings[0]!;
  assert.ok(
    rt.retriever.retrieve(lot.title, { pinnedId: null }).facts.length > 0,
    "the retriever must be built over the catalog that just landed",
  );
});
