// What an hour of this costs — over the sessions that did the work.
//
// `durationMin` is attach-to-detach. That equals show length for a live event
// that ends, and does not for a room that persists: the Rooms page says it
// plainly, "a room here is a list, not a running watch".
//
// Measured in production: a subreddit and a Twitch channel, attached overnight,
// held 1297 minutes each — 2594 of 2636 minutes, 98.4% of all counted time —
// for ONE gateway call apiece and nothing answered, 0.8% of the spend. Blended
// into the headline the page reported $0.0474 an hour. Over the sessions that
// answered somebody it is $2.95: 62×, on the number anyone pricing this
// product would have reached for first.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

process.env.CATALOGS_DIR = ".tmp/test-catalogs";

const { buildApp } = await import("../src/api/server.js");
const { db: pgPool } = await import("../src/db/pg.js");
type AppContext = Awaited<ReturnType<typeof buildApp>>["ctx"];

let app: FastifyInstance;
let ctx: AppContext;
let A: { id: string; headers: Record<string, string> };

const SHOW = "cost_per_hour_show";
const IDLE = "cost_per_hour_idle_room";

async function register(tag: string) {
  const r = (
    await app.inject({
      method: "POST", url: "/api/auth/register",
      headers: { "content-type": "application/json" },
      payload: {
        email: `perhour-${tag}-${Date.now()}${Math.random().toString(16).slice(2)}@test.local`,
        password: "password-123", displayName: tag,
      },
    })
  ).json();
  return { id: r.account.id, headers: { authorization: `Bearer ${r.token}` } };
}

const seed = async (id: string, min: number, calls: number, answered: number) => {
  await pgPool().query(
    `INSERT INTO shows (id, owner_account_id, title, seller_handle, started_at, source, status, ended_at)
     VALUES ($1, $2, $1, 'tester', $3, 'simulated', 'ended', now()) ON CONFLICT (id) DO NOTHING`,
    [id, A.id, new Date(Date.now() - min * 60_000).toISOString()],
  );
  await pgPool().query(
    `INSERT INTO show_costs (show_id, opened_at, duration_min, calls, answered, account_id)
     VALUES ($1, now(), $2, $3, $4, $5) ON CONFLICT (show_id) DO NOTHING`,
    [id, min, calls, answered, A.id],
  );
};

before(async () => {
  ({ app, ctx } = await buildApp());
  A = await register("a");
  // A real show: a quarter of an hour, answered five buyers.
  await seed(SHOW, 15, 100, 5);
  // A room left attached overnight: one call, nobody answered.
  await seed(IDLE, 1297, 1, 0);
});

after(async () => {
  for (const id of [SHOW, IDLE]) {
    await pgPool().query("DELETE FROM show_costs WHERE show_id = $1", [id]).catch(() => {});
    await pgPool().query("DELETE FROM shows WHERE id = $1", [id]).catch(() => {});
  }
  await app.close();
  await ctx.stop();
});

describe("the per-hour rate", () => {
  test("is taken over the sessions that answered somebody, not over time attached", async () => {
    const t = (await app.inject({ method: "GET", url: "/api/cost", headers: A.headers })).json().totals;

    assert.equal(t.minutes, 1312, "time attached is still reported as itself");
    assert.equal(t.workingMinutes, 15, "the rate's denominator is the show, not the idle room");
    assert.equal(t.workingShows, 1);

    // 100 calls at the metered rate over a quarter hour. The exact rate is the
    // meter's; what matters is the order of magnitude, which the idle room
    // moved by ~87× on this fixture.
    const blended = t.estimatedUsd / (t.minutes / 60);
    assert.ok(
      t.perHourUsd > blended * 10,
      `a rate that an idle attachment can flatten is not a price: ${t.perHourUsd} vs blended ${blended}`,
    );
  });

  test("total spend and time attached are unchanged — only the rate is scoped", async () => {
    const t = (await app.inject({ method: "GET", url: "/api/cost", headers: A.headers })).json().totals;
    assert.equal(t.shows, 2, "the idle room is still a session that happened");
    assert.ok(t.estimatedUsd > 0, "and its spend still counts toward the bill");
    assert.equal(t.workingUsd <= t.estimatedUsd, true, "the rate's numerator is a subset");
  });

  test("no session that answered anybody leaves the rate undefined", async () => {
    const B = await register("b");
    const t = (await app.inject({ method: "GET", url: "/api/cost", headers: B.headers })).json().totals;
    assert.equal(t.workingMinutes, 0);
    assert.equal(t.perHourUsd, null, "null is 'no basis yet', which must never render as a price");
  });
});
