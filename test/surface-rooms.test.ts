import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import type { AppContext } from "../src/api/context.js";
import { db as pgPool } from "../src/db/pg.js";
import { SurfaceRooms } from "../src/surfaces/rooms.js";

// Posting into somebody else's room is irreversible in the way that matters:
// the undo window can delete the comment, it cannot unsee it. These tests are
// the switch, and the default it sits at.

let app: FastifyInstance;
let ctx: AppContext;
const json = { "content-type": "application/json" };

const register = async (tag: string) => {
  const r = (await app.inject({
    method: "POST", url: "/api/auth/register", headers: json,
    payload: { email: `${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`, password: "password-123", displayName: tag },
  })).json() as { token: string; account: { id: string } };
  return { headers: { authorization: `Bearer ${r.token}`, ...json }, id: r.account.id };
};

let A: { headers: Record<string, string>; id: string };
let B: { headers: Record<string, string>; id: string };

before(async () => {
  ({ app, ctx } = await buildApp());
  A = await register("rooms-a");
  B = await register("rooms-b");
});
after(async () => {
  for (const who of [A, B]) {
    await pgPool().query("DELETE FROM surface_rooms WHERE account_id = $1", [who.id]).catch(() => {});
  }
  await app.close();
  await ctx.stop();
});

describe("the rooms an operator watches", () => {
  test("a room starts with posting off, and says so", async () => {
    const added = await app.inject({
      method: "POST", url: "/api/surfaces/twitch/rooms", headers: A.headers,
      payload: { room: "#kicksbyrae" },
    });
    assert.equal(added.statusCode, 200);
    const body = added.json() as { room: { room: string; posting: boolean } };
    assert.equal(body.room.room, "#kicksbyrae");
    assert.equal(body.room.posting, false, "default false, everywhere, always");
  });

  test("turning posting on is a separate, explicit decision", async () => {
    const on = await app.inject({
      method: "POST", url: "/api/surfaces/twitch/rooms", headers: A.headers,
      payload: { room: "#kicksbyrae", posting: true, disclosure: "replies drafted with AI assistance" },
    });
    const body = on.json() as { room: { posting: boolean; disclosure: string } };
    assert.equal(body.room.posting, true);
    assert.equal(body.room.disclosure, "replies drafted with AI assistance");

    // Adding a room again is not a vote on the switch: an update that does not
    // mention posting leaves it where the human put it.
    const again = await app.inject({
      method: "POST", url: "/api/surfaces/twitch/rooms", headers: A.headers,
      payload: { room: "#kicksbyrae" },
    });
    assert.equal((again.json() as { room: { posting: boolean } }).room.posting, true);
  });

  test("a draft-only surface refuses to store posting=true at all", async () => {
    // Storing it would show as on in the console and be refused at preflight
    // every single time, which is worse than refusing here.
    const r = await app.inject({
      method: "POST", url: "/api/surfaces/reddit/rooms", headers: A.headers,
      payload: { room: "r/mechmarket", posting: true },
    });
    assert.equal(r.statusCode, 409);
    assert.match((r.json() as { error: string }).error, /draft-only/);
  });

  test("a configured room says whether anything is actually watching it", async () => {
    // The gap this makes visible: nothing in this build turns a row in
    // `surface_rooms` into a running watch. There is no supervisor reading the
    // list, `shows.attach` is only ever called from the paste box, and the boot
    // resume is eBay Live only. A rooms page that showed the list and said
    // nothing else let an operator believe their subreddits were being read.
    await app.inject({
      method: "POST", url: "/api/surfaces/reddit/rooms", headers: A.headers,
      payload: { room: "r/mechmarket" },
    });
    const body = (await app.inject({
      method: "GET", url: "/api/surfaces/reddit/rooms", headers: A.headers,
    })).json() as { rooms: { room: string; watching: boolean }[] };
    const row = body.rooms.find((r) => r.room === "r/mechmarket");
    assert.ok(row, "the room is not on the list");
    assert.equal(row.watching, false, "a choice is not a process");
  });

  test("a room list is one account's", async () => {
    await app.inject({
      method: "POST", url: "/api/surfaces/reddit/rooms", headers: B.headers, payload: { room: "r/buildapcsales" },
    });
    const mine = (await app.inject({ method: "GET", url: "/api/surfaces/twitch/rooms", headers: A.headers }))
      .json() as { rooms: { room: string }[] };
    const theirs = (await app.inject({ method: "GET", url: "/api/surfaces/twitch/rooms", headers: B.headers }))
      .json() as { rooms: { room: string }[] };
    assert.ok(mine.rooms.some((r) => r.room === "#kicksbyrae"));
    assert.equal(theirs.rooms.length, 0, "B sees none of A's rooms");
  });

  test("deleting a room takes it off the list, and a room that is not on it 404s", async () => {
    const gone = await app.inject({
      method: "DELETE", url: "/api/surfaces/twitch/rooms?room=%23kicksbyrae", headers: A.headers,
    });
    assert.equal(gone.statusCode, 200);
    assert.equal((gone.json() as { rooms: unknown[] }).rooms.length, 0);
    const again = await app.inject({
      method: "DELETE", url: "/api/surfaces/twitch/rooms?room=%23kicksbyrae", headers: A.headers,
    });
    assert.equal(again.statusCode, 404);
  });

  test("a surface we do not know is a 404, not an empty list", async () => {
    // "No rooms on twitchh" reads as an answer and is a typo.
    const r = await app.inject({ method: "GET", url: "/api/surfaces/twitchh/rooms", headers: A.headers });
    assert.equal(r.statusCode, 404);
  });

  test("a room with no row answers off, not unknown", async () => {
    // Preflight has exactly one safe reading of a missing row.
    const store = new SurfaceRooms(pgPool());
    assert.deepEqual(await store.posting(A.id, "twitch", "#never-added"), { room: "#never-added", enabled: false });
  });

  test("a signed-out caller reaches none of it", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/api/surfaces/twitch/rooms" })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/surfaces/twitch/rooms", headers: json, payload: { room: "#x" } })).statusCode,
      401,
    );
  });
});
