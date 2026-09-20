// Can this system tell you why it stopped answering?
//
// Written against a measured fact: the deployed box produced ELEVEN log lines
// in sixteen hours while serving authenticated traffic and driving a headless
// Chrome. Every runtime fact went to an SSE stream that may have had no browser
// attached, so the sharpest failure in the product — a watcher that gives up
// after twenty reloads and leaves the show looking connected and permanently
// mute — happened, if it happened, without a trace anywhere.
//
// These tests assert the trace exists. Where the trace is a log line and only a
// log line, the test taps the logger rather than asserting on a string
// constant: a test that only checks the wording of a message it also owns is a
// test of nothing.

import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { db, migrate, closeDb } from "../src/db/pg.js";
import { onLog, log, type LogLine } from "../src/obs/log.js";
import { recordEvent, showEvents, useEventStore, resetEventStore } from "../src/obs/events.js";
import { ScrapedPageWatcher, type ScrapeSpec } from "../src/surfaces/scrapeWatcher.js";
import { EbayLiveWatcher } from "../src/ingest/ebaylive/watcher.js";
import { whatnotSpec } from "../src/surfaces/whatnot/scrape.js";

after(async () => {
  resetEventStore();
  await closeDb();
});

/** Collect every line the code under test emits. */
function taped(fn: () => void | Promise<void>): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  const off = onLog((l) => lines.push(l));
  return Promise.resolve(fn()).finally(off).then(() => lines);
}

/** Reach the watchdog without a browser. The give-up branch is pure state —
 *  three counters and a flag — and driving it through the SHIPPED method is
 *  the point: the previous test for this loop re-implemented the dedupe rule
 *  in the test file and asserted against its own copy. */
type Watchdog = {
  reloads: number;
  lastMessageAt: number;
  lastActivityAt: number;
  watchdog(): Promise<void>;
};

describe("a watcher that has stopped trying says so", () => {
  test("the scraped loop gives up loudly, once, and does not claim the room ended", async () => {
    const gaveUp: { reason: string; detail: string; reloads?: number }[] = [];
    const status: { connected: boolean; detail: string }[] = [];
    const ended: string[] = [];

    const w = new ScrapedPageWatcher(
      whatnotSpec as ScrapeSpec,
      { externalId: "room_obs_1" },
      {
        onStatus: (s) => status.push(s),
        onEnded: (why) => ended.push(why),
        onGaveUp: (g) => gaveUp.push(g),
      },
    );

    const p = w as unknown as Watchdog;
    // Twenty reloads spent; chat silent past the socket-dead threshold; the
    // room itself still moving, which is exactly the "mute but connected"
    // state the show sits in.
    p.reloads = 20;
    p.lastMessageAt = Date.now() - 130_000;
    p.lastActivityAt = Date.now() - 1_000;

    await p.watchdog();

    assert.equal(gaveUp.length, 1, "giving up must be announced");
    assert.equal(gaveUp[0]!.reason, "reload-limit");
    assert.equal(gaveUp[0]!.reloads, 20);
    assert.equal(ended.length, 0, "giving up is NOT the room ending — a report must not be written");
    assert.ok(
      status.some((s) => !s.connected && /stopped trying/i.test(s.detail)),
      "the console is told the watcher stopped trying, not left drawing a connected show",
    );

    // Said once. A watchdog that ran every second for the rest of the show
    // would turn one fact into thousands.
    await p.watchdog();
    await p.watchdog();
    assert.equal(gaveUp.length, 1, "the give-up is announced once, not once a tick");
  });

  test("the eBay Live loop gives up the same way", async () => {
    const gaveUp: { reason: string }[] = [];
    const ended: string[] = [];
    const w = new EbayLiveWatcher({
      eventId: "ev_obs_1",
      onEnded: (why) => ended.push(why),
      onGaveUp: (g) => gaveUp.push(g),
    });
    const p = w as unknown as { reloads: number; lastCommentAt: number; lastActivityAt: number; watchdog(): Promise<void> };
    p.reloads = 20;
    p.lastCommentAt = Date.now() - 130_000;
    p.lastActivityAt = Date.now() - 1_000;
    await p.watchdog();
    await p.watchdog();
    assert.deepEqual(gaveUp.map((g) => g.reason), ["reload-limit"]);
    assert.equal(ended.length, 0);
  });
});

describe("what the process says about itself", () => {
  test("a line is structured, and a field whose NAME looks like a secret never carries its value", async () => {
    const lines = await taped(() => {
      log("warn", "test.line", { showId: "show_1", token: "wsk_supersecret", count: 3 });
    });
    const line = lines.find((l) => l.event === "test.line");
    assert.ok(line, "the line was emitted");
    assert.equal(line!.level, "warn");
    assert.equal(line!.showId, "show_1");
    assert.equal(line!.count, 3);
    assert.equal(line!.token, "[redacted]", "a token must never reach an operator's terminal");
    assert.ok(Date.parse(line!.at), "every line is timestamped");
  });

  test("a recorded event is a row an incident can be read from, and a log line at the same moment", async () => {
    const pool = db();
    await migrate(pool);
    useEventStore(pool);
    const showId = `obs_${process.pid.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const lines = await taped(async () => {
      await recordEvent({
        showId,
        kind: "watcher.gave_up",
        level: "error",
        detail: { surface: "whatnot", reason: "reload-limit", reloads: 20 },
      });
    });

    assert.ok(lines.some((l) => l.event === "watcher.gave_up" && l.level === "error"), "it is on stdout now");

    const rows = await showEvents(pool, showId);
    assert.equal(rows.length, 1, "and in Postgres afterwards");
    assert.equal(rows[0]!.kind, "watcher.gave_up");
    assert.equal(rows[0]!.detail.reason, "reload-limit");
    assert.equal(rows[0]!.detail.reloads, 20);

    await pool.query("DELETE FROM session_events WHERE show_id = $1", [showId]);
  });

  test("recording never throws at the caller, even with no store behind it", async () => {
    resetEventStore();
    await recordEvent({ showId: "nobody", kind: "test.nostore" });
    useEventStore(db());
  });
});

// ── the listen session, server-side ─────────────────────────────────────────
//
// Before this, the server knew ONE fact about a listen session: when it
// opened. There was no `listen_ended_at`, no reason and no stall counter, so
// the session cut at exactly 300 seconds was diagnosed by reading another
// system's logs. These tests are the contract that made that answerable here.

import { buildApp } from "../src/api/server.js";
import { DEMO_SHOW_ID } from "../src/shows/registry.js";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../src/api/context.js";

describe("a listen session says how it ended", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let auth: Record<string, string>;

  const post = (kind: string, body: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: `/api/shows/${DEMO_SHOW_ID}/audio/event`,
      headers: { ...auth, "content-type": "application/json" },
      payload: { kind, ...body },
    });

  const row = async () =>
    (
      await db().query<{ listen_started_at: string | null; listen_ended_at: string | null; listen_end_reason: string | null; listen_stalls: number }>(
        "SELECT listen_started_at, listen_ended_at, listen_end_reason, listen_stalls FROM shows WHERE id = $1",
        [DEMO_SHOW_ID],
      )
    ).rows[0]!;

  before(async () => {
    ({ app, ctx } = await buildApp());
    const seller = (
      await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { "content-type": "application/json" },
        payload: { email: `obs${Date.now()}${Math.random().toString(16).slice(2)}@test.local`, password: "password-123", displayName: "obs" },
      })
    ).json();
    auth = { authorization: `Bearer ${seller.token}` };
    await ctx.shows.ensureDemo(seller.account.id);
    useEventStore(db());
  });

  after(async () => {
    await app.close();
    await ctx.stop();
    await db().query("DELETE FROM session_events WHERE show_id = $1", [DEMO_SHOW_ID]).catch(() => {});
  });

  test("a start clears the last session's ending, a stall is counted, and an end is stamped with its reason", async () => {
    assert.equal((await post("started", { detail: "host audio is publishing" })).statusCode, 200);
    let r = await row();
    assert.equal(r.listen_ended_at, null, "a running session has no end time");
    assert.equal(r.listen_stalls, 0);

    assert.equal((await post("stalled", { detail: "transcript stalled 47s", reconnects: 1 })).statusCode, 200);
    assert.equal((await post("stalled", { detail: "transcript stalled 51s", reconnects: 2 })).statusCode, 200);
    r = await row();
    assert.equal(r.listen_stalls, 2, "every stall is counted, not just remembered in a tab");
    assert.equal(r.listen_ended_at, null, "a stall is not an ending — the bridge reconnects through it");

    assert.equal((await post("gave-up", { detail: "reconnect limit reached", reconnects: 5, transcriptFails: 3 })).statusCode, 200);
    r = await row();
    assert.ok(r.listen_ended_at, "the server now knows WHEN listening stopped");
    assert.match(r.listen_end_reason!, /gave-up: reconnect limit reached/, "and WHY");

    // And the whole sequence is readable as a timeline afterwards.
    const events = await showEvents(db(), DEMO_SHOW_ID);
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes("listen.started"));
    assert.ok(kinds.includes("listen.stalled"));
    assert.ok(kinds.includes("listen.gave-up"));
    const gave = events.find((e) => e.kind === "listen.gave-up")!;
    assert.equal(gave.level, "error");
    assert.equal(gave.detail.reconnects, 5);
    assert.equal(gave.detail.transcriptFails, 3);
  });

  test("a kind nobody defined is refused rather than stored", async () => {
    const r = await post("whatever-the-frontend-felt-like");
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /kind must be one of/);
  });

  test("a second session's start makes the row say 'listening' again", async () => {
    await post("ended", { detail: "stopped" });
    assert.ok((await row()).listen_ended_at);
    await post("started", { detail: "restarted" });
    const r = await row();
    assert.equal(r.listen_ended_at, null);
    assert.equal(r.listen_end_reason, null);
    assert.equal(r.listen_stalls, 0, "a new session starts its stall count over");
    await post("ended", { detail: "stopped" });
  });
});

// ── swallowed errors ────────────────────────────────────────────────────────
//
// Seventy-odd sites deliberately continue past a failure, and most of them are
// right to: a failed enrichment must not stop a reply. The defect was never
// the decision to continue — it was that continuing was indistinguishable from
// succeeding, for ever, because nothing logged. A swallowed error WITH a line
// is a decision. Without one it is a blind spot.
//
// The sharpest of them is here: at L4 the copilot commits a listing change
// without asking, and a rejected commit was swallowed outright. The seller was
// told the copilot acts on their behalf, the listing did not change, and
// nothing anywhere said the commit refused.

import { Pipeline } from "../src/pipeline/pipeline.js";

test("an auto-commit that the marketplace refuses is still swallowed — and no longer silent", async () => {
  const approved: string[] = [];
  const stub = {
    repo: {
      showId: "show_autocommit",
      show: async () => ({ autonomyLevel: "L4_AUTO_ACT" }),
    },
    proposer: {
      evaluate: async () => [{
        kind: "adjust_stock", listingId: "lst_1", params: { qty: 2 },
        summary: "stock", rationale: "sold two", dedupeKey: "k1",
      }],
    },
    executor: {
      propose: async () => ({ id: "act_1", status: "proposed", preflight: { ok: true } }),
      approve: async (id: string) => {
        approved.push(id);
        throw new Error("marketplace refused: version conflict");
      },
    },
  };

  // The private loop, driven directly: the branch under test is three lines
  // inside it and the alternative is standing up a whole show to reach them.
  const pipeline = Object.create(Pipeline.prototype) as {
    d: unknown; seenActionKeys: Set<string>; evaluateActions(): Promise<void>;
  };
  pipeline.d = stub;
  pipeline.seenActionKeys = new Set();

  const lines = await taped(() => pipeline.evaluateActions());

  assert.deepEqual(approved, ["act_1"], "the commit was attempted");
  const said = lines.find((l) => l.event === "action.auto_commit_failed");
  assert.ok(said, "a refused auto-commit must leave a line — the seller cannot see this fail");
  assert.equal(said!.level, "warn");
  assert.equal(said!.actionId, "act_1");
  assert.match(String(said!.err), /version conflict/);
});
