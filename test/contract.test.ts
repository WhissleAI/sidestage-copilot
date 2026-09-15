// The client/server seam — the one nothing else covers.
//
// Every other suite stops one level below HTTP. That is exactly where the worst
// bug in this project lived: the console sends bodyless commands with a default
// `content-type: application/json` header, Fastify's stock parser called an
// empty body malformed, and every command button — regenerate, dismiss, approve,
// reject, rollback, detach — returned 400 and silently did nothing. Fifty-three
// green tests, a broken app.
//
// So these tests issue REAL requests through the REAL routing table, with the
// headers a browser actually sends, and assert the envelope the console parses.
// `app.inject` exercises parsers, serializers and error handling without a
// socket, which keeps the suite key-free and fast.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import type { AppContext } from "../src/api/context.js";
import { policy, DEFAULT_POLICY, setPolicy } from "../src/guardrails/policy.js";
import { BudgetWatch, isOverBudget, setBudgetWatch } from "../src/llm/budget.js";
import { db as pgPool } from "../src/db/pg.js";
import { seed } from "../src/db/seed.js";
import { spendWindow, type WhissleBilling } from "../src/llm/billing.js";
import { get } from "node:http";

let app: FastifyInstance;
let ctx: AppContext;
/** A seller session. Every command route requires one. */
let auth: Record<string, string>;

before(async () => {
  ({ app, ctx } = await buildApp());
  await ctx.shows.ensureDemo();

  const guest = (await app.inject({ method: "POST", url: "/api/auth/register", headers: { "content-type": "application/json" }, payload: { email: `t${Date.now()}${Math.random().toString(16).slice(2)}@test.local`, password: "password-123", displayName: "test" } })).json();
  const bearer = { authorization: `Bearer ${guest.token}` };
  await app.inject({
    method: "POST", url: "/api/auth/claim", headers: { ...bearer, "content-type": "application/json" },
    payload: { displayName: "contract-suite" },
  });
  auth = bearer;
});

after(async () => {
  // Both, in this order. Closing the HTTP server leaves the show runtimes and
  // their poll timers alive, which holds the event loop open and makes a suite
  // that has already passed look like it hung.
  // Leave the module policy as we found it: it is process-wide state and a
  // later suite in the same run would otherwise inherit a test's edit.
  setPolicy(null);
  await app.close();
  await ctx.stop();
});

/** `app.inject` with the suite's session attached. Every route needs one now;
 *  the two tests about having NO session call `app.inject` directly. */
const inject = (o: { method: string; url: string; headers?: Record<string, string>; payload?: unknown }) =>
  app.inject({ ...o, headers: { ...auth, ...(o.headers ?? {}) } } as never);

/** What the browser sends for `fetch(url, { method: "POST" })` with no body:
 *  many clients still attach the JSON content-type. */
const BODYLESS_JSON = { "content-type": "application/json" };

describe("the seam that broke", () => {
  test("a bodyless POST declaring JSON is not a 400", async () => {
    // The regression test for F-02. Every command route is bodyless, so this
    // one property decides whether the console's buttons work at all.
    const r = await inject({
      method: "POST",
      url: "/api/catalogs/reload",
      headers: { ...BODYLESS_JSON, ...auth },
    });
    assert.notEqual(r.statusCode, 400, `bodyless JSON POST returned ${r.statusCode}: ${r.body}`);
  });

  test("a bodyless POST with no content-type is also fine", async () => {
    const r = await inject({ method: "POST", url: "/api/catalogs/reload" });
    assert.notEqual(r.statusCode, 400);
  });

  test("a genuinely malformed JSON body is still rejected", async () => {
    // The parser is permissive about EMPTY, not about broken. Losing that
    // distinction would turn a client bug into a silent no-op.
    const r = await inject({
      method: "POST",
      url: "/api/autonomy",
      headers: { ...BODYLESS_JSON, ...auth },
      payload: "{not json",
    });
    assert.equal(r.statusCode, 400);
  });
});

describe("read routes answer the shape the console destructures", () => {
  test("GET /health", async () => {
    const r = await inject({ method: "GET", url: "/health" });
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.equal(b.ok, true);
    assert.equal(typeof b.llm, "string");
    assert.ok(Array.isArray(b.shows));
  });

  test("GET /api/show carries the fields the top bar reads", async () => {
    const r = await inject({ method: "GET", url: "/api/show" });
    assert.equal(r.statusCode, 200);
    const s = r.json();
    for (const k of ["id", "title", "viewers", "autonomyLevel", "startedAt", "source"]) {
      assert.ok(k in s, `show is missing ${k}`);
    }
  });

  test("GET /api/listings returns listings with the version the guards need", async () => {
    const r = await inject({ method: "GET", url: "/api/listings" });
    assert.equal(r.statusCode, 200);
    const rows = r.json();
    assert.ok(Array.isArray(rows) && rows.length > 0);
    for (const k of ["id", "title", "priceCents", "qty", "version", "state"]) {
      assert.ok(k in rows[0], `listing is missing ${k}`);
    }
    // Money crosses the wire as integer cents. A float here means a rounding
    // bug somewhere downstream in a guard that compares amounts exactly.
    assert.equal(Number.isInteger(rows[0].priceCents), true);
  });

  test("GET /api/metrics matches the Metrics contract", async () => {
    const r = await inject({ method: "GET", url: "/api/metrics" });
    assert.equal(r.statusCode, 200);
    const m = r.json();
    for (const k of ["proposals", "sent", "blocked", "guardBlocks", "latency", "cacheHitRate"]) {
      assert.ok(k in m, `metrics is missing ${k}`);
    }
    for (const k of ["p50", "p95", "p99", "budgetMs", "breaches"]) {
      assert.ok(k in m.latency, `metrics.latency is missing ${k}`);
    }
  });

  test("GET /api/audit/verify reports an intact chain", async () => {
    const r = await inject({ method: "GET", url: "/api/audit/verify" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().ok, true);
  });

  test("an unknown showId 404s instead of silently serving the demo", async () => {
    // Serving a different show's data under a wrong id is a tenancy leak, not
    // a convenience.
    const r = await inject({ method: "GET", url: "/api/show?showId=show_does_not_exist" });
    assert.equal(r.statusCode, 404);
  });
});

describe("commands", () => {
  test("POST /api/chat/inject admits a message and reports the classification", async () => {
    const r = await inject({
      method: "POST",
      url: "/api/chat/inject",
      headers: { "content-type": "application/json", ...auth },
      payload: { author: "contract-test", text: "how much is the pinned one" },
    });
    assert.equal(r.statusCode, 200);
    const m = r.json();
    assert.equal(m.author, "contract-test");
    assert.equal(typeof m.intent, "string");
    assert.equal(typeof m.admitted, "boolean");
  });

  test("POST /api/autonomy round-trips the level", async () => {
    const r = await inject({
      method: "POST",
      url: "/api/autonomy",
      headers: { "content-type": "application/json", ...auth },
      payload: { level: "L2_ONE_TAP" },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().autonomyLevel, "L2_ONE_TAP");

    const back = await inject({ method: "GET", url: "/api/show" });
    assert.equal(back.json().autonomyLevel, "L2_ONE_TAP");
  });

  test("an unknown proposal id 404s rather than 500s", async () => {
    const r = await inject({
      method: "POST",
      url: "/api/proposals/does_not_exist/send",
      headers: { ...BODYLESS_JSON, ...auth },
    });
    assert.equal(r.statusCode, 404);
  });

  test("POST /api/research answers with a card inside the latency budget", async () => {
    const r = await inject({
      method: "POST",
      url: "/api/research",
      headers: { "content-type": "application/json", ...auth },
      payload: { query: "what are these going for" },
    });
    assert.equal(r.statusCode, 200);
    const card = r.json();
    assert.equal(typeof card.headline, "string");
    assert.ok(Array.isArray(card.comps));
    assert.ok(Array.isArray(card.evidence));
    assert.ok(card.latencyMs < 2000, `research took ${card.latencyMs}ms`);
  });
});

describe("who is allowed to act", () => {
  test("no session may not read the show at all", async () => {
    const r = await app.inject({ method: "GET", url: "/api/show" });
    assert.equal(r.statusCode, 401);
    assert.match(r.json().error, /sign in/);
  });

  test("a registered seller is an operator from the first request", async () => {
    const me = (await inject({ method: "POST", url: "/api/auth/register", headers: { "content-type": "application/json" }, payload: { email: `t${Date.now()}${Math.random().toString(16).slice(2)}@test.local`, password: "password-123", displayName: "Rae" } })).json();
    assert.equal(me.account.kind, "seller");
    assert.equal(me.account.displayName, "Rae");
    const who = await inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${me.token}` } });
    assert.equal(who.json().account.id, me.account.id);
  });

  test("a wrong password and an unknown email get the same sentence", async () => {
    const email = `t${Date.now()}x@test.local`;
    await inject({ method: "POST", url: "/api/auth/register", headers: { "content-type": "application/json" }, payload: { email, password: "password-123", displayName: "x" } });
    const bad = await inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" }, payload: { email, password: "nope-nope-nope" } });
    const none = await inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" }, payload: { email: "nobody@test.local", password: "password-123" } });
    assert.equal(bad.statusCode, 401);
    assert.equal(none.statusCode, 401);
    assert.equal(bad.json().error, none.json().error);
    const dup = await inject({ method: "POST", url: "/api/auth/register", headers: { "content-type": "application/json" }, payload: { email, password: "password-123", displayName: "x" } });
    assert.equal(dup.statusCode, 409);
    const ok = await inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" }, payload: { email, password: "password-123" } });
    assert.equal(ok.statusCode, 200);
    const out = await inject({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${ok.json().token}` } });
    assert.equal(out.statusCode, 200);
    const after = await app.inject({ method: "GET", url: "/api/show", headers: { authorization: `Bearer ${ok.json().token}` } });
    assert.equal(after.statusCode, 401);
  });

  test("flagging a sent reply wrong is a write, and lands in the audit chain", async () => {
    // The PRD's one unmeasurable metric. The operator is the only source it
    // has, so the control has to be guarded like any other write and recorded
    // like any other decision.
    const refused = await app.inject({
      method: "POST", url: "/api/proposals/prop_nope/flag",
      headers: { "content-type": "application/json" },
      payload: { reason: "wrong fact" },
    });
    assert.equal(refused.statusCode, 401);

    const missing = await inject({
      method: "POST", url: "/api/proposals/prop_nope/flag",
      headers: { ...auth, "content-type": "application/json" },
      payload: { reason: "wrong fact" },
    });
    assert.equal(missing.statusCode, 404);
  });

  test("a dry run answers without sending anything", async () => {
    const r = await inject({
      method: "POST", url: "/api/dry-run",
      headers: { ...auth, "content-type": "application/json" },
      payload: { question: "does it ship to canada" },
    });
    // Either it answered, or there is no LLM key in this environment — both are
    // fine; what must never happen is a proposal appearing in the queue.
    const before = (await inject({ method: "GET", url: "/api/proposals", headers: auth })).json();
    assert.ok([200, 404, 502, 500].includes(r.statusCode));
    const after = (await inject({ method: "GET", url: "/api/proposals", headers: auth })).json();
    assert.equal(after.length, before.length);
  });

  test("naming a lot needs a seller and an actual name", async () => {
    const blank = await inject({
      method: "POST", url: "/api/listings/lst_aj1_chi_10/name",
      headers: { ...auth, "content-type": "application/json" },
      payload: { title: "  " },
    });
    assert.equal(blank.statusCode, 400);

    const refused = await app.inject({
      method: "POST", url: "/api/listings/lst_aj1_chi_10/name",
      headers: { "content-type": "application/json" },
      payload: { title: "Air Jordan 1 Chicago, 10" },
    });
    assert.equal(refused.statusCode, 401);
  });

  test("the shows list survives a session whose report never generated", async () => {
    // Report generation is fire-and-forget at session close, so a list built
    // from `show_reports` made exactly the show you most want to look at
    // disappear. It is built from `shows` now, left-joined.
    const r = await inject({ method: "GET", url: "/api/reports?limit=5", headers: auth });
    assert.equal(r.statusCode, 200);
    const rows = r.json();
    assert.ok(Array.isArray(rows));
    for (const row of rows) {
      assert.equal(typeof row.showId, "string");
      assert.equal(typeof row.hasReport, "boolean");
      // A row without a report reports null, not a confident zero.
      if (!row.hasReport) assert.equal(row.answered, null);
    }
  });

  test("cost reports calls and dollars as different kinds of number", async () => {
    const r = await inject({ method: "GET", url: "/api/cost?days=30", headers: auth });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(typeof body.totals.calls, "number");
    assert.ok("showsWithoutWallet" in body.totals);
    assert.match(body.attribution.note, /upper bound/i);
  });

  test("nobody without a session may move the autonomy rung", async () => {
    // The most consequential write in the product: L3 lets the copilot answer a
    // buyer with nobody watching. It was the one write with no guard on it, so
    // anyone holding no session could switch a live show to auto-reply.
    const r = await app.inject({
      method: "POST", url: "/api/autonomy",
      headers: { "content-type": "application/json" },
      payload: { level: "L3_AUTO_REPLY" },
    });
    assert.equal(r.statusCode, 401);
    assert.match(r.json().error, /sign in/);
  });

  test("a seller may move the autonomy rung", async () => {
    const r = await inject({
      method: "POST", url: "/api/autonomy",
      headers: { ...auth, "content-type": "application/json" },
      payload: { level: "L2_ONE_TAP" },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().autonomyLevel, "L2_ONE_TAP");
  });

  test("no session at all is refused, and says how to get one", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/actions/anything/approve", headers: BODYLESS_JSON,
    });
    assert.equal(r.statusCode, 401);
    assert.match(r.json().error, /sign in/);
  });

  test("an unknown token is not a session", async () => {
    const r = await app.inject({
      method: "GET", url: "/api/auth/me", headers: { authorization: "Bearer sst_nope" },
    });
    assert.equal(r.statusCode, 401);
  });

});

describe("settings change what the guards enforce", () => {
  test("a save re-arms Layer B in this process", async () => {
    // The point of the settings surface: editing it changes what the NEXT
    // reply is checked against, not just what a form displays.
    const before = (await inject({ method: "GET", url: "/api/settings", headers: auth })).json();
    assert.equal(before.policy.maxDiscountPct, 15);

    const saved = await inject({
      method: "PUT", url: "/api/settings",
      headers: { ...auth, "content-type": "application/json" },
      payload: { maxDiscountPct: 7 },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().policy.maxDiscountPct, 7);
    // Layer B is the live module, not a copy of the response body.
    assert.equal(policy().maxDiscountPct, 7);

    await inject({ method: "POST", url: "/api/settings/reset", headers: auth });
    assert.equal(policy().maxDiscountPct, 15);
  });

  test("a regex that does not compile is refused, not stored", async () => {
    // `neverSayMatchers` compiles these with `new RegExp`, and a guard that
    // THROWS returns block (chain.ts) — so an unvalidated bad pattern would
    // silently block every reply until someone read the logs.
    const r = await inject({
      method: "PUT", url: "/api/settings",
      headers: { ...auth, "content-type": "application/json" },
      payload: { neverSay: [{ pattern: "a(b", regex: true, why: "broken" }] },
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /not valid regular expressions/);
    assert.equal(policy().neverSay.length, DEFAULT_POLICY.neverSay.length);
  });

  test("unknown keys are dropped rather than merged into the policy", async () => {
    const r = await inject({
      method: "PUT", url: "/api/settings",
      headers: { ...auth, "content-type": "application/json" },
      payload: { maxDiscountPct: 9, iAmNotASetting: true },
    });
    assert.equal(r.statusCode, 200);
    assert.equal("iAmNotASetting" in r.json().policy, false);
    await inject({ method: "POST", url: "/api/settings/reset", headers: auth });
  });

  test("the discount cap is bounded — a typo must not disable a guard", async () => {
    const r = await inject({
      method: "PUT", url: "/api/settings",
      headers: { ...auth, "content-type": "application/json" },
      payload: { maxDiscountPct: 900 },
    });
    assert.equal(r.json().policy.maxDiscountPct, 50);
    await inject({ method: "POST", url: "/api/settings/reset", headers: auth });
  });

  test("nobody without a session can change the guardrails", async () => {
    const r = await app.inject({
      method: "PUT", url: "/api/settings", headers: { "content-type": "application/json" },
      payload: { maxDiscountPct: 1 },
    });
    assert.equal(r.statusCode, 401);
  });
});

describe("analytics", () => {
  test("answers the three questions the page asks", async () => {
    const r = await inject({ method: "GET", url: "/api/analytics", headers: auth });
    assert.equal(r.statusCode, 200);
    const a = r.json();
    // did it help
    for (const k of ["answeredRate", "latency", "cacheHitRate", "guardBlocks"]) {
      assert.ok(k in a.copilot, `copilot is missing ${k}`);
    }
    // can I trust it — chain integrity travels WITH the metrics, not beside them
    assert.equal(typeof a.copilot.auditChain.ok, "boolean");
    assert.equal(typeof a.copilot.auditChain.height, "number");
    // the documented asymmetry, as a number a reviewer can check
    assert.ok(a.policy.armedOnAgent <= a.policy.neverSayRules);
    // what it costs
    assert.ok("meter" in a.cost);
  });

  test("an unknown showId 404s", async () => {
    const r = await inject({
      method: "GET", url: "/api/analytics?showId=nope", headers: auth,
    });
    assert.equal(r.statusCode, 404);
  });
});

describe("deleting a session", () => {
  test("the seeded show deletes like any other — it used to be exempt", async () => {
    // It was refused by show id, so the one session a seller could not get rid
    // of was the fake one. A simulated show is a fixture, not a fixture of the
    // product: if it is listed, it is deletable.
    const r = await inject({
      method: "DELETE", url: "/api/shows/show_ep42", headers: { ...BODYLESS_JSON, ...auth },
    });
    assert.equal(r.statusCode, 200);
    const gone = await pgPool().query("SELECT 1 FROM shows WHERE id = $1", ["show_ep42"]);
    assert.equal(gone.rows.length, 0, "the row survived the delete");

    // Put it back: the rest of this file runs against it, and a test that
    // leaves the fixture destroyed is a test that only passes first.
    await seed(pgPool());
    await ctx.shows.ensureDemo();
  });

  test("an unknown show is a 404, not a silent success", async () => {
    const r = await inject({
      method: "DELETE", url: "/api/shows/ebay_nope", headers: { ...BODYLESS_JSON, ...auth },
    });
    assert.equal(r.statusCode, 404);
  });

  test("nobody without a session can delete a session", async () => {
    const showId = ctx.shows.get().showId;
    const r = await app.inject({ method: "DELETE", url: `/api/shows/${showId}` });
    assert.equal(r.statusCode, 401);
  });
});

describe("connecting eBay", () => {
  test("consent cannot start without a registered redirect, and says which", async () => {
    // An RuName is registered in eBay's developer portal, not chosen by us. The
    // failure has exactly one fix and the message is that fix.
    const r = await inject({
      method: "POST", url: "/api/ebay/connect", headers: { ...BODYLESS_JSON, ...auth },
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /EBAY_RUNAME/);
  });

  test("a callback nobody started here is refused", async () => {
    // Without pinning `state` to the account that began the flow, a callback
    // arriving at this server could connect an eBay account to whichever
    // session happened to be open.
    const r = await inject({
      method: "GET", url: "/api/ebay/callback?code=abc&state=not-ours",
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.body, /stale or was not started here/);
    assert.ok(!r.body.includes("abc"), "the authorisation code was echoed into the page");
  });

  test("status splits reading from writing, because they fail differently", async () => {
    const r = await inject({ method: "GET", url: "/api/ebay/status", headers: auth });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.ok("browse" in body && "taxonomy" in body, "no read capabilities reported");
    assert.equal(body.soldComps, false, "sold comps must never be claimed");
    assert.equal(body.write.connected, false);
    assert.ok(Array.isArray(body.write.blockers));
  });

  test("a show cannot be armed against eBay without a connection", async () => {
    // The alternative is an operator approving a markdown that fails at the
    // last step — after the audit entry says it was approved.
    const showId = ctx.shows.get().showId;
    const r = await inject({
      method: "POST", url: `/api/shows/${showId}/write-target`,
      headers: { ...auth, "content-type": "application/json" },
      payload: { target: "ebay" },
    });
    assert.equal(r.statusCode, 409);
    assert.match(r.json().error, /no eBay account is connected|owner account/);
  });

  test("and writes stay on the mock, which the show says out loud", async () => {
    const shows = (await inject({ method: "GET", url: "/api/shows" })).json();
    assert.equal(shows[0].writeTarget, "mock");
  });

  test("importing without a connection is a 409, not an empty catalog", async () => {
    const r = await inject({
      method: "POST", url: "/api/ebay/import",
      headers: { ...auth, "content-type": "application/json" },
      payload: {},
    });
    assert.equal(r.statusCode, 409);
  });
});

describe("closing a gap", () => {
  test("an answer written to the catalog grounds the live show immediately", async () => {
    // The report has listed unanswered questions since it was written and there
    // was nothing to do about one except edit JSON by hand. This is the loop
    // closing: gap → answer → grounding, on this show and on the next one.
    const showId = ctx.shows.get().showId;
    const question = `do you ship to iceland ${Date.now()}`;
    const r = await inject({
      method: "POST", url: "/api/catalogs/kicksbyrae/qa",
      headers: { ...auth, "content-type": "application/json" },
      payload: { question, answer: "Yes — Iceland ships DHL at cost, 5–7 days.", showId },
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.appliedLive, true, "the live show was not re-grounded");

    const rows = await ctx.shows.get().repo.qa();
    assert.ok(rows.some((q) => q.question === question), "the answer never reached the show");

    // And it is on disk for the next show.
    const again = await inject({
      method: "POST", url: "/api/catalogs/kicksbyrae/qa",
      headers: { ...auth, "content-type": "application/json" },
      payload: { question, answer: "Yes — Iceland ships DHL at cost, 5–7 days.", showId },
    });
    assert.equal(again.json().qa.id, body.qa.id, "the same question made a second entry");
  });

  test("a catalog that does not exist is a 404, not a silent success", async () => {
    const r = await inject({
      method: "POST", url: "/api/catalogs/not-a-catalog/qa",
      headers: { ...auth, "content-type": "application/json" },
      payload: { question: "q", answer: "a" },
    });
    assert.equal(r.statusCode, 404);
  });

  test("an answer with no question is refused", async () => {
    const r = await inject({
      method: "POST", url: "/api/catalogs/kicksbyrae/qa",
      headers: { ...auth, "content-type": "application/json" },
      payload: { answer: "yes" },
    });
    assert.equal(r.statusCode, 400);
  });
});

describe("the spend cap", () => {
  test("a show that reaches its cap stops drafting, and the message says why", async () => {
    // The cap was settable and enforced by nothing. This is the whole point of
    // it: past the limit the copilot does not draft, the question still arrives,
    // and the reason travels on the message rather than living in a log.
    const showId = ctx.shows.get().showId;
    // Opening balance $10, wallet now $0 → a $10 upper bound against a $1 cap.
    spendWindow.open(showId, 10);
    const watch = new BudgetWatch(
      { wallet: async () => ({ ok: true, value: { balanceUsd: 0 } }) } as unknown as WhissleBilling,
      () => ({ perShowCapUsd: 1, warnBalanceUsd: 5 }),
      async () => [showId],
    );
    setBudgetWatch(watch);
    try {
      await watch.checkNow();
      assert.equal(isOverBudget(showId), true, "the cap did not latch");

      const r = await inject({
        method: "POST", url: "/api/chat/inject",
        headers: { ...auth, "content-type": "application/json" },
        payload: { author: "budget_probe", text: "how much is the pinned lot?" },
      });
      assert.equal(r.statusCode, 200);
      const msg = r.json();
      assert.equal(msg.admitted, false, "a capped show still admitted a message for drafting");
      assert.match(msg.dropReason, /spend cap/);

      const state = (await inject({ method: "GET", url: "/api/budget" })).json();
      assert.equal(state.capped, true);
      assert.equal(state.capUsd, 1);
    } finally {
      setBudgetWatch(null);
      spendWindow.close(showId);
    }
  });

  test("with nothing watching, nothing is capped", async () => {
    // The fallback matters: a deployment without billing scope must not behave
    // as though every show were out of money.
    assert.equal(isOverBudget(ctx.shows.get().showId), false);
  });
});

describe("sellers you follow", () => {
  test("a handle is stored normalised, so @KicksByRae and kicksbyrae are one seller", async () => {
    const add = async (handle: string) =>
      inject({
        method: "POST", url: "/api/following",
        headers: { ...auth, "content-type": "application/json" },
        payload: { handle },
      });
    assert.equal((await add("@KicksByRae ")).statusCode, 200);
    const r = await add("kicksbyrae");
    assert.equal(r.statusCode, 200);
    const { sellers } = r.json();
    assert.equal(sellers.filter((s: { handle: string }) => s.handle === "kicksbyrae").length, 1);
  });

  test("the response says when the grid last answered, not just who is live", async () => {
    // "Off air" and "we could not look" are different facts. Without
    // `checkedAt` the console has no way to tell them apart and would render
    // the second as the first.
    const r = await inject({ method: "GET", url: "/api/following", headers: auth });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.ok("checkedAt" in body, "no checkedAt — the console cannot date the answer");
    assert.ok("checking" in body, "no checking flag — a running read looks like a finished one");
  });

  test("listing a follow never waits on a browser launch", async () => {
    // Discovery drives headless Chromium and takes the better part of a minute.
    // A page load must not pay for it; only "check now" does.
    const t0 = Date.now();
    await inject({ method: "GET", url: "/api/following", headers: auth });
    assert.ok(Date.now() - t0 < 3000, "the follow list blocked on a grid read");
  });

  test("nobody without a session may follow a seller", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/following",
      headers: { "content-type": "application/json" },
      payload: { handle: "someone" },
    });
    assert.equal(r.statusCode, 401);
    assert.match(r.json().error, /sign in/);
  });

  test("unfollowing removes it", async () => {
    const r = await inject({
      method: "DELETE", url: "/api/following/kicksbyrae", headers: auth,
    });
    assert.equal(r.statusCode, 200);
    assert.ok(!r.json().sellers.some((s: { handle: string }) => s.handle === "kicksbyrae"));
  });
});

describe("what a show leaves behind", () => {
  test("the timeline, the record and the export all answer for the demo show", async () => {
    const showId = ctx.shows.get().showId;
    const t = await inject({ method: "GET", url: `/api/shows/${showId}/timeline` });
    assert.equal(t.statusCode, 200);
    for (const k of ["host", "utterances", "frames", "audio"]) assert.ok(k in t.json(), `timeline missing ${k}`);

    const rec = await inject({ method: "GET", url: `/api/shows/${showId}/record` });
    assert.equal(rec.statusCode, 200);
    for (const k of ["chat", "proposals", "actions", "audit"]) assert.ok(Array.isArray(rec.json()[k]), `record missing ${k}`);

    const ex = await inject({ method: "GET", url: `/api/shows/${showId}/export` });
    assert.equal(ex.statusCode, 200);
    assert.match(ex.headers["content-disposition"] as string, /attachment/);
    const body = ex.json();
    assert.equal(body.show.id, showId);
    assert.ok("record" in body && "signals" in body && "report" in body);
  });

  test("an audio chunk is kept under its seq and served back", async () => {
    const showId = ctx.shows.get().showId;
    process.env.SHOW_MEDIA_DIR = ".tmp/test-media";
    const r = await inject({
      method: "POST", url: `/api/shows/${showId}/audio/chunk?seq=7&durationMs=10000`,
      headers: { "content-type": "audio/webm" }, payload: Buffer.from("opusopus"),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().seq, 7);
    const back = await inject({ method: "GET", url: `/api/shows/${showId}/media/audio/7` });
    assert.equal(back.statusCode, 200);
    assert.equal(back.headers["content-type"], "audio/webm");
    assert.equal(back.body, "opusopus");
    const bad = await inject({
      method: "POST", url: `/api/shows/${showId}/audio/chunk?seq=-1&durationMs=10000`,
      headers: { "content-type": "audio/webm" }, payload: Buffer.from("x"),
    });
    assert.equal(bad.statusCode, 400);
  });

  test("unknown shows 404 on every read", async () => {
    for (const path of ["timeline", "record", "export"]) {
      const r = await inject({ method: "GET", url: `/api/shows/nope/${path}` });
      assert.equal(r.statusCode, 404, path);
    }
  });

  test("analytics breaks the numbers down by topic", async () => {
    const r = await inject({ method: "GET", url: "/api/analytics/overview?days=30", headers: auth });
    assert.equal(r.statusCode, 200);
    assert.ok(Array.isArray(r.json().byIntent));
  });
});

describe("the SSE envelope", () => {
  test("the stream opens with a hello frame the console can seed state from", async () => {
    // The console REPLACES its state from `hello`, so a missing key there
    // blanks a panel rather than degrading it. Read over a raw socket and hang
    // up on the first frame: an SSE response never ends, so anything that waits
    // for completion waits forever.
    const text = await firstSseFrame(`/api/stream?token=${encodeURIComponent(auth.authorization!.slice(7))}`);
    assert.match(text, /^event: hello$/m);
    const line = text.split("\n").find((l) => l.startsWith("data: "))!;
    const hello = JSON.parse(line.slice(6));
    for (const k of ["show", "listings", "chat", "proposals", "actions", "audit", "metrics"]) {
      assert.ok(k in hello, `hello is missing ${k}`);
    }
  });

  test("hello carries the tail of chat, so a console opened mid-show is not blank", async () => {
    // Chat is emitted and forgotten — the runtime holds none of it. Before this
    // the firehose column started empty on every connect and stayed empty until
    // the next buyer typed, which reads as a broken feed rather than a late one.
    const before = (await ctx.shows.get().snapshot()) as unknown as { chat: unknown[] };
    await inject({
      method: "POST",
      url: "/api/chat/inject",
      headers: { ...auth, "content-type": "application/json" },
      payload: { author: "rehydrate_probe", text: "does this come back after a reload?" },
    });
    // The write is fire-and-forget by design: a buyer's question must not wait
    // on a database round trip.
    await new Promise((r) => setTimeout(r, 400));
    const after = (await ctx.shows.get().snapshot()) as unknown as {
      chat: { author: string; text: string }[];
    };
    assert.ok(Array.isArray(after.chat));
    assert.ok(after.chat.length >= before.chat.length);
    assert.ok(
      after.chat.some((m) => m.author === "rehydrate_probe"),
      "the injected comment did not come back in a fresh snapshot",
    );
  });

  test("ended lots are not shipped in hello", async () => {
    // F-05: a three-hour show accumulates hundreds of closed lots, and an
    // ended lot cannot be sold, pinned, or answered about.
    const r = await inject({ method: "GET", url: "/api/listings" });
    const pinned = (await inject({ method: "GET", url: "/api/show" })).json().pinnedListingId;
    const snap = (await ctx.shows.get().snapshot()) as unknown as { listings: { id: string; state: string }[] };
    for (const l of snap.listings) {
      assert.ok(l.state !== "ended" || l.id === pinned, `hello carried ended lot ${l.id}`);
    }
    assert.ok(Array.isArray(r.json()));
  });
});

/** The SSE test needs a real socket; everything else uses inject. */
let port = 0;
async function listen(): Promise<number> {
  if (!port) {
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
  }
  return port;
}

/** First SSE frame, then hang up. Raw http rather than fetch: a streaming body
 *  read through fetch buffers here and never yields the first chunk. */
async function firstSseFrame(path: string): Promise<string> {
  const p = await listen();
  return new Promise<string>((resolve, reject) => {
    const req = get(
      { host: "127.0.0.1", port: p, path, headers: { accept: "text/event-stream" } },
      (res) => {
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (chunk: string) => {
          buf += chunk;
          if (buf.includes("\n\n")) {
            res.destroy();
            req.destroy();
            resolve(buf);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("no SSE frame within 5s"));
    });
  });
}
