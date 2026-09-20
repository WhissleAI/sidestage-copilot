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

import { test, describe, after } from "node:test";
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
