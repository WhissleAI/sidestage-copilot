/**
 * What one seller may learn about another's spend: nothing.
 *
 * `/api/cost` has always stated the rule in its own comment — "The backend
 * holds one Whissle key for everyone, so the wallet is shared and its balance
 * is nobody's number to see" — and honoured it. `/api/billing` and
 * `/api/analytics` returned the same workspace wallet, the org-wide usage rows
 * and the WHOLE process meter to anyone signed in, so seller B could read the
 * workspace's balance and infer from the per-show call counts what seller A
 * was spending. (`/api/cost`'s own `live` block leaked the same meter through
 * a filter that evaluated to `true` for every show once the caller had one row
 * of their own.)
 *
 * Written from B's side, with A's show metering real calls.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import type { AppContext } from "../src/api/context.js";
import { meter } from "../src/llm/meter.js";
import { db as pgPool } from "../src/db/pg.js";

let app: FastifyInstance;
let ctx: AppContext;
const json = { "content-type": "application/json" };

const register = async (tag: string) => {
  const r = (
    await app.inject({
      method: "POST", url: "/api/auth/register", headers: json,
      payload: {
        email: `${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`,
        password: "password-123", displayName: tag,
      },
    })
  ).json() as { token: string; account: { id: string } };
  return { headers: { authorization: `Bearer ${r.token}` }, id: r.account.id };
};

let A: { headers: Record<string, string>; id: string };
let B: { headers: Record<string, string>; id: string };
let aShow: string;
let bShow: string;

before(async () => {
  ({ app, ctx } = await buildApp());
  A = await register("cost-a");
  B = await register("cost-b");
  aShow = (await ctx.shows.attach(`sim:k${Math.random().toString(36).slice(2, 10)}`, { ownerAccountId: A.id })).showId;
  bShow = (await ctx.shows.attach(`sim:k${Math.random().toString(36).slice(2, 10)}`, { ownerAccountId: B.id })).showId;
  // A's show does some work. This is the number B must not be able to read.
  for (let i = 0; i < 7; i++) {
    meter.record({ door: "chat_turn", ms: 120, ok: true, status: 200, showId: aShow, contextChars: 4_000 });
  }
  meter.record({ door: "chat_turn", ms: 90, ok: true, status: 200, showId: bShow, contextChars: 100 });
});

after(async () => {
  for (const id of [aShow, bShow]) {
    await ctx.shows.detach(id).catch(() => {});
    await pgPool().query("DELETE FROM shows WHERE id = $1", [id]).catch(() => {});
  }
  await app.close();
  await ctx.stop();
});

type CostBlock = {
  wallet: unknown;
  usage: unknown;
  meter: {
    byShow: Record<string, { calls: number; contextChars: number }>;
    totals: { calls: number; contextChars: number };
    doors: Record<string, { calls: number }>;
  };
};

describe("the shared wallet is nobody's number", () => {
  test("/api/billing does not hand a seller the workspace balance", async () => {
    const r = await app.inject({ method: "GET", url: "/api/billing", headers: B.headers });
    assert.equal(r.statusCode, 200);
    const b = r.json() as CostBlock & { walletError: { status: number } };
    assert.equal(b.wallet, null, "the workspace wallet balance was returned to a seller");
    assert.equal(b.usage, null, "org-wide consumption was returned to a seller");
    assert.equal(b.walletError.status, 403);
  });

  test("/api/billing's meter is cut to the caller's own shows", async () => {
    const b = (await app.inject({ method: "GET", url: "/api/billing", headers: B.headers })).json() as CostBlock;
    assert.ok(!(aShow in b.meter.byShow), `B read A's per-show meter: ${JSON.stringify(b.meter.byShow)}`);
    assert.ok(bShow in b.meter.byShow, "B lost their own show's meter");
    assert.equal(b.meter.totals.calls, 1, "the totals are the whole process, not the caller's");
    assert.equal(b.meter.doors.chat_turn?.calls ?? 0, 1, "the per-door counts are the whole process's");

    // And the owner still gets their own, which is the point of the rail.
    const a = (await app.inject({ method: "GET", url: "/api/billing", headers: A.headers })).json() as CostBlock;
    assert.equal(a.meter.byShow[aShow]?.calls, 7);
    assert.ok(!(bShow in a.meter.byShow));
  });

  test("/api/analytics says the same thing as /api/cost, not the opposite", async () => {
    const r = await app.inject({ method: "GET", url: `/api/analytics?showId=${bShow}`, headers: B.headers });
    assert.equal(r.statusCode, 200, r.body.slice(0, 200));
    const cost = (r.json() as { cost: CostBlock }).cost;
    assert.equal(cost.wallet, null, "analytics handed a seller the workspace wallet");
    assert.equal(cost.usage, null);
    assert.ok(!(aShow in cost.meter.byShow), "analytics leaked another seller's per-show meter");
  });

  test("/api/cost's live block is the caller's shows only", async () => {
    // B needs one finished-cost row of their own: the old filter was
    // `s ? true : shows.length === 0 ? false : true`, which only starts
    // leaking once the caller has a row — and then leaks every show in the
    // process.
    await pgPool().query(
      `INSERT INTO show_costs (show_id, opened_at, closed_at, duration_min, calls, answered)
       VALUES ($1, now() - interval '1 hour', now(), 60, 1, 1)
       ON CONFLICT (show_id) DO NOTHING`,
      [bShow],
    );
    const r = await app.inject({ method: "GET", url: "/api/cost", headers: B.headers });
    assert.equal(r.statusCode, 200);
    const live = (r.json() as { live: Record<string, unknown> }).live;
    assert.ok(!(aShow in live), `/api/cost leaked A's live meter to B: ${JSON.stringify(live)}`);
  });
});
