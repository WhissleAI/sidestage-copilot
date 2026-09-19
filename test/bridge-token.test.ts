/**
 * The token that travels in a URL.
 *
 * The audio bridge is a page the operator opens in a tab, so its token rides
 * in the query string — address bar, browser history, and whatever they paste
 * when they send the link to their other machine. It used to be the CONSOLE
 * session: thirty days, the whole account. The page also loads a script from a
 * CDN with nothing pinning the bytes, so a CDN compromise could read that
 * token out of `location.search`. And `?token=` was honoured on EVERY route,
 * which made the entire API driveable from a URL.
 *
 * Three things, tested from the side of whoever ends up holding that URL.
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
  return { token: r.token, headers: { authorization: `Bearer ${r.token}` }, id: r.account.id };
};

let A: Awaited<ReturnType<typeof register>>;
let showId: string;
let bridge: { token: string; expiresAt: string; url: string };

before(async () => {
  ({ app, ctx } = await buildApp());
  A = await register("bridge-a");
  showId = (await ctx.shows.attach(`sim:b${Math.random().toString(36).slice(2, 10)}`, { ownerAccountId: A.id })).showId;
  const r = await app.inject({ method: "POST", url: `/api/shows/${showId}/bridge-token`, headers: A.headers });
  assert.equal(r.statusCode, 200, r.body.slice(0, 200));
  bridge = r.json() as typeof bridge;
});

after(async () => {
  await ctx.shows.detach(showId).catch(() => {});
  await pgPool().query("DELETE FROM shows WHERE id = $1", [showId]).catch(() => {});
  await app.close();
  await ctx.stop();
});

describe("a bridge token is not a console session", () => {
  test("it can feed its own show's audio", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/shows/${showId}/audio/levels`,
      headers: { authorization: `Bearer ${bridge.token}`, ...json },
      payload: { level: 0.4 },
    });
    assert.notEqual(r.statusCode, 403, `the bridge cannot do its own job: ${r.body.slice(0, 200)}`);
    assert.notEqual(r.statusCode, 401);
  });

  test("and nothing else the account can do", async () => {
    const auth = { authorization: `Bearer ${bridge.token}` };
    for (const [method, url] of [
      ["GET", "/api/settings"],
      ["GET", "/api/cost"],
      ["GET", "/api/shows"],
      ["GET", "/api/auth/me"],
      ["GET", "/api/listings"],
      ["POST", `/api/shows/${showId}/detach`],
      ["DELETE", `/api/shows/${showId}`],
      ["POST", `/api/shows/${showId}/bridge-token`],
    ] as const) {
      const r = await app.inject({ method: method as "GET", url, headers: { ...auth, ...json }, payload: {} });
      assert.equal(r.statusCode, 403, `${method} ${url} → ${r.statusCode}`);
      assert.equal(r.json().code, "out-of-scope");
    }
  });

  test("and not another show, even the same account's", async () => {
    const other = await ctx.shows.attach(`sim:b${Math.random().toString(36).slice(2, 10)}`, { ownerAccountId: A.id });
    const r = await app.inject({
      method: "POST", url: `/api/shows/${other.showId}/audio/levels`,
      headers: { authorization: `Bearer ${bridge.token}`, ...json }, payload: { level: 0.4 },
    });
    assert.equal(r.statusCode, 403);
    await ctx.shows.detach(other.showId).catch(() => {});
    await pgPool().query("DELETE FROM shows WHERE id = $1", [other.showId]).catch(() => {});
  });

  test("it expires in an hour, not in a month", () => {
    const ms = new Date(bridge.expiresAt).getTime() - Date.now();
    assert.ok(ms > 0 && ms <= 61 * 60_000, `a bridge token good for ${Math.round(ms / 60_000)} minutes`);
  });
});

describe("a token in the query string", () => {
  test("works on the four things that cannot send a header", async () => {
    for (const url of [
      `/audio-bridge?showId=${showId}&token=${A.token}`,
      `/api/shows/${showId}/export?token=${A.token}`,
    ]) {
      const r = await app.inject({ method: "GET", url });
      assert.notEqual(r.statusCode, 401, `${url.split("?")[0]} → ${r.statusCode}`);
    }
  });

  test("is ignored everywhere else, so a leaked URL is not an API key", async () => {
    for (const url of ["/api/settings", "/api/cost", "/api/shows", "/api/reports", "/api/auth/me"]) {
      const r = await app.inject({ method: "GET", url: `${url}?token=${A.token}` });
      assert.equal(r.statusCode, 401, `${url} accepted a token from the query string (${r.statusCode})`);
    }
  });
});

describe("the bridge page itself", () => {
  test("pins the script it loads and allows nothing else to run", async () => {
    const r = await app.inject({ method: "GET", url: "/audio-bridge" });
    assert.equal(r.statusCode, 200);
    const csp = String(r.headers["content-security-policy"] ?? "");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src https:\/\/cdn\.jsdelivr\.net 'nonce-[A-Za-z0-9+/=]+'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(r.headers["referrer-policy"], "no-referrer");

    // The pinned script, and a nonce that is actually on the page's own tags.
    assert.match(r.body, /integrity="sha384-[A-Za-z0-9+/=]+"/);
    assert.match(r.body, /crossorigin="anonymous"/);
    const nonce = csp.match(/'nonce-([^']+)'/)![1]!;
    assert.ok(r.body.includes(`<script nonce="${nonce}">`), "the page's own script does not carry the nonce");
    assert.ok(r.body.includes(`<style nonce="${nonce}">`), "the page's own style does not carry the nonce");
    assert.ok(!r.body.includes("__NONCE__"), "the placeholder was served as-is");
  });

  test("a second load is a second nonce", async () => {
    const one = await app.inject({ method: "GET", url: "/audio-bridge" });
    const two = await app.inject({ method: "GET", url: "/audio-bridge" });
    assert.notEqual(one.headers["content-security-policy"], two.headers["content-security-policy"]);
  });
});
