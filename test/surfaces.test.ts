import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { all, get, register, resolve } from "../src/surfaces/registry.js";
import { capabilitiesOf, hasCorpus, SurfaceUnavailable, type SurfaceAdapter } from "../src/surfaces/types.js";
import { parseEventId } from "../src/ingest/ebaylive/discovery.js";

// One box, any surface. The console's paste field used to hand its contents
// straight to `parseEventId`, so the only two outcomes were "an eBay Live show"
// and "an error" — which is why adding a second surface would otherwise have
// meant adding a second box.

describe("the surface registry", () => {
  test("an eBay Live link and a bare event id both resolve to the eBay adapter", () => {
    const byUrl = resolve("https://www.ebay.com/ebaylive/events/47tK1SX0VsiHEXN1/player.html");
    assert.equal(byUrl?.adapter.id, "ebaylive");
    assert.equal(byUrl?.target.externalId, "47tK1SX0VsiHEXN1");

    const byId = resolve("47tK1SX0VsiHEXN1");
    assert.equal(byId?.adapter.id, "ebaylive");
    assert.equal(byId?.target.externalId, "47tK1SX0VsiHEXN1");
  });

  test("the eBay adapter parses exactly what the attach route has always parsed", () => {
    // The adapter must not become a second, subtly different opinion about
    // what an eBay link is: a show that attached yesterday has to resolve to
    // the same event id today.
    const inputs = [
      "47tK1SX0VsiHEXN1",
      "https://www.ebay.com/ebaylive/events/47tK1SX0VsiHEXN1",
      "www.ebay.com/ebaylive/events/abcdefghij/player.html",
      "not a show",
      "",
    ];
    for (const i of inputs) {
      assert.equal(get("ebaylive")!.parseTarget(i)?.externalId ?? null, parseEventId(i), i || "(empty)");
    }
  });

  test("the scripted show is reachable by name, and nothing else is", () => {
    assert.equal(resolve("simulated")?.adapter.id, "simulated");
    assert.equal(resolve("demo")?.adapter.id, "simulated");
    // Narrow on purpose: a looser pattern would swallow a mistyped real link
    // and hand the operator a fake show, which is the empty state this product
    // spent a release getting rid of.
    assert.equal(resolve("simulate my show"), null);
    assert.equal(resolve("https://reddit.com/r/mechmarket/comments/abc"), null);
    assert.equal(resolve("   "), null);
  });

  test("eBay Live is tried first, so nothing can steal a link that is its", () => {
    assert.equal(all()[0]!.id, "ebaylive");
  });

  test("registering an adapter makes it resolvable, and get() finds it by id", () => {
    const fake: SurfaceAdapter = {
      id: "twitch",
      label: "Twitch",
      capabilities: capabilitiesOf("twitch"),
      parseTarget: (i) => (i.startsWith("twitch.tv/") ? { externalId: i.slice("twitch.tv/".length) } : null),
      open: async () => { throw new SurfaceUnavailable("twitch", "twitch: TWITCH_CLIENT_ID is not set", "TWITCH_CLIENT_ID"); },
    };
    register(fake);
    assert.equal(get("twitch")!.label, "Twitch");
    assert.equal(resolve("twitch.tv/someone")?.target.externalId, "someone");
    // An eBay link still goes to eBay, registration order intact.
    assert.equal(resolve("47tK1SX0VsiHEXN1")?.adapter.id, "ebaylive");
  });

  test("a missing key is a typed refusal that names the variable, not a 500", async () => {
    await assert.rejects(
      () => get("twitch")!.open({ externalId: "someone" }, {}),
      (e: unknown) => e instanceof SurfaceUnavailable && e.missing === "TWITCH_CLIENT_ID",
    );
  });
});

describe("what a surface can do", () => {
  test("eBay Live's capabilities describe eBay Live as it already behaves", () => {
    const c = capabilitiesOf("ebaylive");
    assert.equal(c.tempo, "live");
    assert.equal(c.delivery, "api");
    assert.deepEqual(c.perception, { audio: true, video: true });
    assert.ok(c.actions.includes("markdown_price"));
    assert.ok(hasCorpus(c, "listing"));
    // No per-room rule corpus exists on eBay Live, so the rule guard must be
    // n/a there — the reference surface is untouched by a guard written for
    // subreddits.
    assert.equal(c.communityRules, false);
  });

  test("a surface with no catalog behind it declares no listing corpus", () => {
    assert.equal(hasCorpus(capabilitiesOf("twitch"), "listing"), false);
    assert.equal(hasCorpus(capabilitiesOf("reddit"), "listing"), false);
    assert.equal(hasCorpus(capabilitiesOf("reddit"), "community"), true);
  });

  test("reddit is draft-only in code, where no setting can reach it", () => {
    assert.equal(capabilitiesOf("reddit").delivery, "draft-only");
    assert.equal(capabilitiesOf("reddit").tempo, "async");
  });

  test("a row written before the column existed answers as live commerce", () => {
    // Every show in the database before migration 018 was an eBay Live show or
    // the scripted one. Answering anything else for an unknown id would change
    // how guards treat those rows.
    assert.deepEqual(capabilitiesOf(null), capabilitiesOf("ebaylive"));
    assert.deepEqual(capabilitiesOf("something-we-removed"), capabilitiesOf("ebaylive"));
  });
});
