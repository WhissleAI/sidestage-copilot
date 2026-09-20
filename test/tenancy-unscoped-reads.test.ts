/**
 * The eight reads that do not name a show.
 *
 * `GET /api/audit`, `/api/audit/verify`, `/api/metrics`, `/api/show`,
 * `/api/listings`, `/api/context`, `/api/actions`, `/api/proposals` are the
 * console's view of "my show" — the caller's newest live one, resolved for
 * them because the console does not carry a show switcher on every screen.
 *
 * Before this suite, "my show" was resolved by a process-global pointer to
 * whichever show was attached LAST on the box, by anyone: the read helper
 * called `rt(showId)` and `rt`'s request argument was optional, so with no
 * request there was no actor, with no actor no account, and the registry fell
 * through to `ShowRegistry.active`. A seller who signed up thirty seconds ago
 * and had no show of their own read another seller's audit chain, listings,
 * prices, drafted replies and live host transcript, on the deployed box.
 *
 * So these are written from the SECOND account's side. A shows and B does not;
 * B must be told nothing is being watched, whether or not B names the show.
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

/** Every route that answers "my show" without being told which one. */
const UNSCOPED_READS = [
  "/api/audit",
  "/api/audit/verify",
  "/api/metrics",
  "/api/show",
  "/api/listings",
  "/api/context",
  "/api/actions",
  "/api/proposals",
];

let A: { headers: Record<string, string>; id: string };
let B: { headers: Record<string, string>; id: string };
let showId: string;

before(async () => {
  ({ app, ctx } = await buildApp());
  A = await register("shows-a");
  B = await register("noshow-b");
  // A's show, live, and the last thing attached in this process — which is
  // exactly the state that used to make it everybody's.
  const rt = await ctx.shows.attach(`sim:t${Math.random().toString(36).slice(2, 10)}`, {
    ownerAccountId: A.id,
    title: "A's show",
  });
  showId = rt.showId;
});

after(async () => {
  await ctx.shows.detach(showId).catch(() => {});
  await pgPool().query("DELETE FROM shows WHERE id = $1", [showId]).catch(() => {});
  await app.close();
  await ctx.stop();
});

describe("an unscoped read is scoped to the caller", () => {
  test("the owner still gets their newest live show with no showId — that is the point of the route", async () => {
    for (const url of UNSCOPED_READS) {
      const r = await app.inject({ method: "GET", url, headers: A.headers });
      assert.equal(r.statusCode, 200, `${url} → ${r.statusCode}: ${r.body.slice(0, 200)}`);
    }
    const show = (await app.inject({ method: "GET", url: "/api/show", headers: A.headers })).json() as { id?: string; showId?: string };
    assert.equal(show.id ?? show.showId, showId, "the owner's own show, not some other one");
  });

  test("a second account with no show of its own reads NOTHING, on all eight", async () => {
    for (const url of UNSCOPED_READS) {
      const r = await app.inject({ method: "GET", url, headers: B.headers });
      assert.equal(r.statusCode, 404, `${url} served a stranger ${r.statusCode}: ${r.body.slice(0, 200)}`);
      assert.doesNotMatch(r.body, new RegExp(showId), `${url} leaked the show id to a stranger`);
    }
  });

  test("naming the show explicitly does not get a stranger in either", async () => {
    for (const url of UNSCOPED_READS) {
      const r = await app.inject({ method: "GET", url: `${url}?showId=${showId}`, headers: B.headers });
      assert.equal(r.statusCode, 404, `${url}?showId → ${r.statusCode}`);
    }
  });

  test("a signed-out caller cannot read them at all", async () => {
    for (const url of UNSCOPED_READS) {
      const r = await app.inject({ method: "GET", url });
      assert.equal(r.statusCode, 401, `${url} → ${r.statusCode}`);
    }
  });
});
