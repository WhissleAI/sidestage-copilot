// `GET /api/discover` on an account that has never imported anything.
//
// This is the exact read the reviewer made, and what it returned was five
// sources with zero hits each under a heading promising what is live on what
// they sell. Every surface said nothing, the screen said "We do not know what
// you sell yet", and there was no way forward on the page.
//
// Discovery derives its terms from the operator's OWN catalogs and excludes
// the seeded demo ones, which is right — a demo fixture is not your inventory.
// The consequence was not: no terms meant the every-hit-has-a-why filter ran
// against an empty question and dropped everything, on all five surfaces.
//
// The route-level rule this pins: a first-run account gets what is live, and
// the answer SAYS it was not matched. Both halves, or it is a regression of
// one of the two audits this product has already had.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";

const DIR = resolve(".tmp/test-discover-first-run");
mkdirSync(DIR, { recursive: true });
process.env.CATALOGS_DIR = resolve(DIR, "catalogs");
mkdirSync(process.env.CATALOGS_DIR, { recursive: true });
process.env.EBAY_SESSION_PATH = resolve(DIR, "ebay-session.json");
writeFileSync(process.env.EBAY_SESSION_PATH, "{}");

const { buildApp } = await import("../src/api/server.js");
const { rememberGrid } = await import("../src/sellers/following.js");

let app: FastifyInstance;
let seller: { headers: { authorization: string } };
const json = { "content-type": "application/json" };

const GRID = [
  {
    eventId: "Aaaa1111Bbbb2222",
    title: "$1 STARTS 🔥 VINTAGE POKÉMON RIPS",
    host: "Filthy Hits",
    sellerHandle: "rcerjd-9tko",
    viewers: 198,
    url: "https://www.ebay.com/ebaylive/events/Aaaa1111Bbbb2222/stream",
    thumbnailUrl: null,
    tags: ["Trading Cards"],
    status: "live" as const,
    startsAt: null,
  },
  {
    eventId: "Cccc3333Dddd4444",
    title: "Authenticity Guaranteed! Coins & Currency",
    host: "Hertel's Coins",
    sellerHandle: "m4qDi73HQkO",
    viewers: 183,
    url: "https://www.ebay.com/ebaylive/events/Cccc3333Dddd4444/stream",
    thumbnailUrl: null,
    tags: ["Coins"],
    status: "live" as const,
    startsAt: null,
  },
];

interface DiscoverBody {
  interests: { slug: string }[];
  sources: {
    surface: string;
    hits: { id: string; why: { term: string }[] }[];
    unmatched: boolean;
    unavailable: { reason: string; missing: string | null } | null;
  }[];
}

const discover = async (query = "") =>
  (
    await app.inject({ method: "GET", url: `/api/discover${query}`, headers: seller.headers })
  ).json() as DiscoverBody;

before(async () => {
  ({ app } = await buildApp());
  await app.ready();
  const email = `first-run-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  const r = (
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: json,
      payload: { email, password: "password-123", displayName: "first run" },
    })
  ).json() as { token: string };
  seller = { headers: { authorization: `Bearer ${r.token}` } };
  rememberGrid(GRID);
});

after(async () => {
  await app?.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe("an account that has imported nothing", () => {
  test("derives no interests — the demo seeds are not its inventory", async () => {
    const body = await discover();
    assert.deepEqual(body.interests, [], "seeded catalogs must not become someone's interests");
  });

  test("still gets what is on air, rather than five empty surfaces", async () => {
    const body = await discover();
    const ebay = body.sources.find((s) => s.surface === "ebaylive")!;
    assert.equal(ebay.unavailable, null, "the grid is readable in this rig");
    assert.equal(ebay.hits.length, GRID.length, "the whole grid comes back");
  });

  test("and is told, in the payload, that none of it was matched", async () => {
    const body = await discover();
    const ebay = body.sources.find((s) => s.surface === "ebaylive")!;
    assert.equal(ebay.unmatched, true);
    // The rule the audits were about, unbent: a card may not carry a reason it
    // does not have. Showing the grid is fine; dressing it as a match is not.
    for (const h of ebay.hits) {
      assert.deepEqual(h.why, [], `${h.id} claims no reason`);
    }
  });

  test("every hit is actionable, so the first run has somewhere to go", async () => {
    const body = await discover();
    const ebay = body.sources.find((s) => s.surface === "ebaylive")!;
    // The id is the attach target and `POST /api/shows/prepare` takes it
    // alone. A grid of cards that cannot be pressed would be the phone book
    // this screen was right to stop being.
    for (const h of ebay.hits) {
      assert.ok(GRID.some((g) => g.eventId === h.id), `${h.id} is a real event id`);
    }
  });

  test("a surface with no key still refuses honestly, and is never hidden", async () => {
    const body = await discover();
    // Nothing about the first-run path may quietly fill a keyless surface in.
    for (const id of ["twitch", "reddit"]) {
      const s = body.sources.find((x) => x.surface === id)!;
      assert.ok(s, `${id} is listed`);
      assert.deepEqual(s.hits, [], `${id} shows nothing it does not have`);
      assert.ok(s.unavailable?.missing, `${id} names the variable that would fix it`);
    }
  });

  test("a typed query is a real question again, and the answer is matched", async () => {
    const body = await discover("?q=coins");
    const ebay = body.sources.find((s) => s.surface === "ebaylive")!;
    assert.equal(ebay.unmatched, false, "there is a question now, so the filter is back on");
    assert.equal(ebay.hits.length, 1);
    assert.equal(ebay.hits[0]!.id, "Cccc3333Dddd4444");
    assert.ok(ebay.hits[0]!.why.length, "and it says why it is there");
  });
});
