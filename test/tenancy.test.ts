import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import type { AppContext } from "../src/api/context.js";
import { db as pgPool } from "../src/db/pg.js";

// A show belongs to the account that attached it. Before 2026-09-15 nothing
// wrote an owner and nothing checked one: a second account could read, drive
// and delete the first account's show, measured on production. These tests
// are the boundary.

let app: FastifyInstance;
let ctx: AppContext;
const json = { "content-type": "application/json" };
const register = async (tag: string) => {
  const r = (await app.inject({
    method: "POST", url: "/api/auth/register", headers: json,
    payload: { email: `${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`, password: "password-123", displayName: tag },
  })).json() as { token: string; account: { id: string } };
  return { headers: { authorization: `Bearer ${r.token}` }, id: r.account.id };
};

let A: { headers: Record<string, string>; id: string };
let B: { headers: Record<string, string>; id: string };
const SHOW = "show_tenancy_a";

before(async () => {
  ({ app, ctx } = await buildApp());
  A = await register("owner-a");
  B = await register("stranger-b");
  const p = pgPool();
  await p.query("DELETE FROM shows WHERE id = $1", [SHOW]);
  await p.query(
    `INSERT INTO shows (id, owner_account_id, title, seller_handle, source, started_at, status, autonomy_level, undo_window_s)
     VALUES ($1, $2, 'A''s show', 'seller-a', 'ebaylive', $3, 'ended', 'L1_SUGGEST', 90)`,
    [SHOW, A.id, new Date().toISOString()],
  );
  await p.query(
    `INSERT INTO show_reports (show_id, report) VALUES ($1, $2::jsonb) ON CONFLICT (show_id) DO UPDATE SET report = EXCLUDED.report`,
    [SHOW, JSON.stringify({ showId: SHOW, title: "A's show", engagement: { commentsSeen: 1, questionsAsked: 1, answered: 0, sent: 0, answeredRate: 0, medianLatencyMs: 0, p95LatencyMs: 0, cacheHitRate: 0 }, safety: { blocked: 0, revised: 0, abstained: 0, flaggedWrong: 0, byGuard: {}, auditChain: { ok: true } }, actions: { proposed: 0, committed: 0, rolledBack: 0, failed: 0 } })],
  );
});
after(async () => {
  await pgPool().query("DELETE FROM shows WHERE id = $1", [SHOW]).catch(() => {});
  await app.close();
  await ctx.stop();
});

describe("a show is one account's", () => {
  test("the owner reads its report; a stranger gets 404, not 403", async () => {
    const mine = await app.inject({ method: "GET", url: `/api/shows/${SHOW}/report`, headers: A.headers });
    assert.equal(mine.statusCode, 200);
    const theirs = await app.inject({ method: "GET", url: `/api/shows/${SHOW}/report`, headers: B.headers });
    assert.equal(theirs.statusCode, 404, `stranger got ${theirs.statusCode}: ${theirs.body}`);
  });

  test("the reports list is cut to the caller", async () => {
    const a = (await app.inject({ method: "GET", url: "/api/reports", headers: A.headers })).json() as { showId: string }[];
    const b = (await app.inject({ method: "GET", url: "/api/reports", headers: B.headers })).json() as { showId: string }[];
    assert.ok(a.some((r) => r.showId === SHOW), "the owner sees their show");
    assert.ok(!b.some((r) => r.showId === SHOW), "a stranger does not");
  });

  test("record, export, timeline and media answer 404 to a stranger", async () => {
    for (const path of ["record", "export", "timeline", "media/frames/1"]) {
      const r = await app.inject({ method: "GET", url: `/api/shows/${SHOW}/${path}`, headers: B.headers });
      assert.equal(r.statusCode, 404, `${path} → ${r.statusCode}`);
    }
  });

  test("a stranger cannot delete or detach the show", async () => {
    const del = await app.inject({ method: "DELETE", url: `/api/shows/${SHOW}`, headers: B.headers });
    assert.equal(del.statusCode, 404);
    const det = await app.inject({ method: "POST", url: `/api/shows/${SHOW}/detach`, headers: B.headers });
    assert.equal(det.statusCode, 404);
    const still = await pgPool().query("SELECT 1 FROM shows WHERE id = $1", [SHOW]);
    assert.equal(still.rows.length, 1, "the show is still there");
  });

  test("analytics only count the caller's shows", async () => {
    const ra = await app.inject({ method: "GET", url: "/api/analytics/overview?days=1", headers: A.headers });
    assert.equal(ra.statusCode, 200, ra.body.slice(0, 300));
    const a = ra.json() as { shows: { finished: number } };
    const b = (await app.inject({ method: "GET", url: "/api/analytics/overview?days=1", headers: B.headers })).json() as { shows: { finished: number } };
    assert.ok(a.shows.finished >= 1);
    assert.ok(b.shows.finished < a.shows.finished, `stranger sees ${b.shows.finished}, owner ${a.shows.finished}`);
  });

  test("a mutating route with no session is refused before the handler", async () => {
    const r = await app.inject({ method: "POST", url: "/api/catalogs/reload" });
    assert.equal(r.statusCode, 401);
  });
});
