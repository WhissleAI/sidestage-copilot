/**
 * Ending a session that has left the building.
 *
 * A console session lives thirty days with no idle timeout, `logout` deleted
 * exactly one token, and there was no password change, no "sign out
 * everywhere" and nothing that ever removed an expired row. A seller who
 * pasted a bridge URL into a chat — the URL carries the session token — had no
 * recourse at all.
 *
 * Written as a second DEVICE: the same account signed in twice, which is the
 * shape of every one of those stories.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import type { AppContext } from "../src/api/context.js";
import { Accounts } from "../src/auth/accounts.js";
import { db as pgPool } from "../src/db/pg.js";

let app: FastifyInstance;
let ctx: AppContext;
const json = { "content-type": "application/json" };

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const signIn = async (email: string, password: string) =>
  (await app.inject({ method: "POST", url: "/api/auth/login", headers: json, payload: { email, password } }))
    .json() as { token?: string; error?: string };
const alive = async (token: string) =>
  (await app.inject({ method: "GET", url: "/api/auth/me", headers: bearer(token) })).statusCode;

before(async () => { ({ app, ctx } = await buildApp()); });
after(async () => { await app.close(); await ctx.stop(); });

describe("a session can be ended", () => {
  test("changing the password signs out the other device and keeps this one", async () => {
    const email = `life-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
    const laptop = (
      await app.inject({
        method: "POST", url: "/api/auth/register", headers: json,
        payload: { email, password: "password-123", displayName: "life" },
      })
    ).json() as { token: string };
    const phone = await signIn(email, "password-123");
    assert.ok(phone.token, "the second sign-in did not mint a session");
    assert.equal(await alive(phone.token!), 200);

    const wrong = await app.inject({
      method: "POST", url: "/api/auth/password", headers: { ...bearer(laptop.token), ...json },
      payload: { currentPassword: "not-the-password", newPassword: "a-new-password-1" },
    });
    assert.equal(wrong.statusCode, 401, "a stolen token alone changed the password");

    const r = await app.inject({
      method: "POST", url: "/api/auth/password", headers: { ...bearer(laptop.token), ...json },
      payload: { currentPassword: "password-123", newPassword: "a-new-password-1" },
    });
    assert.equal(r.statusCode, 200, r.body.slice(0, 200));

    assert.equal(await alive(phone.token!), 401, "the other session survived a password change");
    assert.equal(await alive(laptop.token), 200, "the seller was signed out of the browser they were using");
    assert.equal((await signIn(email, "password-123")).token, undefined, "the old password still works");
    assert.ok((await signIn(email, "a-new-password-1")).token, "the new password does not work");
  });

  test("sign out everywhere ends this session too", async () => {
    const email = `life2-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
    const first = (
      await app.inject({
        method: "POST", url: "/api/auth/register", headers: json,
        payload: { email, password: "password-123", displayName: "life2" },
      })
    ).json() as { token: string };
    const second = (await signIn(email, "password-123")).token!;

    const r = await app.inject({ method: "POST", url: "/api/auth/logout-all", headers: bearer(first.token) });
    assert.equal(r.statusCode, 200);
    assert.equal(await alive(first.token), 401);
    assert.equal(await alive(second), 401);
  });

  test("expired rows are deleted rather than accumulating forever", async () => {
    const accounts = new Accounts(pgPool());
    const email = `life3-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`;
    const s = (
      await app.inject({
        method: "POST", url: "/api/auth/register", headers: json,
        payload: { email, password: "password-123", displayName: "life3" },
      })
    ).json() as { token: string; account: { id: string } };
    await pgPool().query("UPDATE auth_sessions SET expires_at = now() - interval '1 day' WHERE token = $1", [s.token]);

    // Already unusable — expiry is enforced in the query — but still there.
    assert.equal(await alive(s.token), 401);
    const before = await pgPool().query("SELECT 1 FROM auth_sessions WHERE token = $1", [s.token]);
    assert.equal(before.rows.length, 1);

    await accounts.pruneExpiredSessions();
    const after = await pgPool().query("SELECT 1 FROM auth_sessions WHERE token = $1", [s.token]);
    assert.equal(after.rows.length, 0, "an expired session row was left behind");
    // A live one is not swept up with it.
    const live = await signIn(email, "password-123");
    await accounts.pruneExpiredSessions();
    assert.equal(await alive(live.token!), 200);
  });
});
