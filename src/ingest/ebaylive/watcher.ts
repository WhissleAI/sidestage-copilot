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
  /** The show's real name, read off the page once on attach. */
  onTitle?: (title: string) => void;
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

/** No comment for this long, while the show is otherwise active, means the chat
 *  socket is dead rather than the room being quiet. */
const COMMENT_SILENCE_MS = 120_000;
/** "Otherwise active" = a lot or viewer count moved within this window. */
const ACTIVITY_WINDOW_MS = 90_000;
/** Reloading forever would hammer eBay if the selector itself broke. */
const MAX_RELOADS = 20;

/** Shared browser across every watched show — one Chromium, N pages. */
let shared: Browser | null = null;
let refCount = 0;

async function acquireBrowser(headless: boolean): Promise<Browser> {
  if (!shared) {
    shared = await chromium.launch({
      headless,
      // A headless page is a BACKGROUND page, and Chrome throttles background
      // timers and lets renderers idle. eBay's chat socket stops delivering when
      // the document looks hidden, which is why comments arrived for a minute
      // and then stopped for good while lot updates kept flowing.
      args: [
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=CalculateNativeWinOcclusion",
        "--mute-audio",
      ],
    });
    // Chromium can die under us — OOM-killed, crashed, or closed by hand — and
    // without this the stale handle is handed to every watcher forever: each
    // scrape() throws, the console keeps rendering a show that looks alive, and
    // nothing ever recovers. Dropping the handle is the whole fix; the next
    // acquire relaunches, which is exactly what the per-show reconnect loop
    // already retries into.
    shared.on("disconnected", () => {
      shared = null;
      refCount = 0;
      console.warn("  ebaylive: Chromium disconnected — relaunching on the next tick");
    });
  }
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

  /** Watchdog state. A show that is clearly ALIVE (lots and viewers moving) but
   *  has produced no comment for this long has a dead chat socket, not a quiet
   *  room — so the page is reloaded rather than left silently broken. */
  private lastCommentAt = Date.now();
  private lastActivityAt = Date.now();
  private reloads = 0;

  constructor(private o: WatcherOpts) {
    this.pollMs = o.pollMs ?? 1000;
  }

  get eventId(): string {
    return this.o.eventId;
  }

  async start(): Promise<void> {
    await this.openPage();

    // The first scrape is a BACKLOG, not new traffic: mark everything already on
    // screen as seen so a freshly attached show does not replay an hour of chat
    // through the reply pipeline.
    const pageTitle = (await this.page!.title()).replace(/\s*\|\s*eBay Live.*$/i, "").trim();
    if (pageTitle) this.o.onTitle?.(pageTitle);

    const backlog = await this.scrape();
    for (const c of backlog.comments) this.seen.add(c.id);
    if (backlog.lot) this.emitLot(backlog.lot);
    this.o.onStatus?.({ connected: true, detail: `attached to ${this.o.eventId} (${backlog.comments.length} backlog)` });

    this.tick();
  }

  /** Build a fresh context + page on the shared browser. Called on start and
   *  again whenever the page or the browser underneath it has died. */
  private async openPage(): Promise<void> {
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

      // Present as a visible, focused tab. Web apps commonly pause realtime
      // sockets on `visibilitychange`; a headless page reports itself hidden,
      // so eBay's chat feed went quiet while everything else kept working.
      try {
        Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
        Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
        Object.defineProperty(document, "hasFocus", { value: () => true, configurable: true });
      } catch {
        /* a page that locks these down is no worse off than before */
      }
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

  }

  private tick(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        const s = await this.scrape();
        for (const c of s.comments) {
          if (this.seen.has(c.id)) continue;
          this.seen.add(c.id);
          this.lastCommentAt = Date.now();
          this.o.onComment?.(c);
        }
        // The set only ever grows while a show runs; cap it.
        if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2000));
        if (s.lot) this.emitLot(s.lot);
        if (s.viewers !== null && s.viewers !== this.lastViewers) {
          this.lastViewers = s.viewers;
          this.lastActivityAt = Date.now();
          this.o.onViewers?.(s.viewers);
        }
        await this.watchdog();
      } catch (e) {
        // A navigation, a deploy, or a closed show. Report and keep polling —
        // a transient DOM miss must not tear down the show.
        this.o.onStatus?.({ connected: false, detail: (e as Error).message.slice(0, 120) });
        // Unless the page itself is gone. A dead page never heals by polling
        // it again, so every subsequent tick would report the same failure
        // forever while the console kept showing a show that looked alive.
        await this.recoverIfDead();
      }
      this.tick();
    }, this.pollMs);
  }

  /**
   * Rebuild the page when it, or the browser under it, has died.
   *
   * Distinct from the chat watchdog below: that one reloads a page that is
   * alive but whose socket stopped delivering. This one handles the case where
   * there is nothing left to reload — Chromium was OOM-killed or crashed, and
   * `acquireBrowser` has already dropped the shared handle, so asking for a
   * page again relaunches it.
   */
  private async recoverIfDead(): Promise<void> {
    if (this.stopped) return;
    const dead = !this.page || this.page.isClosed() || !this.page.context().browser()?.isConnected();
    if (!dead) return;
    try {
      this.page = null;
      await this.openPage();
      // Everything on screen after a relaunch is history, not new traffic.
      const backlog = await this.scrape();
      for (const c of backlog.comments) this.seen.add(c.id);
      this.lastCommentAt = Date.now();
      this.o.onStatus?.({ connected: true, detail: "browser recovered — feed reattached" });
    } catch (e) {
      // Still down. The next tick tries again; there is no state to corrupt.
      this.o.onStatus?.({ connected: false, detail: `recovery failed: ${(e as Error).message.slice(0, 100)}` });
    }
  }

  /**
   * The show is moving but chat is not. Reload.
   *
   * Distinguishing "quiet room" from "dead socket" is the whole job here: a show
   * with no viewers changing and no lots opening is simply quiet, and reloading
   * it would be churn. A show whose lots keep opening while chat has said
   * nothing for minutes has lost its feed.
   */
  private async watchdog(): Promise<void> {
    const quietMs = Date.now() - this.lastCommentAt;
    const activeMs = Date.now() - this.lastActivityAt;
    if (quietMs < COMMENT_SILENCE_MS || activeMs > ACTIVITY_WINDOW_MS) return;
    if (this.reloads >= MAX_RELOADS) return;

    this.reloads++;
    this.o.onStatus?.({
      connected: false,
      detail: `chat silent ${Math.round(quietMs / 1000)}s while the show is active — reloading the feed (${this.reloads}/${MAX_RELOADS})`,
    });

    try {
      await this.page!.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
      await this.page!.waitForFunction(
        () => document.querySelectorAll('ul[class*="chatFeed"] li[data-id]').length > 0,
        null,
        { timeout: 30_000 },
      );
      // Everything on screen after a reload is history, not new traffic.
      const backlog = await this.scrape();
      for (const c of backlog.comments) this.seen.add(c.id);
      this.lastCommentAt = Date.now();
      this.o.onStatus?.({ connected: true, detail: `feed reloaded (${backlog.comments.length} backlog suppressed)` });
    } catch (e) {
      this.o.onStatus?.({ connected: false, detail: `reload failed: ${(e as Error).message.slice(0, 100)}` });
    }
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
