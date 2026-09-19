/**
 * A show that belongs to nobody is not a show that belongs to everybody.
 *
 * Rows written before ownership existed have `owner_account_id IS NULL`, and
 * every read path deliberately includes them: a seller must not lose their own
 * history to a column that did not exist when the row was written. What was
 * never intended is that they are WRITABLE. The ownership preHandler passed on
 * `owner === null`, and the write guard only asks "is this a seller" — so any
 * account could detach one, delete it, change its autonomy level, approve,
 * reject or roll back its actions and send its replies.
 *
 * Written from a stranger's side, on a row nobody owns.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import type { AppContext } from "../src/api/context.js";
import { db as pgPool } from "../src/db/pg.js";

let app: FastifyInstance;
let ctx: AppContext;
const json = { "content-type": "application/json" };
const SHOW = "show_ownerless_legacy";

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

let S: { headers: Record<string, string>; id: string };

before(async () => {
  ({ app, ctx } = await buildApp());
  S = await register("stranger");
  const p = pgPool();
  await p.query("DELETE FROM shows WHERE id = $1", [SHOW]);
  // The legacy shape, exactly: a row with no owner.
  await p.query(
    `INSERT INTO shows (id, owner_account_id, title, seller_handle, source, started_at, status, autonomy_level, undo_window_s)
     VALUES ($1, NULL, 'a show from before accounts', 'someone', 'ebaylive', $2, 'ended', 'L1_SUGGEST', 90)`,
    [SHOW, new Date().toISOString()],
  );
});

after(async () => {
  await pgPool().query("DELETE FROM shows WHERE id = $1", [SHOW]).catch(() => {});
  await app.close();
  await ctx.stop();
});

describe("an ownerless show", () => {
  test("is still readable — that is the documented wrinkle and it stays", async () => {
    const r = await app.inject({ method: "GET", url: `/api/shows/${SHOW}/record`, headers: S.headers });
    assert.notEqual(r.statusCode, 403, "a legacy row lost its read");
    assert.notEqual(r.statusCode, 404, "a legacy row lost its read");
  });

  test("refuses every write, to anyone", async () => {
    const attempts: [string, string, unknown?][] = [
      ["DELETE", `/api/shows/${SHOW}`],
      ["POST", `/api/shows/${SHOW}/detach`],
      ["POST", `/api/autonomy?showId=${SHOW}`, { level: "L3_ACT" }],
      ["POST", `/api/shows/${SHOW}/catalog/apply`, { catalogId: "demo" }],
    ];
    for (const [method, url, payload] of attempts) {
      const r = await app.inject({ method: method as "POST", url, headers: { ...S.headers, ...json }, payload: payload ?? {} });
      assert.equal(r.statusCode, 403, `${method} ${url} → ${r.statusCode}: ${r.body.slice(0, 160)}`);
      assert.equal(r.json().code, "ownerless-show");
    }
  });

  test("the row survives the attempt", async () => {
    const still = await pgPool().query("SELECT 1 FROM shows WHERE id = $1", [SHOW]);
    assert.equal(still.rows.length, 1);
  });

  test("deleting an account takes its shows with it rather than orphaning them", async () => {
    // The FK used to be ON DELETE SET NULL, which manufactured fresh ownerless
    // rows — every show of a deleted account became readable by every other
    // seller. There is no account-deletion route today; the constraint is the
    // thing under test, so it is exercised directly.
    const p = pgPool();
    const doomed = await register("doomed");
    const id = `show_cascade_${Math.random().toString(36).slice(2, 8)}`;
    await p.query(
      `INSERT INTO shows (id, owner_account_id, title, seller_handle, source, started_at, status, autonomy_level, undo_window_s)
       VALUES ($1, $2, 'theirs', 'them', 'ebaylive', $3, 'ended', 'L1_SUGGEST', 90)`,
      [id, doomed.id, new Date().toISOString()],
    );
    await p.query("DELETE FROM accounts WHERE id = $1", [doomed.id]);
    const left = await p.query<{ owner_account_id: string | null }>(
      "SELECT owner_account_id FROM shows WHERE id = $1", [id],
    );
    assert.equal(left.rows.length, 0, `the show was orphaned rather than removed: ${JSON.stringify(left.rows)}`);
  });
});
