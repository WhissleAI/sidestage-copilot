// Whatnot discovery: a browser, on a budget, because the box is small.
//
// The investigation is written up in `surfaces/whatnot/browse.ts`: the public
// browse, tag and search pages are 403 to a plain GET and 200 to headless real
// Chrome, and they carry every field a card needs. So it ships. What it must
// not do is ship the way a demo would.
//
// The production box is a t3.small with two gigabytes of memory, already
// running a Chrome every five minutes for the eBay Live grid, and it has been
// taken down once by browsers that were started and not reaped — four defunct
// `[chrome]` and `[chrome_crashpad]` entries per poll until the host thrashed
// itself to a standstill after about twenty hours (2026-09-18). Everything
// unusual below is a consequence of that:
//
//   · **One Whatnot browser in this process, ever.** A single-flight lock, the
//     same shape as `withProfileLock`, so ten operators opening Discover at
//     once is one Chrome and not ten. The second caller waits for the first
//     and then reads the cache the service holds.
//   · **One page, reused across queries.** A page per interest is a renderer
//     per interest.
//   · **A hard budget, enforced twice** — per navigation and over the whole
//     read — and a budget that runs out is `unavailable` with a timeout for a
//     reason, never a half-read grid.
//   · **`openContext(..., ebaySession: false)`** so this never takes the eBay
//     profile lock (which would starve the eBay grid poller for the length of
//     the read) and never carries the seller's eBay cookies to Whatnot, while
//     still getting the three things that each took a deploy to learn: the real
//     Chrome channel, `--disable-dev-shm-usage`, and the discovery proxy.
//   · **A kill switch.** `WHATNOT_DISCOVERY=0` turns it off without a deploy.
//     After an outage caused by browsers, a surface that drives a browser on a
//     request path should be switchable off from the environment by whoever is
//     awake.

import { openContext } from "../../ingest/ebaylive/session.js";
import { audienceCount } from "../../surfaces/scrapeDom.js";
import {
  readBrowseInPage, WHATNOT_BROWSE_SELECTORS, type BrowseSnapshot,
} from "../../surfaces/whatnot/browse.js";
import { whyFor } from "../match.js";
import type { DiscoverHit, DiscoverSource, SourceRequest, SourceUnavailable } from "../types.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** How many interest queries one read may spend. Each is a page load of about
 *  seven seconds, so this is the difference between a Discover that answers and
 *  one that times out. */
const MAX_QUERIES = 2;

/** One Whatnot browser in this process at a time. Concurrent Discover requests
 *  queue behind it rather than each launching a Chrome. */
let chain: Promise<unknown> = Promise.resolve();
function withWhatnotLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** Off only when somebody turned it off. Absence is on: the surface needs no
 *  key, and a scraped surface that defaulted to off would be invisible for the
 *  same reason Twitch and Reddit were. */
export function whatnotDiscoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test((env.WHATNOT_DISCOVERY ?? "").trim());
}

/** Reading one Whatnot URL. Injected by the suite, which must not drive a
 *  browser: the DOM read itself is tested against a fixture through
 *  `readBrowseInPage`, and this seam tests everything around it. */
export type BrowseReader = (url: string) => Promise<BrowseSnapshot>;

export interface WhatnotSourceOpts {
  read?: BrowseReader;
  maxQueries?: number;
}

/** A challenge or a sign-in wall is a fact about the network, not an empty
 *  grid. Reported by name so the operator knows to point the proxy somewhere
 *  else rather than concluding nobody is selling on Whatnot tonight. */
const wall = (what: string): SourceUnavailable => ({ reason: what, missing: null });

export function whatnotSource(opts: WhatnotSourceOpts = {}): DiscoverSource {
  return {
    surface: "whatnot",
    method: "Whatnot's public search pages, read in a real browser — no key, subject to Cloudflare",

    unavailable(env): SourceUnavailable | null {
      return whatnotDiscoveryEnabled(env)
        ? null
        : {
            reason: "Whatnot discovery is switched off on this server (it drives a browser per read)",
            missing: "WHATNOT_DISCOVERY",
          };
    },

    async fetch(req: SourceRequest): Promise<DiscoverHit[]> {
      // No interests and no explicit "everything": nothing to search for.
      // Whatnot's browse index is categories, not rooms, so there is no grid to
      // fall back on that could say why anything was on screen.
      const terms = req.interests.slice(0, opts.maxQueries ?? MAX_QUERIES).map((i) => i.term);
      const urls = terms.length
        ? terms.map((t) => `https://www.whatnot.com/search?query=${encodeURIComponent(t)}`)
        : req.all
          ? ["https://www.whatnot.com/browse"]
          : [];
      if (!urls.length) return [];

      const snapshots = await withWhatnotLock(async () => {
        // The browser is opened and closed INSIDE the lock, so there is never a
        // moment when two of them exist, and closed in a `finally` so a timeout
        // leaves nothing behind — browsers that were started and not reaped is
        // the exact failure that took the box down.
        const session = opts.read ? { read: opts.read, close: async () => {} } : liveReader(req.timeoutMs);
        try {
          const out: BrowseSnapshot[] = [];
          for (const url of urls) out.push(await session.read(url));
          return out;
        } finally {
          await session.close().catch(() => {});
        }
      });

      const blocked = snapshots.find((s) => s.blocked)?.blocked;
      // A wall is not an empty result. Raised as an error the service turns
      // into `unavailable`, so the operator is told what is in the way.
      if (blocked && snapshots.every((s) => !s.cards.length)) throw new WhatnotWall(blocked);

      // The check that makes this safe to ship to a box nobody has tested it
      // on. A challenge page announces itself; a page that simply renders
      // nothing does not, and zero cards from one is indistinguishable from
      // "nobody is selling that tonight" — which is exactly the failure mode
      // that would make an operator conclude the product is broken. So: if
      // Whatnot's own page furniture never rendered on ANY of the reads, this
      // server is not getting the real page, and it says so.
      if (snapshots.length && snapshots.every((s) => !s.shell)) {
        throw new WhatnotWall(
          "Whatnot answered this server with a page that has no grid on it — the read is not getting the real page. " +
            "Attaching to a room by pasting its link is unaffected.",
        );
      }

      const hits: DiscoverHit[] = [];
      const seen = new Set<string>();
      for (const snap of snapshots) {
        for (const c of snap.cards) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          hits.push({
            surface: "whatnot",
            // The room's uuid — what `whatnotAdapter.parseTarget` takes.
            id: c.id,
            title: c.title,
            host: c.host,
            url: c.url,
            // Whatnot does not publish when a room opened. Null, not a guess
            // from a badge that only says it is live.
            startedAt: null,
            liveNow: c.liveNow,
            viewers: c.viewersRaw ? audienceCount(c.viewersRaw) : null,
            why: whyFor(
              [
                { text: c.title, where: "title" },
                { text: c.tags.join(" · "), where: "category" },
                { text: c.host, where: "host" },
              ],
              req.interests,
            ),
            // Draft-only, live: the copilot watches the room and writes; the
            // seller puts it in the chat themselves.
            action: "attach",
          });
        }
      }
      return hits;
    },
  };
}

/** A wall Whatnot put in front of the page. Distinguished from an ordinary
 *  failure so the service can report what it is rather than "failed". */
export class WhatnotWall extends Error {
  constructor(readonly what: string) {
    super(what);
    this.name = "WhatnotWall";
  }
}

export const whatnotWallOf = (e: unknown): SourceUnavailable | null =>
  e instanceof WhatnotWall ? wall(e.what) : null;

/**
 * The real reader: one browser, one page, closed whatever happens.
 *
 * Built per fetch and torn down at the end of it. A long-lived browser would be
 * cheaper per read and is exactly the arrangement that left defunct Chromes on
 * the box; `openContext`'s `close` now closes the context AND the browser it
 * belongs to and logs whichever refuses, which is the teardown this depends on.
 */
function liveReader(budgetMs: number): { read: BrowseReader; close: () => Promise<void> } {
  let opened: Promise<{ read: BrowseReader; close: () => Promise<void> }> | null = null;
  const deadline = Date.now() + budgetMs;

  const open = async () => {
    const { ctx, close } = await openContext({ headless: true, userAgent: UA, ebaySession: false });
    // Images, fonts and video are most of the bytes on a grid of thumbnails and
    // none of the data — and on a two-gigabyte box they are also most of the
    // renderer's memory.
    await ctx.route("**/*", (r) => {
      const t = r.request().resourceType();
      return t === "image" || t === "media" || t === "font" ? r.abort() : r.continue();
    });
    // tsx compiles with `keepNames`, which wraps functions in a `__name` helper
    // the browser does not have; any evaluate() callback throws without this.
    await ctx.addInitScript(() => {
      (globalThis as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
    });
    const page = await ctx.newPage();
    const read: BrowseReader = async (url) => {
      const left = deadline - Date.now();
      if (left <= 1_000) throw new Error("ran out of time before Whatnot answered");
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.min(30_000, left) });
      // The grid is client-rendered; wait for a card rather than a fixed pause,
      // and treat the absence of one as a page with no cards on it (which a
      // search for something nobody is selling genuinely is).
      await page
        .waitForSelector(WHATNOT_BROWSE_SELECTORS.card, { timeout: Math.min(15_000, Math.max(2_000, deadline - Date.now())) })
        .catch(() => null);
      return page.evaluate(readBrowseInPage, WHATNOT_BROWSE_SELECTORS);
    };
    return { read, close };
  };

  return {
    // Lazy: a fetch that is cancelled before its first URL never launches a
    // browser at all.
    read: async (url) => {
      opened ??= open();
      const { read } = await opened;
      return read(url);
    },
    close: async () => {
      if (!opened) return;
      const { close } = await opened.catch(() => ({ close: async () => {} }));
      await close();
    },
  };
}
