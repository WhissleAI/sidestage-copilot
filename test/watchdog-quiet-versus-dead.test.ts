// REVIEW.md F-13: "its central judgement is 'active show + silent chat = dead
// socket', and that discrimination is exactly the kind of thing that rots."
//
// The give-up branch was already covered (observability.test.ts). The
// discrimination itself was not, and it is the part with a cost on both sides:
//
//   too eager   a quiet-but-live room gets reloaded on a timer, which is churn
//               on a headless Chrome this box has already been OOM-killed by
//   too shy     a show whose feed died sits connected and permanently mute
//   WRONG WAY   a live show gets declared over, which closes the session and
//               writes a report about something that is still happening
//
// Driven through the SHIPPED `watchdog()` with the three counters it reads, on
// BOTH watchers, because the two implementations are line-for-line duplicates
// of each other and a fix applied to one has already been the shape of a bug in
// the other.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { closeDb } from "../src/db/pg.js";
import { ScrapedPageWatcher, type ScrapeSpec } from "../src/surfaces/scrapeWatcher.js";
import { EbayLiveWatcher } from "../src/ingest/ebaylive/watcher.js";
import { whatnotSpec } from "../src/surfaces/whatnot/scrape.js";

after(async () => {
  await closeDb();
});

const SEC = 1_000;
const MIN = 60_000;

/** What the watchdog decided, observed rather than re-derived. */
interface Decision {
  reloaded: boolean;
  ended: string[];
  gaveUp: number;
}

/**
 * One tick of a watcher's real watchdog, with chat and room activity aged by
 * hand. `reloads` rising is the reload decision: the attempt itself needs a
 * page and there is none, which the method's own try/catch absorbs.
 */
async function tick(
  which: "ebay" | "scraped",
  ages: { chatQuietMs: number; roomQuietMs: number; reloads?: number },
): Promise<Decision> {
  const ended: string[] = [];
  let gaveUp = 0;
  const now = Date.now();

  const w =
    which === "ebay"
      ? new EbayLiveWatcher({
          eventId: "ev_wd",
          onEnded: (why) => ended.push(why),
          onGaveUp: () => void gaveUp++,
        })
      : new ScrapedPageWatcher(
          whatnotSpec as ScrapeSpec,
          { externalId: "room_wd" },
          { onEnded: (why) => ended.push(why), onGaveUp: () => void gaveUp++ },
        );

  // `lastCommentAt` on the eBay watcher, `lastMessageAt` on the scraped one —
  // the same counter under two names, which is itself why both are tested.
  const p = w as unknown as {
    reloads: number;
    lastCommentAt?: number;
    lastMessageAt?: number;
    lastActivityAt: number;
    watchdog(): Promise<void>;
  };
  p.reloads = ages.reloads ?? 0;
  if (which === "ebay") p.lastCommentAt = now - ages.chatQuietMs;
  else p.lastMessageAt = now - ages.chatQuietMs;
  p.lastActivityAt = now - ages.roomQuietMs;

  const before = p.reloads;
  await p.watchdog();
  return { reloaded: p.reloads > before, ended, gaveUp };
}

for (const which of ["ebay", "scraped"] as const) {
  describe(`${which}: telling a quiet room from a dead socket`, () => {
    test("chat is talking — nothing to do", async () => {
      const d = await tick(which, { chatQuietMs: 10 * SEC, roomQuietMs: 1 * SEC });
      assert.equal(d.reloaded, false, "a live feed must never be reloaded");
      assert.deepEqual(d.ended, []);
    });

    test("chat silent while the room keeps moving — reload", async () => {
      // Past the 120s socket-silence threshold, with activity inside the 90s
      // window that says the room is still going. This is the dead socket.
      const d = await tick(which, { chatQuietMs: 130 * SEC, roomQuietMs: 1 * SEC });
      assert.equal(d.reloaded, true, "a feed that went silent under a live room is the case this exists for");
      assert.deepEqual(d.ended, [], "a dead socket is not the show ending");
    });

    test("chat silent AND the room stopped moving — a quiet room, left alone", async () => {
      // The discrimination itself: same chat silence as the case above, but
      // nothing has changed in the room either. Reloading here is churn on a
      // show that is simply between lots.
      const d = await tick(which, { chatQuietMs: 130 * SEC, roomQuietMs: 300 * SEC });
      assert.equal(d.reloaded, false, "a quiet room must not be reloaded on a timer");
      assert.deepEqual(d.ended, [], "five minutes of quiet is not the end of a show");
    });

    test("a show still moving is NEVER declared over, however long chat has been dead", async () => {
      // Chat mute for well past the end-of-show threshold, room active one
      // second ago. If these two conditions were ever ORed instead of ANDed,
      // this is the case that closes a live session and writes its report.
      const d = await tick(which, { chatQuietMs: 20 * MIN, roomQuietMs: 1 * SEC });
      assert.deepEqual(d.ended, [], "the room is moving — it has not ended");
      assert.equal(d.reloaded, true, "and its feed is plainly dead, so reload it");
    });

    test("everything silent past the end threshold — ended, once", async () => {
      const ended: string[] = [];
      const now = Date.now();
      const w =
        which === "ebay"
          ? new EbayLiveWatcher({ eventId: "ev_wd_end", onEnded: (why) => ended.push(why) })
          : new ScrapedPageWatcher(
              whatnotSpec as ScrapeSpec,
              { externalId: "room_wd_end" },
              { onEnded: (why) => ended.push(why) },
            );
      const p = w as unknown as {
        reloads: number;
        lastCommentAt?: number;
        lastMessageAt?: number;
        lastActivityAt: number;
        watchdog(): Promise<void>;
      };
      p.reloads = 0;
      if (which === "ebay") p.lastCommentAt = now - 16 * MIN;
      else p.lastMessageAt = now - 16 * MIN;
      p.lastActivityAt = now - 16 * MIN;

      await p.watchdog();
      assert.equal(ended.length, 1, "fifteen minutes of total silence ends the show");
      assert.match(ended[0]!, /no chat, viewers or lots/i, "the reason names what was measured");
      assert.equal(p.reloads, 0, "ending returns before the reload branch — no churn on the way out");

      // Ending is a one-time transition. Emitting it every tick would write a
      // report per second for the rest of the process's life.
      await p.watchdog();
      await p.watchdog();
      assert.equal(ended.length, 1, "the end of a show is announced once");
    });

    test("the reload budget is spent, not ignored, on a genuinely dead socket", async () => {
      // One under the limit still tries; at the limit it gives up instead, and
      // still does not call it an ending.
      const last = await tick(which, { chatQuietMs: 130 * SEC, roomQuietMs: 1 * SEC, reloads: 19 });
      assert.equal(last.reloaded, true, "the twentieth reload is still attempted");
      assert.equal(last.gaveUp, 0);

      const spent = await tick(which, { chatQuietMs: 130 * SEC, roomQuietMs: 1 * SEC, reloads: 20 });
      assert.equal(spent.reloaded, false, "past the budget it stops reloading");
      assert.equal(spent.gaveUp, 1, "and says so");
      assert.deepEqual(spent.ended, [], "giving up is not the show ending");
    });
  });
}
