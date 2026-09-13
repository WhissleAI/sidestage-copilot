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
import { get } from "node:http";

let app: FastifyInstance;
let ctx: AppContext;

before(async () => {
  ({ app, ctx } = await buildApp());
  await ctx.shows.ensureDemo();
});

after(async () => {
  // Both, in this order. Closing the HTTP server leaves the show runtimes and
  // their poll timers alive, which holds the event loop open and makes a suite
  // that has already passed look like it hung.
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
      headers: BODYLESS_JSON,
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
      headers: BODYLESS_JSON,
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
      headers: { "content-type": "application/json" },
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
      headers: { "content-type": "application/json" },
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
      headers: BODYLESS_JSON,
    });
    assert.equal(r.statusCode, 404);
  });

  test("POST /api/research answers with a card inside the latency budget", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/research",
      headers: { "content-type": "application/json" },
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
    const snap = ctx.shows.get().snapshot() as { listings: { id: string; state: string }[] };
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
