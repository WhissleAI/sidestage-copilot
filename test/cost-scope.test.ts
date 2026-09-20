// The Cost page is one seller's, and the meter behind it is the whole process's.
//
// `/api/cost` returned a `live` block labelled "what is running right now, for
// this seller" built by filtering the process-wide meter with
//
//     const s = shows.find((x) => x.showId === id);
//     return s ? true : shows.length === 0 ? false : true;
//
// — true in every branch but one. Any seller with a single finished session was
// therefore handed every OTHER seller's live show id, call count, failure count
// and context characters, on the page whose own copy says "this page is YOURS".

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

process.env.CATALOGS_DIR = ".tmp/test-catalogs";

const { buildApp } = await import("../src/api/server.js");
const { db: pgPool } = await import("../src/db/pg.js");
const { meter } = await import("../src/llm/meter.js");
type AppContext = Awaited<ReturnType<typeof buildApp>>["ctx"];

let app: FastifyInstance;
let ctx: AppContext;
let A: { id: string; headers: Record<string, string> };
let B: { id: string; headers: Record<string, string> };

const MINE = "show_cost_scope_mine";
const THEIRS = "show_cost_scope_theirs";

async function register(tag: string): Promise<{ id: string; headers: Record<string, string> }> {
  const r = (
    await app.inject({
      method: "POST", url: "/api/auth/register",
      headers: { "content-type": "application/json" },
      payload: {
        email: `cost-${tag}-${Date.now()}${Math.random().toString(16).slice(2)}@test.local`,
        password: "password-123", displayName: tag,
      },
    })
  ).json();
  return { id: r.account.id, headers: { authorization: `Bearer ${r.token}` } };
}

before(async () => {
  ({ app, ctx } = await buildApp());
  A = await register("a");
  B = await register("b");

  // Two sessions on air in this process, one per account. The registry is what
  // knows who owns a RUNNING show — a session that has not finished has no cost
  // row yet, which is exactly the case the `live` block exists for.
  const summary = (showId: string, ownerAccountId: string) => ({
    showId, ownerAccountId, agentId: "", catalogId: null, title: showId,
    sellerHandle: "tester", source: "simulated" as const, externalId: null,
    readOnly: false, writeTarget: "mock" as const, status: "live" as const,
    startedAt: new Date().toISOString(), viewers: 0, listings: 0, proposals: 0,
    awaiting: 0, blocked: 0,
  });
  (ctx.shows as unknown as { list: () => Promise<unknown[]> }).list = async () => [
    summary(MINE, A.id),
    summary(THEIRS, B.id),
  ];

  // Both are spending on the one process-wide meter.
  for (let i = 0; i < 4; i++) meter.record({ door: "chat_turn", ms: 200, ok: true, showId: MINE });
  for (let i = 0; i < 9; i++) meter.record({ door: "chat_turn", ms: 200, ok: true, showId: THEIRS });

  // A has a finished session too — the condition that used to flip the filter
  // to "true" for every show in the process.
  await pgPool().query(
    `INSERT INTO shows (id, owner_account_id, title, seller_handle, started_at, source, status, ended_at)
     VALUES ($1, $2, 'A finished session', 'tester', $3, 'simulated', 'ended', now())
     ON CONFLICT (id) DO NOTHING`,
    [`${MINE}_done`, A.id, new Date(Date.now() - 3_600_000).toISOString()],
  );
  await pgPool().query(
    `INSERT INTO show_costs (show_id, opened_at, duration_min, calls, answered, account_id)
     VALUES ($1, now(), 30, 40, 5, $2) ON CONFLICT (show_id) DO NOTHING`,
    [`${MINE}_done`, A.id],
  );
});

after(async () => {
  await pgPool().query("DELETE FROM shows WHERE id = $1", [`${MINE}_done`]).catch(() => {});
  await app.close();
  await ctx.stop();
});

describe("what the cost page says is running", () => {
  test("a seller with a finished session is not handed every other seller's live show", async () => {
    const r = await app.inject({ method: "GET", url: "/api/cost", headers: A.headers });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.ok(body.shows.length > 0, "A does have a finished session — the condition that broke the filter");

    const live = Object.keys(body.live);
    assert.ok(live.includes(MINE), "A's own running session must still be here");
    assert.equal(
      live.includes(THEIRS), false,
      "B's session id, calls and context characters are not A's to see",
    );
  });

  test("and the other seller sees theirs, not A's", async () => {
    const r = await app.inject({ method: "GET", url: "/api/cost", headers: B.headers });
    assert.equal(r.statusCode, 200);
    const live = Object.keys(r.json().live);
    assert.ok(live.includes(THEIRS));
    assert.equal(live.includes(MINE), false);
  });
});
