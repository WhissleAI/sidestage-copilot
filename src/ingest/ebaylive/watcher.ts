// eBay Live show watcher.
//
// eBay Live has no public API for show chat or lots — the Developer Program
// covers Browse/Sell/Feed/Media and nothing else. The show page is a React app
// whose player mounts at /ebaylive/events/{eventId}/player.html and renders both
// the buyer chat and the current lot into the DOM, live, with no sign-in. So this
// adapter drives a headless browser and reads that DOM.
//
// That is a prototype ingestion path, not a supported integration, and it is
// documented as such (docs/TDD.md §7). It is honest about three things:
//
//   * it READS only — there is no code path here that posts a comment or a bid;
//   * it polls at a human cadence (1s) rather than hammering;
//   * every selector is matched on a class PREFIX, because eBay ships hashed
//     CSS module names (`chatMessage-BPsSWw`) that change on every deploy. The
//     stable parts are the prefixes and `li[data-id]`, which is a server-issued
//     UUID per comment and therefore the natural dedupe key.
//
// If eBay opens the real API, this file is the only thing that changes: it emits
// into the same `ChatSource` port the simulated source uses.

import { chromium, type Browser, type Page } from "playwright";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface LiveComment {
  /** eBay's own per-comment UUID from `li[data-id]`. */
  id: string;
  author: string;
  text: string;
}

export interface LiveLot {
  /** Lot title as shown, e.g. "#372 - SUNDAY - 9/13/26- MLB $.99 Starts". */
  title: string;
  priceCents: number;
  /** "brent_21" when someone is winning, else null. */
  highBidder: string | null;
  /** Seconds left on the countdown, when one is showing. */
  secondsLeft: number | null;
  soldOut: boolean;
}

export interface WatcherEvents {
  onComment?: (c: LiveComment) => void;
  onLot?: (l: LiveLot) => void;
  onViewers?: (n: number) => void;
  onStatus?: (s: { connected: boolean; detail: string }) => void;
}

export interface WatcherOpts extends WatcherEvents {
  eventId: string;
  pollMs?: number;
  headless?: boolean;
}

/** Shared browser across every watched show — one Chromium, N pages. */
let shared: Browser | null = null;
let refCount = 0;

async function acquireBrowser(headless: boolean): Promise<Browser> {
  if (!shared) shared = await chromium.launch({ headless });
  refCount++;
  return shared;
}

async function releaseBrowser(): Promise<void> {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && shared) {
    const b = shared;
    shared = null;
    await b.close().catch(() => {});
  }
}

export class EbayLiveWatcher {
  private page: Page | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private seen = new Set<string>();
  private lastLotKey = "";
  private lastViewers = -1;
  private pollMs: number;

  constructor(private o: WatcherOpts) {
    this.pollMs = o.pollMs ?? 1000;
  }

  get eventId(): string {
    return this.o.eventId;
  }

  async start(): Promise<void> {
    const browser = await acquireBrowser(this.o.headless ?? true);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: UA });

    // The page is a video app we never watch. Dropping media and images cuts
    // bandwidth and CPU by roughly an order of magnitude per show, which is what
    // makes watching several shows at once practical.
    await ctx.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") return route.abort();
      return route.continue();
    });

    // tsx/esbuild compiles with `keepNames`, which wraps functions in a `__name`
    // helper. That helper does not exist inside the browser, so any evaluate()
    // callback throws `__name is not defined`. Define it as identity in the page.
    await ctx.addInitScript(() => {
      (globalThis as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
    });

    this.page = await ctx.newPage();
    await this.page.goto(`https://www.ebay.com/ebaylive/events/${this.o.eventId}/player.html`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    // Wait for real messages, not the feed's hidden spacer <li>. Matching on the
    // bare `li` returned immediately against `li.topSpacer`, so the backlog scrape
    // below saw zero comments and the next tick replayed the entire visible
    // history into the reply pipeline as if it were new traffic.
    await this.page.waitForFunction(
      () => document.querySelectorAll('ul[class*="chatFeed"] li[data-id]').length > 0,
      null,
      { timeout: 30_000 },
    );

    // The first scrape is a BACKLOG, not new traffic: mark everything already on
    // screen as seen so a freshly attached show does not replay an hour of chat
    // through the reply pipeline.
    const backlog = await this.scrape();
    for (const c of backlog.comments) this.seen.add(c.id);
    if (backlog.lot) this.emitLot(backlog.lot);
    this.o.onStatus?.({ connected: true, detail: `attached to ${this.o.eventId} (${backlog.comments.length} backlog)` });

    this.tick();
  }

  private tick(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        const s = await this.scrape();
        for (const c of s.comments) {
          if (this.seen.has(c.id)) continue;
          this.seen.add(c.id);
          this.o.onComment?.(c);
        }
        // The set only ever grows while a show runs; cap it.
        if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2000));
        if (s.lot) this.emitLot(s.lot);
        if (s.viewers !== null && s.viewers !== this.lastViewers) {
          this.lastViewers = s.viewers;
          this.o.onViewers?.(s.viewers);
        }
      } catch (e) {
        // A navigation, a deploy, or a closed show. Report and keep polling —
        // a transient DOM miss must not tear down the show.
        this.o.onStatus?.({ connected: false, detail: (e as Error).message.slice(0, 120) });
      }
      this.tick();
    }, this.pollMs);
  }

  private emitLot(l: LiveLot): void {
    // Only surface a lot when something a guard would care about changed.
    const key = `${l.title}|${l.priceCents}|${l.soldOut}`;
    if (key === this.lastLotKey) return;
    this.lastLotKey = key;
    this.o.onLot?.(l);
  }

  /** One DOM read. Everything selector-shaped lives here and nowhere else. */
  private async scrape(): Promise<{ comments: LiveComment[]; lot: LiveLot | null; viewers: number | null }> {
    if (!this.page) throw new Error("watcher not started");
    return this.page.evaluate(() => {
      const txt = (e: Element | null | undefined) => (e as HTMLElement | null)?.innerText?.trim() || "";

      const comments = [...document.querySelectorAll('ul[class*="chatFeed"] li[data-id]')]
        .map((li) => ({
          id: li.getAttribute("data-id") || "",
          author: txt(li.querySelector('[class*="chatAuthor"]')),
          text: txt(li.querySelector('[class*="chatText"]')),
        }))
        .filter((c) => c.id && c.author && c.text);

      let lot: {
        title: string; priceCents: number; highBidder: string | null;
        secondsLeft: number | null; soldOut: boolean;
      } | null = null;

      const card = document.querySelector('[class*="itemCard"]');
      if (card) {
        const priceText = txt(card.querySelector('[class*="currentPrice"]'));
        const cents = Math.round(Number(priceText.replace(/[^0-9.]/g, "")) * 100);
        const lines = txt(card).split("\n").map((x) => x.trim()).filter(Boolean);
        // The title is the first line that is neither the price nor a control.
        const title = lines.find((l) => l !== priceText && !/^\$/.test(l) && !/^(Max bid|Sold out|Ineligible)/i.test(l)) || "";
        const winning = lines.find((l) => / is winning$/i.test(l)) || "";
        const clock = lines.find((l) => /^\d{1,2}:\d{2}$/.test(l)) || "";
        const [mm, ss] = clock ? clock.split(":").map(Number) : [NaN, NaN];
        lot = {
          title,
          priceCents: Number.isFinite(cents) ? cents : 0,
          highBidder: winning ? winning.replace(/ is winning$/i, "").trim() : null,
          secondsLeft: clock ? mm * 60 + ss : null,
          soldOut: /sold out/i.test(txt(card)),
        };
      }

      const countEl = [...document.querySelectorAll('[class*="_count_"]')]
        .find((e) => /^\d[\d,]*$/.test(txt(e)));
      const viewers = countEl ? Number(txt(countEl).replace(/,/g, "")) : null;

      return { comments, lot, viewers };
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ctx = this.page?.context();
    this.page = null;
    await ctx?.close().catch(() => {});
    await releaseBrowser();
  }
}
