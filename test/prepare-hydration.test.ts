// Preparing a show off its event id alone.
//
// A preparation's entire value is the SELLER'S LISTINGS, and the only key to
// those is the seller handle. That handle arrives on one thing: the eBay Live
// grid row this server already holds. No client has it — Discover's index
// sends an id, a title and a reason by design, and a pasted stream URL carries
// nothing at all — so every caller was sending `sellerHandle: null` and every
// preparation came back with an empty catalog and a title of "eBay Live <id>".
// The deployment's own report list has five of them, each with zero answers.
//
// So the route reads the grid itself. These tests pin the three things that
// has to keep being true: the grid wins, the body still fills what the grid
// does not know, and an event nobody has ever seen is a 400 that says so
// rather than a preparation of nothing.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";

// Its own directories, set BEFORE the app is imported: both paths are resolved
// at module load, and this suite writes into both.
const DIR = resolve(".tmp/test-prepare-hydration");
mkdirSync(DIR, { recursive: true });
process.env.CATALOGS_DIR = resolve(DIR, "catalogs");
mkdirSync(process.env.CATALOGS_DIR, { recursive: true });
// `cachedDiscovery()` refuses to hand back a grid when no session is present —
// correctly, because a signed-out server's empty grid means something else
// entirely. A file is all `sessionStatus()` looks for.
process.env.EBAY_SESSION_PATH = resolve(DIR, "ebay-session.json");
writeFileSync(process.env.EBAY_SESSION_PATH, "{}");

const { buildApp } = await import("../src/api/server.js");
const { rememberGrid } = await import("../src/sellers/following.js");

let app: FastifyInstance;
const json = { "content-type": "application/json" };
let seller: { headers: { authorization: string } };

/** One row of the grid, exactly as `discoverLiveShows` leaves it. */
const GRID_ROW = {
  eventId: "Abcd1234Efgh5678",
  title: "$1 STARTS 🔥 VINTAGE POKÉMON RIPS",
  host: "Filthy Hits",
  sellerHandle: "rcerjd-9tko",
  viewers: 198,
  url: "https://www.ebay.com/ebaylive/events/Abcd1234Efgh5678/stream",
  thumbnailUrl: "https://i.ebayimg.com/images/g/PO0/s-l960.webp",
  tags: ["Trading Cards"],
  status: "live" as const,
  startsAt: null,
};

before(async () => {
  ({ app } = await buildApp());
  await app.ready();
  const email = `prep-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
  const r = (
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: json,
      payload: { email, password: "password-123", displayName: "prep" },
    })
  ).json() as { token: string };
  seller = { headers: { authorization: `Bearer ${r.token}` } };
  rememberGrid([GRID_ROW]);
});

after(async () => {
  await app?.close();
  rmSync(DIR, { recursive: true, force: true });
});

/** Wait for the detached preparation to land, or say what it said instead. */
async function settled(eventId: string, tries = 80) {
  for (let n = 0; n < tries; n++) {
    const body = (
      await app.inject({ method: "GET", url: "/api/shows/prepared", headers: seller.headers })
    ).json() as {
      prepared: { eventId: string; title: string; host: string; sellerHandle: string | null; tags: string[]; thumbnailUrl: string | null }[];
      preparing: string[];
      failed: { eventId: string; error: string }[];
    };
    const row = body.prepared.find((p) => p.eventId === eventId);
    if (row) return row;
    const failed = body.failed.find((f) => f.eventId === eventId);
    if (failed) assert.fail(`preparation failed: ${failed.error}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`preparation of ${eventId} never landed`);
}

describe("preparing a show the server already knows about", () => {
  test("an event id alone is enough, and the seller handle comes off the grid", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/shows/prepare",
      headers: { ...seller.headers, ...json },
      payload: { eventId: GRID_ROW.eventId },
    });
    assert.equal(r.statusCode, 200, r.body);

    const row = await settled(GRID_ROW.eventId);
    // The handle is the whole point: without it `prepare()` records "the live
    // grid gave no seller handle for this show" and builds nothing.
    assert.equal(row.sellerHandle, GRID_ROW.sellerHandle);
    assert.equal(row.title, GRID_ROW.title);
    assert.equal(row.host, GRID_ROW.host);
    assert.deepEqual(row.tags, GRID_ROW.tags);
    assert.equal(row.thumbnailUrl, GRID_ROW.thumbnailUrl);
  });

  test("a placeholder title from a client never overwrites eBay's own", async () => {
    // What the paste box sent for a show it only had a link to. The grid knows
    // better, and a report headed "eBay Live Abcd1234Efgh5678" is how the old
    // behaviour showed up a week later.
    const r = await app.inject({
      method: "POST",
      url: "/api/shows/prepare",
      headers: { ...seller.headers, ...json },
      payload: {
        eventId: GRID_ROW.eventId,
        title: `eBay Live ${GRID_ROW.eventId}`,
        host: "",
        sellerHandle: null,
        tags: [],
        thumbnailUrl: null,
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    const row = await settled(GRID_ROW.eventId);
    assert.equal(row.title, GRID_ROW.title);
    assert.equal(row.sellerHandle, GRID_ROW.sellerHandle, "a null in the body does not erase it");
  });
});

describe("preparing a show the server has never seen", () => {
  test("the body still supplies everything, so a show off the grid is preparable", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/shows/prepare",
      headers: { ...seller.headers, ...json },
      payload: {
        eventId: "Zzzz9999Yyyy8888",
        title: "A show that ended before we looked",
        host: "someone",
        sellerHandle: "their-handle",
        tags: ["Coins"],
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    const row = await settled("Zzzz9999Yyyy8888");
    assert.equal(row.title, "A show that ended before we looked");
    assert.equal(row.sellerHandle, "their-handle");
    assert.deepEqual(row.tags, ["Coins"]);
  });

  test("an id with nothing behind it is refused, and says which fact is missing", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/shows/prepare",
      headers: { ...seller.headers, ...json },
      payload: { eventId: "Nope0000Nope0000" },
    });
    assert.equal(r.statusCode, 400);
    const body = r.json() as { error: string; code: string };
    assert.equal(body.code, "unknown-event");
    assert.match(body.error, /title|grid/i);
  });

  test("an empty body is still a 400 about the event id", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/shows/prepare",
      headers: { ...seller.headers, ...json },
      payload: {},
    });
    assert.equal(r.statusCode, 400);
    assert.match((r.json() as { error: string }).error, /eventId/);
  });
});
