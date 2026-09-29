// "Listening to chat. Proposals appear here." — with a hundred messages on the page.
//
// Reported live on 2026-09-29: an eBay Live session, 111 viewers, the pinned lot
// ticking from $3 to $12, and an empty chat panel. `session_events` from that
// session says exactly what happened:
//
//   16:52:23  surface.connected      attached to C99NAJFehcYoQjpw (100 backlog)
//   16:54:19  surface.disconnected   chat silent 121s while the show is active —
//                                    reloading the feed (1/20)
//
// A hundred messages read, none shown. `start()` marked the backlog `seen` and
// stopped there, so the operator attached mid-show and watched an empty room.
//
// The fix already existed. `surfaces/scrapeWatcher.ts` carries it, and its comment
// names the report it came from — "a live eBay Live session, 99 viewers, 24
// minutes, and nothing under it". It went to the Whatnot/TikTok watcher and never
// to the eBay Live one the report was about.
//
// Worse on the reload paths: a reload happens BECAUSE chat went quiet, so whatever
// arrived in the meantime is exactly what is on screen — and both paths dropped it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EbayLiveWatcher, type LiveComment } from "../src/ingest/ebaylive/watcher.js";

/** Reach `absorb` without a browser: it is the whole decision under test. */
type Absorbs = { absorb(c: LiveComment[]): void; seen: Set<string> };

const room = (n: number): LiveComment[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, author: `buyer${i}`, text: `is lot ${i} still on?` }));

describe("attaching mid-show shows the room", () => {
  test("the backlog reaches the operator", () => {
    const seen: LiveComment[] = [];
    const w = new EbayLiveWatcher({ eventId: "ev_backlog", onComment: (c) => seen.push(c) });
    (w as unknown as Absorbs).absorb(room(100));
    assert.ok(seen.length > 0, "a hundred messages were read and none were shown — the reported bug");
    assert.equal(seen.length, 40, "the tail of it, not an hour of replay");
  });

  test("and is marked historic, so it is shown and never answered", () => {
    // The distinction that makes showing it safe: the pipeline skips the rate
    // gate and the draft for a historic message.
    const seen: LiveComment[] = [];
    const w = new EbayLiveWatcher({ eventId: "ev_hist", onComment: (c) => seen.push(c) });
    (w as unknown as Absorbs).absorb(room(3));
    assert.deepEqual(seen.map((c) => c.historic), [true, true, true]);
  });

  test("every one of them is still marked seen, so the next tick does not replay it", () => {
    const seen: LiveComment[] = [];
    const w = new EbayLiveWatcher({ eventId: "ev_seen", onComment: (c) => seen.push(c) });
    const backlog = room(100);
    (w as unknown as Absorbs).absorb(backlog);
    // All hundred, not just the forty shown — otherwise the sixty above the fold
    // arrive as new traffic on the next poll and get drafted against.
    for (const c of backlog) {
      assert.ok((w as unknown as Absorbs).seen.has(c.id), `${c.id} would replay as new`);
    }
  });

  test("the adapter carries `historic` through the rename", () => {
    // `onComment` → `onMessage` is a rename, and a rename that drops a field is
    // how the pipeline would answer an hour-old question.
    const src = readFileSync(
      new URL("../src/surfaces/ebaylive/adapter.ts", import.meta.url).pathname,
      "utf8",
    );
    assert.match(src, /c\.historic \? \{ historic: true \} : \{\}/);
  });

  test("both reload paths show what they find, rather than swallowing it", () => {
    // A reload happens because chat went quiet. Whatever arrived meanwhile is on
    // the page, and dropping it is how every reload lost a room.
    const src = readFileSync(new URL("../src/ingest/ebaylive/watcher.ts", import.meta.url).pathname, "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, (c) => " ".repeat(c.length));
    assert.equal(
      [...code.matchAll(/this\.absorb\(/g)].length,
      3,
      "attach, recoverIfDead and the watchdog reload must all absorb",
    );
    assert.ok(
      !/for \(const c of backlog\.comments\) this\.seen\.add/.test(code),
      "a backlog that is only marked seen is a room the operator cannot see",
    );
  });
});
