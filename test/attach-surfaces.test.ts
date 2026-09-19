/**
 * Attach reads the surface, not just eBay.
 *
 * Every adapter in this build could RESOLVE its own links from the day it
 * landed, and none of them could be attached to: the route still read the
 * pasted string with eBay's own `parseEventId`, so a perfectly good Whatnot
 * link came back "could not read an eBay Live event id out of …". Four
 * workstreams each ended their report with the same sentence — "not wired to
 * HTTP yet". This is the door, and these are its rules.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

// Its OWN catalogs directory, set before anything reads the variable.
//
// `pretest` seeds `.tmp/test-catalogs` once, and the runner then runs test
// FILES concurrently: several of them boot an app that WRITES into that
// directory while others read a seeded catalog back. Adding a fifth writer is
// what tipped it — two unrelated suites started failing with a 404 for a
// catalog that exists. Removing this line reproduces it.
process.env.CATALOGS_DIR = ".tmp/test-catalogs-attach";

const { buildApp } = await import("../src/api/server.js");
type AppContext = Awaited<ReturnType<typeof buildApp>>["ctx"];

let app: FastifyInstance;
let ctx: AppContext;
let auth: Record<string, string>;

before(async () => {
  ({ app, ctx } = await buildApp());
  const seller = (
    await app.inject({
      method: "POST", url: "/api/auth/register",
      headers: { "content-type": "application/json" },
      payload: {
        email: `attach${Date.now()}${Math.random().toString(16).slice(2)}@test.local`,
        password: "password-123", displayName: "attach-suite",
      },
    })
  ).json();
  auth = { authorization: `Bearer ${seller.token}` };
});

after(async () => {
  await app.close();
  await ctx.stop();
});

const attach = (url: string) =>
  app.inject({
    method: "POST", url: "/api/shows/attach",
    headers: { ...auth, "content-type": "application/json" },
    payload: { url },
  });

describe("the attach door", () => {
  test("a string no adapter recognises is refused WITH what we do read", async () => {
    const r = await attach("https://example.com/not-a-show");
    assert.equal(r.statusCode, 400);
    const body = r.json();
    assert.match(body.error, /nothing recognises/);
    // Names the surfaces rather than leaving the operator to guess, and never
    // offers the follow-up inbox, which is not a thing anyone attaches to.
    assert.ok(Array.isArray(body.accepted) && body.accepted.length >= 3);
    assert.equal(body.accepted.some((a: { surface: string }) => a.surface === "dm"), false);
  });

  test("the follow-up inbox is refused as not-attachable, not as unrecognised", async () => {
    const r = await attach("show:ebay_whatever");
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, "not-attachable");
    assert.equal(r.json().surface, "dm");
  });

  test("a non-eBay surface is not asked for a preparation it cannot have, and says which key it wants", async () => {
    // Preparing reads the seller's own listings through an eBay API no other
    // surface gives us, so demanding one on Twitch would demand a door that
    // does not exist. Twitch is the right surface to assert it on: with no
    // keys in the test environment its `open()` refuses immediately and by
    // name, so this proves BOTH rules without starting a browser. (It was
    // written against Whatnot first, which really did launch Chrome inside the
    // suite and raced every other file that shares the catalogs directory.)
    const r = await attach("twitch:kicksbyrae");
    assert.notEqual(r.json()?.code, "prepare-first");
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, "surface-unavailable");
    assert.equal(r.json().surface, "twitch");
    assert.match(String(r.json().missing ?? r.json().error), /TWITCH_/);
  });

  test("eBay Live keeps the prepare-first gate it has had since 2026-09-15", async () => {
    const r = await attach("https://www.ebay.com/ebaylive/events/ZZZZZZZZZZZZZZZZ");
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, "prepare-first");
  });

  test("what the listing offers and what the door accepts are the same set", async () => {
    // A paste box that offers a surface the attach route then refuses is worse
    // than either answer alone, so both read one `isAttachable`.
    const listed = (await app.inject({ method: "GET", url: "/api/surfaces", headers: auth })).json();
    const offered = listed.surfaces.filter((s: { attachable: boolean }) => s.attachable).map((s: { id: string }) => s.id);
    assert.ok(offered.includes("ebaylive"));
    assert.equal(offered.includes("dm"), false);
    const refused = await attach("show:ebay_whatever");
    assert.equal(refused.json().surface, "dm");
  });
});
