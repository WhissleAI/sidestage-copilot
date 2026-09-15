import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import type { AppContext } from "../src/api/context.js";
import { policy, policyScope, setPolicy, DEFAULT_POLICY } from "../src/guardrails/policy.js";

// Guard settings are per seller, but every guard reads `policy()`. Before
// 2026-09-15 the last seller to save or attach re-armed the whole process, so
// two sellers live at once were checked against whichever settings won the
// race. The fix runs each request (and each show's watcher-driven work) inside
// an AsyncLocalStorage scope holding the owner's merged policy.

let app: FastifyInstance;
let ctx: AppContext;
const json = { "content-type": "application/json" };
const register = async (tag: string) => {
  const r = (await app.inject({
    method: "POST", url: "/api/auth/register", headers: json,
    payload: { email: `${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`, password: "password-123", displayName: tag },
  })).json() as { token: string };
  return { authorization: `Bearer ${r.token}` };
};

before(async () => {
  ({ app, ctx } = await buildApp());
});
after(async () => {
  setPolicy(null);
  await app.close();
  await ctx.stop();
});

test("policy() reads the scope first and the process default after", () => {
  setPolicy({ ...DEFAULT_POLICY, maxDiscountPct: 15 });
  assert.equal(policy().maxDiscountPct, 15);
  const seen = policyScope.run({ ...DEFAULT_POLICY, maxDiscountPct: 3 }, () => policy().maxDiscountPct);
  assert.equal(seen, 3);
  assert.equal(policy().maxDiscountPct, 15, "leaving the scope restores the default");
});

test("two sellers' requests are each checked against their own settings", async () => {
  const A = await register("seller-a");
  const B = await register("seller-b");

  const a = await app.inject({ method: "PUT", url: "/api/settings", headers: { ...A, ...json }, payload: { maxDiscountPct: 7 } });
  assert.equal(a.statusCode, 200);
  const b = await app.inject({ method: "PUT", url: "/api/settings", headers: { ...B, ...json }, payload: { maxDiscountPct: 3 } });
  assert.equal(b.statusCode, 200);

  // B saved last. Under the old process-wide policy A's next request would
  // have been guarded at 3%. `enforcing` is `policy()` read inside the
  // request, which is what the guards see.
  const aView = (await app.inject({ method: "GET", url: "/api/settings", headers: A })).json();
  const bView = (await app.inject({ method: "GET", url: "/api/settings", headers: B })).json();
  assert.equal(aView.enforcing.maxDiscountPct, 7);
  assert.equal(bView.enforcing.maxDiscountPct, 3);

  // A change is visible on the very next request, not after a cache expiry.
  await app.inject({ method: "PUT", url: "/api/settings", headers: { ...A, ...json }, payload: { maxDiscountPct: 11 } });
  const aAgain = (await app.inject({ method: "GET", url: "/api/settings", headers: A })).json();
  assert.equal(aAgain.enforcing.maxDiscountPct, 11);

  await app.inject({ method: "POST", url: "/api/settings/reset", headers: A });
  await app.inject({ method: "POST", url: "/api/settings/reset", headers: B });
});

test("a request with no session has no settings to read", async () => {
  // There is no anonymous policy: settings belong to a seller, and a caller
  // without a session is refused before any scope is entered.
  const r = await app.inject({ method: "GET", url: "/api/settings" });
  assert.equal(r.statusCode, 401);
});
