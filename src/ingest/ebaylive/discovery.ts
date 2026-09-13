// Discover which eBay Live shows are on air right now.
//
// Same constraint as the watcher: no public API, so this reads the index page.
// It exists so the operator can pick a real show from the console instead of
// pasting an event id, and so `npm run ebay:watch` can attach to the busiest
// show without anyone hunting for one.

import { chromium } from "playwright";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface DiscoveredShow {
  eventId: string;
  title: string;
  host: string;
  viewers: number;
  url: string;
}

/**
 * BEST EFFORT. The eBay Live index lazy-mounts its show grid and navigates through
 * click handlers rather than links, so a headless scrape often surfaces CHANNEL
 * ids ("Coins & Bullion") rather than live event ids. Returned rows are therefore
 * candidates: attaching validates them, and a non-event fails fast.
 *
 * The reliable path is attaching by URL, which the operator already has — they
 * are watching the show. `parseEventId` accepts any eBay Live URL shape.
 */
export async function discoverLiveShows(opts: { limit?: number; headless?: boolean } = {}): Promise<DiscoveredShow[]> {
  const browser = await chromium.launch({ headless: opts.headless ?? true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, userAgent: UA });
    await ctx.route("**/*", (r) => {
      const t = r.request().resourceType();
      return t === "image" || t === "media" || t === "font" ? r.abort() : r.continue();
    });
    // tsx/esbuild compiles with `keepNames`, which wraps functions in a `__name`
    // helper. That helper does not exist inside the browser, so any evaluate()
    // callback throws `__name is not defined`. Define it as identity in the page.
    await ctx.addInitScript(() => {
      (globalThis as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
    });

    const page = await ctx.newPage();
    // `networkidle` never fires on this page — a live index streams telemetry
    // forever — so load on DOM ready and then scroll, because the show grid is
    // lazy-mounted below the fold.
    await page.goto("https://www.ebay.com/ebaylive", { waitUntil: "domcontentloaded", timeout: 45_000 });
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(1200);
    }
    await page
      .waitForFunction(() => /events\/[A-Za-z0-9_-]{8,}/.test(document.body.innerHTML), null, { timeout: 20_000 })
      .catch(() => {});

    const shows = await page.evaluate(() => {
      const byId = new Map<string, { eventId: string; title: string; host: string; viewers: number; url: string }>();

      // Cards navigate through a click handler rather than an href, so the event
      // id is not always on an anchor. Take anchors where they exist, and fall
      // back to any element carrying the id in an attribute.
      const carriers: { el: Element; eventId: string }[] = [];
      for (const a of document.querySelectorAll('a[href*="/ebaylive/events/"]')) {
        const m = ((a as HTMLAnchorElement).href || "").match(/\/ebaylive\/events\/([A-Za-z0-9_-]+)/);
        if (m) carriers.push({ el: a, eventId: m[1] });
      }
      if (!carriers.length) {
        // eBay ids are exactly 16 mixed-case alphanumerics ("gmqxTwJPXDeKbGRE").
        // Without that shape the fallback scrapes framework ids and dialog nodes.
        for (const el of document.querySelectorAll("[data-event-id],[data-id],[id]")) {
          const raw = el.getAttribute("data-event-id") || el.getAttribute("data-id") || el.id || "";
          if (/^[A-Za-z0-9]{16}$/.test(raw)) carriers.push({ el, eventId: raw });
        }
      }

      for (const { el: a, eventId } of carriers) {
        if (byId.has(eventId)) continue;
        const href = `https://www.ebay.com/ebaylive/events/${eventId}/stream`;

        // The card is the nearest ancestor carrying both a viewer count and a title.
        const card = (a.closest("li") || a.closest("div")) as HTMLElement | null;
        const text = card?.innerText || (a as HTMLElement).innerText || "";
        const lines = text.split("\n").map((x) => x.trim()).filter(Boolean);
        const viewers = Number((lines.find((l) => /^\d[\d,]*$/.test(l)) || "0").replace(/,/g, ""));
        const title = lines.find((l) => l.length > 12 && !/^\d/.test(l) && !/^LIVE/i.test(l)) || "";
        const hostIdx = lines.findIndex((l) => l === title);
        const host = hostIdx >= 0 ? lines.slice(hostIdx + 1).find((l) => l && !/^\$/.test(l)) || "" : "";

        byId.set(eventId, { eventId, title, host, viewers, url: href });
      }
      return [...byId.values()];
    });

    return shows
      .filter((s) => s.title)
      .sort((a, b) => b.viewers - a.viewers)
      .slice(0, opts.limit ?? 20);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Pull the event id out of anything an operator might paste. */
export function parseEventId(input: string): string | null {
  const t = (input || "").trim();
  if (/^[A-Za-z0-9]{16}$/.test(t)) return t;
  const m = t.match(/\/ebaylive\/events\/([A-Za-z0-9]{10,})/);
  return m ? m[1] : null;
}

// `npx tsx src/ingest/ebaylive/discovery.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const shows = await discoverLiveShows({ limit: 15 });
  console.log(`\n${shows.length} eBay Live shows on air:\n`);
  for (const s of shows) {
    console.log(`  ${String(s.viewers).padStart(5)}  ${s.eventId.padEnd(18)}  ${s.title.slice(0, 60)}`);
    if (s.host) console.log(`         ${s.host}`);
  }
  console.log();
}
