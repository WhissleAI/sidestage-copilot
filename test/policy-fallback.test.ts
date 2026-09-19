/**
 * Whose guardrails is a reply checked against when we cannot read the
 * caller's?
 *
 * Two mechanisms used to answer that wrongly together. A save called
 * `settings.activate` — `setPolicy`, a PROCESS-global write — on a per-account
 * save; and the request hook that scopes the caller's policy fell back to
 * `done()` with NO scope on a rejected read. So during a database blip one
 * seller's replies were checked against whichever seller had saved settings
 * last: their never-say rules, their discount ceiling, silently, with nothing
 * in the audit chain saying so.
 *
 * The rule now: a scope is per request, a save changes nobody else's process,
 * and a failed read falls back to the SHIPPED defaults — never to "whatever
 * this process last had".
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import type { AppContext } from "../src/api/context.js";
import {
  policy, policyScope, runInPolicyScope, setPolicy, DEFAULT_POLICY,
} from "../src/guardrails/policy.js";

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
  ).json() as { token: string };
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

describe("a seller's settings stay a seller's", () => {
  test("saving does not re-arm the whole process with one account's rules", async () => {
    const A = await register("policy-a");
    setPolicy(null); // start from the shipped default, as a fresh process would
    const put = await app.inject({
      method: "PUT", url: "/api/settings", headers: { ...A, ...json },
      payload: {
        maxDiscountPct: 3,
        neverSay: [{ pattern: "only-account-a-says-this", why: "A's rule" }],
      },
    });
    assert.equal(put.statusCode, 200, put.body.slice(0, 200));

    // Read OUTSIDE any request: this is what a background path sees, and what
    // a request whose scope failed to load falls back to.
    const outside = policy();
    assert.equal(
      outside.maxDiscountPct, DEFAULT_POLICY.maxDiscountPct,
      "one seller's save moved the process-wide discount ceiling",
    );
    assert.ok(
      !outside.neverSay.some((r) => r.pattern === "only-account-a-says-this"),
      "one seller's never-say rule is armed for the whole process",
    );

    // A still sees their own, on their own request.
    const mine = (await app.inject({ method: "GET", url: "/api/settings", headers: A })).json() as {
      enforcing: { maxDiscountPct: number };
    };
    assert.equal(mine.enforcing.maxDiscountPct, 3, "the seller lost their own setting");
    await app.inject({ method: "POST", url: "/api/settings/reset", headers: A });
  });

  test("a settings read that fails guards with the defaults, not with what the process last held", async () => {
    // The state the old code manufactured: a process default that is some
    // other account's policy.
    setPolicy({ ...DEFAULT_POLICY, maxDiscountPct: 99, neverSay: [{ pattern: "someone-elses-rule", why: "theirs" }] });
    const got = await new Promise<{ max: number; rules: string[] }>((resolve) => {
      runInPolicyScope(
        () => Promise.reject(new Error("connection terminated unexpectedly")),
        // `done` — the rest of the request lifecycle, running in whatever
        // scope the hook managed to enter.
        () => resolve({ max: policy().maxDiscountPct, rules: policy().neverSay.map((r) => r.pattern) }),
      );
    });
    assert.equal(got.max, DEFAULT_POLICY.maxDiscountPct, "guarded at another account's discount ceiling");
    assert.ok(!got.rules.includes("someone-elses-rule"), "fell back to another account's rules");
    assert.equal(policyScope.getStore(), undefined, "the scope leaked out of the request");
    setPolicy(null);
  });
});
