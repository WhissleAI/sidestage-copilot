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
import { get } from "node:http";

let app: FastifyInstance;
let ctx: AppContext;
/** A seller session. Every command route requires one. */
let auth: Record<string, string>;

before(async () => {
  ({ app, ctx } = await buildApp());
  await ctx.shows.ensureDemo();

  const guest = (await app.inject({ method: "POST", url: "/api/auth/guest" })).json();
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

/** What the browser sends for `fetch(url, { method: "POST" })` with no body:
 *  many clients still attach the JSON content-type. */
const BODYLESS_JSON = { "content-type": "application/json" };

describe("the seam that broke", () => {
  test("a bodyless POST declaring JSON is not a 400", async () => {
    // The regression test for F-02. Every command route is bodyless, so this
    // one property decides whether the console's buttons work at all.
    const r = await app.inject({
      method: "POST",
      url: "/api/catalogs/reload",
      headers: { ...BODYLESS_JSON, ...auth },
    });
    assert.notEqual(r.statusCode, 400, `bodyless JSON POST returned ${r.statusCode}: ${r.body}`);
  });

  test("a bodyless POST with no content-type is also fine", async () => {
    const r = await app.inject({ method: "POST", url: "/api/catalogs/reload" });
    assert.notEqual(r.statusCode, 400);
  });

  test("a genuinely malformed JSON body is still rejected", async () => {
    // The parser is permissive about EMPTY, not about broken. Losing that
    // distinction would turn a client bug into a silent no-op.
    const r = await app.inject({
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
    const r = await app.inject({ method: "GET", url: "/health" });
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.equal(b.ok, true);
    assert.equal(typeof b.llm, "string");
    assert.ok(Array.isArray(b.shows));
  });

  test("GET /api/show carries the fields the top bar reads", async () => {
    const r = await app.inject({ method: "GET", url: "/api/show" });
    assert.equal(r.statusCode, 200);
    const s = r.json();
    for (const k of ["id", "title", "viewers", "autonomyLevel", "startedAt", "source"]) {
      assert.ok(k in s, `show is missing ${k}`);
    }
  });

  test("GET /api/listings returns listings with the version the guards need", async () => {
    const r = await app.inject({ method: "GET", url: "/api/listings" });
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
    const r = await app.inject({ method: "GET", url: "/api/metrics" });
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
    const r = await app.inject({ method: "GET", url: "/api/audit/verify" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().ok, true);
  });

  test("an unknown showId 404s instead of silently serving the demo", async () => {
    // Serving a different show's data under a wrong id is a tenancy leak, not
    // a convenience.
    const r = await app.inject({ method: "GET", url: "/api/show?showId=show_does_not_exist" });
    assert.equal(r.statusCode, 404);
  });
});

describe("commands", () => {
  test("POST /api/chat/inject admits a message and reports the classification", async () => {
    const r = await app.inject({
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
    const r = await app.inject({
      method: "POST",
      url: "/api/autonomy",
      headers: { "content-type": "application/json", ...auth },
      payload: { level: "L2_ONE_TAP" },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().autonomyLevel, "L2_ONE_TAP");

    const back = await app.inject({ method: "GET", url: "/api/show" });
    assert.equal(back.json().autonomyLevel, "L2_ONE_TAP");
  });

  test("an unknown proposal id 404s rather than 500s", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/proposals/does_not_exist/send",
      headers: { ...BODYLESS_JSON, ...auth },
    });
    assert.equal(r.statusCode, 404);
  });

  test("POST /api/research answers with a card inside the latency budget", async () => {
    const r = await app.inject({
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
  test("a guest may read the show", async () => {
    const guest = (await app.inject({ method: "POST", url: "/api/auth/guest" })).json();
    const r = await app.inject({
      method: "GET", url: "/api/show", headers: { authorization: `Bearer ${guest.token}` },
    });
    assert.equal(r.statusCode, 200);
  });

  test("a guest may NOT send a reply", async () => {
    // The read-only rung below L1 Suggest. A console opened by someone who is
    // not the seller can watch the copilot work and change nothing.
    const guest = (await app.inject({ method: "POST", url: "/api/auth/guest" })).json();
    const r = await app.inject({
      method: "POST", url: "/api/proposals/anything/send",
      headers: { authorization: `Bearer ${guest.token}`, ...BODYLESS_JSON },
    });
    assert.equal(r.statusCode, 403);
    assert.match(r.json().error, /guest/);
  });

  test("no session at all is refused, and says how to get one", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/actions/anything/approve", headers: BODYLESS_JSON,
    });
    assert.equal(r.statusCode, 403);
    assert.match(r.json().error, /no session/);
  });

  test("an unknown token is not a session", async () => {
    const r = await app.inject({
      method: "GET", url: "/api/auth/me", headers: { authorization: "Bearer sst_nope" },
    });
    assert.equal(r.json().account, null);
  });

  test("claiming the console promotes the guest to seller", async () => {
    const guest = (await app.inject({ method: "POST", url: "/api/auth/guest" })).json();
    assert.equal(guest.account.kind, "guest");
    const claimed = await app.inject({
      method: "POST", url: "/api/auth/claim",
      headers: { authorization: `Bearer ${guest.token}`, "content-type": "application/json" },
      payload: { displayName: "Rae" },
    });
    assert.equal(claimed.json().account.kind, "seller");
    assert.equal(claimed.json().account.displayName, "Rae");
  });
});

describe("settings change what the guards enforce", () => {
  test("a save re-arms Layer B in this process", async () => {
    // The point of the settings surface: editing it changes what the NEXT
    // reply is checked against, not just what a form displays.
    const before = (await app.inject({ method: "GET", url: "/api/settings", headers: auth })).json();
    assert.equal(before.policy.maxDiscountPct, 15);

    const saved = await app.inject({
      method: "PUT", url: "/api/settings",
      headers: { ...auth, "content-type": "application/json" },
      payload: { maxDiscountPct: 7 },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().policy.maxDiscountPct, 7);
    // Layer B is the live module, not a copy of the response body.
    assert.equal(policy().maxDiscountPct, 7);

    await app.inject({ method: "POST", url: "/api/settings/reset", headers: auth });
    assert.equal(policy().maxDiscountPct, 15);
  });

  test("a regex that does not compile is refused, not stored", async () => {
    // `neverSayMatchers` compiles these with `new RegExp`, and a guard that
    // THROWS returns block (chain.ts) — so an unvalidated bad pattern would
    // silently block every reply until someone read the logs.
    const r = await app.inject({
      method: "PUT", url: "/api/settings",
      headers: { ...auth, "content-type": "application/json" },
      payload: { neverSay: [{ pattern: "a(b", regex: true, why: "broken" }] },
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /not valid regular expressions/);
    assert.equal(policy().neverSay.length, DEFAULT_POLICY.neverSay.length);
  });

  test("unknown keys are dropped rather than merged into the policy", async () => {
    const r = await app.inject({
      method: "PUT", url: "/api/settings",
      headers: { ...auth, "content-type": "application/json" },
      payload: { maxDiscountPct: 9, iAmNotASetting: true },
    });
    assert.equal(r.statusCode, 200);
    assert.equal("iAmNotASetting" in r.json().policy, false);
    await app.inject({ method: "POST", url: "/api/settings/reset", headers: auth });
  });

  test("the discount cap is bounded — a typo must not disable a guard", async () => {
    const r = await app.inject({
      method: "PUT", url: "/api/settings",
      headers: { ...auth, "content-type": "application/json" },
      payload: { maxDiscountPct: 900 },
    });
    assert.equal(r.json().policy.maxDiscountPct, 50);
    await app.inject({ method: "POST", url: "/api/settings/reset", headers: auth });
  });

  test("a guest cannot change the guardrails", async () => {
    const guest = (await app.inject({ method: "POST", url: "/api/auth/guest" })).json();
    const r = await app.inject({
      method: "PUT", url: "/api/settings",
      headers: { authorization: `Bearer ${guest.token}`, "content-type": "application/json" },
      payload: { maxDiscountPct: 50 },
    });
    assert.equal(r.statusCode, 403);
  });
});

describe("analytics", () => {
  test("answers the three questions the page asks", async () => {
    const r = await app.inject({ method: "GET", url: "/api/analytics", headers: auth });
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
    const r = await app.inject({
      method: "GET", url: "/api/analytics?showId=nope", headers: auth,
    });
    assert.equal(r.statusCode, 404);
  });
});

describe("deleting a session", () => {
  test("the demo show cannot be deleted", async () => {
    // It is the only show where the write path, the rollback spike and the
    // stale-price walkthrough can be exercised. Losing it to a stray click
    // would take the submission's whole demonstrable core with it.
    const r = await app.inject({
      method: "DELETE", url: "/api/shows/show_ep42", headers: { ...BODYLESS_JSON, ...auth },
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /demo show cannot be deleted/);
  });

  test("an unknown show is a 404, not a silent success", async () => {
    const r = await app.inject({
      method: "DELETE", url: "/api/shows/ebay_nope", headers: { ...BODYLESS_JSON, ...auth },
    });
    assert.equal(r.statusCode, 404);
  });

  test("a guest cannot delete a session", async () => {
    // Deleting a session destroys its agent, its corpus and its whole record.
    // That is the most destructive thing in the app and it is a seller's call.
    const guest = (await app.inject({ method: "POST", url: "/api/auth/guest" })).json();
    const r = await app.inject({
      method: "DELETE", url: "/api/shows/anything",
      headers: { authorization: `Bearer ${guest.token}`, ...BODYLESS_JSON },
    });
    assert.equal(r.statusCode, 403);
  });
});

describe("the SSE envelope", () => {
  test("the stream opens with a hello frame the console can seed state from", async () => {
    // The console REPLACES its state from `hello`, so a missing key there
    // blanks a panel rather than degrading it. Read over a raw socket and hang
    // up on the first frame: an SSE response never ends, so anything that waits
    // for completion waits forever.
    const text = await firstSseFrame("/api/stream");
    assert.match(text, /^event: hello$/m);
    const line = text.split("\n").find((l) => l.startsWith("data: "))!;
    const hello = JSON.parse(line.slice(6));
    for (const k of ["show", "listings", "proposals", "actions", "audit", "metrics"]) {
      assert.ok(k in hello, `hello is missing ${k}`);
    }
  });

  test("ended lots are not shipped in hello", async () => {
    // F-05: a three-hour show accumulates hundreds of closed lots, and an
    // ended lot cannot be sold, pinned, or answered about.
    const r = await app.inject({ method: "GET", url: "/api/listings" });
    const pinned = (await app.inject({ method: "GET", url: "/api/show" })).json().pinnedListingId;
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
