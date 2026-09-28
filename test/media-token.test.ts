/**
 * The other token that travels in a URL.
 *
 * `<img>` and `<audio>` cannot send a bearer header, so the post-show report's
 * frame and audio-chunk URLs carry their token in the query string. That token
 * was the CONSOLE session: thirty days, the whole account — written into the
 * rendered DOM once per frame, and into every access-log line the report
 * generated. The query-token path allowlist did not contain it: that allowlist
 * governs where a token may be READ from, not what the token can do, so an
 * `sst_` harvested out of a `src` attribute replays as `Authorization: Bearer`
 * against every route.
 *
 * `openMediaSession` is the bridge's answer applied to the report's surface —
 * one hour, one show, read-only. These tests are written from the side of
 * whoever ends up holding that URL.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import type { AppContext } from "../src/api/context.js";
import { db as pgPool } from "../src/db/pg.js";
import { Accounts, startSessionPrune } from "../src/auth/accounts.js";

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
  return { token: r.token, headers: { authorization: `Bearer ${r.token}` }, id: r.account.id };
};

let A: Awaited<ReturnType<typeof register>>;
let showId: string;
let media: { token: string; expiresAt: string; showId: string };

before(async () => {
  ({ app, ctx } = await buildApp());
  A = await register("media-a");
  showId = (await ctx.shows.attach(`sim:m${Math.random().toString(36).slice(2, 10)}`, { ownerAccountId: A.id })).showId;
  const r = await app.inject({ method: "POST", url: `/api/shows/${showId}/media-token`, headers: A.headers });
  assert.equal(r.statusCode, 200, r.body.slice(0, 200));
  media = r.json() as typeof media;
});

after(async () => {
  await ctx.shows.detach(showId).catch(() => {});
  await pgPool().query("DELETE FROM shows WHERE id = $1", [showId]).catch(() => {});
  await app.close();
  await ctx.stop();
});

describe("a media token is not a console session", () => {
  test("it is its own kind, and short-lived", () => {
    assert.ok(media.token.startsWith("smt_"), `prefix is the scope signal: ${media.token.slice(0, 8)}`);
    const life = Date.parse(media.expiresAt) - Date.now();
    assert.ok(life > 0 && life <= 61 * 60_000, `an hour, not thirty days: ${life}ms`);
  });

  test("it reaches its own show's media — 404 for a frame that was never recorded, not 403", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/api/shows/${showId}/media/frames/1?token=${encodeURIComponent(media.token)}`,
    });
    assert.notEqual(r.statusCode, 403, `the report cannot do its own job: ${r.body.slice(0, 200)}`);
    assert.notEqual(r.statusCode, 401);
  });

  test("and nothing else the account can do", async () => {
    const auth = { authorization: `Bearer ${media.token}` };
    for (const [method, url] of [
      ["GET", "/api/settings"],
      ["GET", "/api/cost"],
      ["GET", "/api/shows"],
      ["GET", "/api/auth/me"],
      ["GET", "/api/listings"],
      ["POST", `/api/shows/${showId}/detach`],
      ["DELETE", `/api/shows/${showId}`],
      ["POST", `/api/shows/${showId}/media-token`],
    ] as const) {
      const r = await app.inject({ method: method as "GET", url, headers: { ...auth, ...json }, payload: {} });
      assert.equal(r.statusCode, 403, `${method} ${url} → ${r.statusCode}`);
      assert.equal(r.json().code, "out-of-scope");
    }
  });

  test("it cannot FEED the show it can read — that is the bridge's job, not this one's", async () => {
    for (const [method, url] of [
      ["POST", `/api/shows/${showId}/audio/levels`],
      ["POST", `/api/shows/${showId}/visual/frame`],
    ] as const) {
      const r = await app.inject({
        method, url,
        headers: { authorization: `Bearer ${media.token}`, ...json },
        payload: { level: 0.4 },
      });
      assert.equal(r.statusCode, 403, `${url} → ${r.statusCode}`);
    }
  });

  test("it cannot open the event stream, or the bridge page", async () => {
    const stream = await app.inject({
      method: "GET", url: `/api/stream?showId=${showId}&token=${encodeURIComponent(media.token)}`,
    });
    assert.equal(stream.statusCode, 403);
    const bridge = await app.inject({
      method: "GET", url: `/audio-bridge?showId=${showId}&token=${encodeURIComponent(media.token)}`,
    });
    assert.equal(bridge.statusCode, 403);
  });

  test("and not another show's media, even the same account's", async () => {
    const other = await ctx.shows.attach(`sim:m${Math.random().toString(36).slice(2, 10)}`, { ownerAccountId: A.id });
    const r = await app.inject({
      method: "GET",
      url: `/api/shows/${other.showId}/media/frames/1?token=${encodeURIComponent(media.token)}`,
    });
    assert.equal(r.statusCode, 403);
    await ctx.shows.detach(other.showId).catch(() => {});
    await pgPool().query("DELETE FROM shows WHERE id = $1", [other.showId]).catch(() => {});
  });
});

/**
 * The prune existed and nothing called it.
 *
 * Survivable while sessions were minted at sign-in and when the bridge opened.
 * `openMediaSession` writes one on every report view, all dead within the hour,
 * so this became the difference between a table that grows with sign-ins and
 * one that grows with ordinary use.
 */
describe("expired sessions are actually collected", () => {
  test("prune removes an expired row and leaves a live one", async () => {
    const dead = `smt_${Math.random().toString(16).slice(2)}dead`;
    await pgPool().query(
      "INSERT INTO auth_sessions (token, account_id, expires_at, scope_show_id) VALUES ($1,$2,now() - interval '1 hour',$3)",
      [dead, A.id, showId],
    );
    const removed = await new Accounts(pgPool()).pruneExpiredSessions();
    assert.ok(removed >= 1, `pruned ${removed}`);

    const gone = await pgPool().query("SELECT 1 FROM auth_sessions WHERE token = $1", [dead]);
    assert.equal(gone.rowCount, 0, "the expired row is gone");

    const live = await pgPool().query("SELECT 1 FROM auth_sessions WHERE token = $1", [media.token]);
    assert.equal(live.rowCount, 1, "the hour-old media token is untouched");
  });

  test("the scheduler is stoppable and does not hold the process open", () => {
    const stop = startSessionPrune(new Accounts(pgPool()), { firstDelayMs: 50_000, everyMs: 60_000 });
    assert.equal(typeof stop, "function");
    stop();
  });
});
