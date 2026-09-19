// eBay Live, as a surface.
//
// This is a MAPPING and nothing else. `src/ingest/ebaylive/watcher.ts` is the
// integration — the hashed-class selectors, the background-throttling flags,
// the dead-socket watchdog, the "Target crashed" recovery, the fifteen-minute
// end-of-show silence — and every line of it is hard-won against a real page on
// a real box. None of it is repeated here, and none of it moved. The adapter
// opens the watcher, renames its callbacks to the ones every other surface will
// use, and gets out of the way.
//
// Renaming is the whole trick. `onComment` and `onLot` are eBay Live's words;
// `onMessage` and `onItem` are the words a Twitch chat, a subreddit thread and
// a Whatnot lot can all answer to. The watcher keeps its own vocabulary because
// changing it would mean touching the one file that must not be touched.

import { EbayLiveWatcher } from "../../ingest/ebaylive/watcher.js";
import { parseEventId } from "../../ingest/ebaylive/discovery.js";
import {
  EBAYLIVE_CAPABILITIES,
  type SurfaceAdapter, type SurfaceConnection, type SurfaceEvents, type SurfaceTarget,
} from "../types.js";

export const ebayLiveAdapter: SurfaceAdapter = {
  id: "ebaylive",
  label: "eBay Live",
  capabilities: EBAYLIVE_CAPABILITIES,

  /** The same parse the attach route has always used, so a link that worked
   *  yesterday resolves to the same event id today. */
  parseTarget(input: string): SurfaceTarget | null {
    const eventId = parseEventId(input);
    return eventId ? { externalId: eventId } : null;
  },

  async open(t: SurfaceTarget, ev: SurfaceEvents): Promise<SurfaceConnection> {
    const watcher = new EbayLiveWatcher({
      eventId: t.externalId,
      onStatus: ev.onStatus ? (s) => ev.onStatus!(s) : undefined,
      onTitle: ev.onTitle ? (title) => ev.onTitle!(title) : undefined,
      onEnded: ev.onEnded ? (why) => ev.onEnded!(why) : undefined,
      onViewers: ev.onViewers ? (n) => ev.onViewers!(n) : undefined,
      onComment: ev.onMessage
        ? (c) => ev.onMessage!({ id: c.id, author: c.author, text: c.text })
        : undefined,
      // A live-commerce lot is an item with two fields the general shape does
      // not have: who is winning it, and how long is left. Both feed
      // `upsertObservedLot`, so dropping them here would quietly change what
      // eBay Live records — they ride in `meta`, which is where surface-specific
      // truth belongs.
      onLot: ev.onItem
        ? (l) => ev.onItem!({
            externalRef: l.title,
            title: l.title,
            priceCents: l.priceCents,
            soldOut: l.soldOut,
            meta: { highBidder: l.highBidder, secondsLeft: l.secondsLeft },
          })
        : undefined,
    });

    await watcher.start();
    return { stop: () => watcher.stop() };
  },
};
