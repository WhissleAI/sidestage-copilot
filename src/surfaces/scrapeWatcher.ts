// The poll loop every scraped surface runs.
//
// Whatnot and TikTok Live are read the way eBay Live is read — a real browser
// on the public page, one DOM read a second — and the hard parts of doing that
// are not the selectors. They are: a backlog that must not be replayed as new
// traffic, a chat socket that dies while the rest of the page keeps moving, a
// renderer that crashes under memory pressure, and a room that ended without
// the page ever saying so. `src/ingest/ebaylive/watcher.ts` learned all four
// against live shows on a real box, and that file is frozen — it is the
// reference surface's integration and the demo depends on it behaving exactly
// as it does today.
//
// So the LOOP lives here, once, and each surface contributes only a
// `ScrapeSpec`: a URL, a selector table, and how to read that platform's
// numbers. Writing the loop twice more would have meant three copies of a
// watchdog whose constants were tuned once, and the second copy is where they
// drift.
//
// The numbers below are the eBay watcher's, re-declared rather than imported
// because it keeps them private and must not be edited to export them. The
// reasoning is quoted with them so a future edit argues with the reasoning
// rather than with a bare integer.

import type { BrowserContext, Page } from "playwright";
import { openContext } from "../ingest/ebaylive/session.js";
import { extractInPage, type PageSnapshot, type ScrapeSelectors } from "./scrapeDom.js";
import type { SurfaceEvents, SurfaceId, SurfaceTarget } from "./types.js";

type ItemEvent = Parameters<NonNullable<SurfaceEvents["onItem"]>>[0];

/** No message for this long, while the room is otherwise active, means the
 *  chat socket is dead rather than the room being quiet. (eBay watcher.) */
const COMMENT_SILENCE_MS = 120_000;
/** "Otherwise active" = an item or the viewer count moved within this window. */
const ACTIVITY_WINDOW_MS = 90_000;
/** No message, no viewer change and no item for this long: the show is over.
 *  The page cannot be trusted to say so — a room id outlives the stream — so
 *  the feed's own silence is the signal, and fifteen minutes is longer than any
 *  break a host takes with the stream still up. (eBay watcher.) */
const END_SILENCE_MS = 15 * 60_000;
/** Reloading forever would hammer the platform if the selector itself broke. */
const MAX_RELOADS = 20;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * What makes two rows the same message.
 *
 * The platform's own id when it ships one: it is the only key that survives a
 * reload, which is exactly when dedupe has to work. The backlog scrape after a
 * reload re-reads every message on screen, and without a stable key the room's
 * whole visible history would go through the reply pipeline a second time.
 *
 * When a row carries no id — TikTok's feed does not always — the fallback is
 * author-and-text, and its one cost is that a viewer who says the same thing
 * twice is heard once. That is the right direction to be wrong in: a dropped
 * duplicate costs nothing, a duplicate through the pipeline costs a reply.
 *
 * Exported because the fixture test asserts on it. A dedupe rule exercised only
 * by a live room is a dedupe rule nobody has checked.
 */
export function dedupeKey(m: { id: string; author: string; text: string }): string {
  return m.id || `${m.author}\u0000${m.text}`;
}

/** Everything one surface has to say about reading its page. */
export interface ScrapeSpec {
  surface: SurfaceId;
  label: string;
  selectors: ScrapeSelectors;
  /** The page to sit on. Takes the whole target because these surfaces address
   *  a room two ways — by its own id, and by whoever is hosting it. */
  url(t: SurfaceTarget): string;
  /** "1.2K watching" → 1200. Formatting is a platform's own business. */
  viewers?(raw: string): number | null;
  /** The card the page is showing → the event the rest of the system consumes.
   *  Returning null means "there is a card but it says nothing usable yet",
   *  which is the state a lot is in for the first frames after it opens. */
  item?(raw: NonNullable<PageSnapshot["item"]>, t: SurfaceTarget): ItemEvent | null;
  /** Strip the platform's own suffix off `document.title`. */
  title?(pageTitle: string): string;
  pollMs?: number;
  userAgent?: string;
}

/**
 * One watched room on a scraped surface.
 *
 * Owns its own browser, unlike the eBay watcher, which shares one Chromium
 * across every show it watches. That is a real cost — a second watched Whatnot
 * room is a second Chrome — and it is the price of not writing a second
 * launcher: `openContext` owns the launch, and it already carries the three
 * things that took a deploy each to learn (the residential proxy, `--disable-
 * dev-shm-usage` so a renderer cannot OOM the box through tmpfs, and the real
 * Chrome channel, because the bundled headless shell crashes its renderer on
 * pages of exactly this kind). Sharing would mean reimplementing all of it.
 */
export class ScrapedPageWatcher {
  private ctx: BrowserContext | null = null;
  private close: (() => Promise<void>) | null = null;
  private page: Page | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private seen = new Set<string>();
  private lastItemKey = "";
  private lastViewers = -1;
  private pollMs: number;

  private lastMessageAt = Date.now();
  private lastActivityAt = Date.now();
  private reloads = 0;
  private ended = false;
  /** What wall we are behind, when we are behind one. Held so the status line
   *  is emitted on the way in and on the way out, not once a second. */
  private blocked: string | null = null;

  constructor(
    private spec: ScrapeSpec,
    private target: SurfaceTarget,
    private ev: SurfaceEvents,
    private headless = true,
  ) {
    this.pollMs = spec.pollMs ?? 1000;
  }

  async start(): Promise<void> {
    await this.openPage();

    if (this.spec.title) {
      const t = this.spec.title(await this.page!.title());
      if (t) this.ev.onTitle?.(t);
    }

    // The first scrape is a BACKLOG, not new traffic: everything on screen was
    // said before we attached. Marking it seen is what stops a freshly attached
    // room from replaying an hour of chat through the reply pipeline.
    const backlog = await this.scrape();
    for (const m of backlog.messages) this.seen.add(dedupeKey(m));
    if (backlog.item) this.emitItem(backlog.item);
    this.ev.onStatus?.({
      connected: !backlog.blocked,
      detail: backlog.blocked
        ? `${this.spec.label}: ${backlog.blocked}`
        : `attached to ${this.target.externalId} (${backlog.messages.length} backlog)`,
    });
    this.blocked = backlog.blocked;

    this.tick();
  }

  private async openPage(): Promise<void> {
    // No eBay session. These are public pages, and the eBay profile is a
    // single-writer lock that discovery needs every five minutes — a room
    // watched for three hours would hold it for three hours.
    const opened = await openContext({
      headless: this.headless,
      userAgent: this.spec.userAgent ?? UA,
      viewport: { width: 1280, height: 900 },
      ebaySession: false,
    });
    this.ctx = opened.ctx;
    this.close = opened.close;

    // The page is a video app we never watch. Dropping media, images and fonts
    // is what makes watching a room for hours cost a browser tab rather than a
    // stream.
    await this.ctx.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") return route.abort();
      return route.continue();
    });

    await this.ctx.addInitScript(() => {
      // tsx/esbuild compiles with `keepNames`, which wraps functions in a
      // `__name` helper that does not exist in the browser. Every evaluate()
      // callback throws `__name is not defined` without this.
      (globalThis as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;

      // Present as a visible, focused tab. Both of these apps pause their chat
      // socket on `visibilitychange`, and a headless page reports itself
      // hidden — the same failure that made eBay Live deliver comments for a
      // minute and then stop while lot updates kept flowing.
      //
      // This shim is the half of that fix which can be applied from here. The
      // other half is eBay's four `--disable-*-throttling` launch flags, and
      // they are not passed: `openContext` owns the argument list, and adding
      // to it would change the browser eBay's own discovery launches every five
      // minutes. If a room's feed goes quiet with the page plainly alive, the
      // watchdog below reloads it, which is the same outcome by a slower road.
      try {
        Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
        Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
        Object.defineProperty(document, "hasFocus", { value: () => true, configurable: true });
      } catch {
        /* a page that locks these down is no worse off than before */
      }
    });

    this.page = await this.ctx.newPage();
    await this.page.goto(this.spec.url(this.target), { waitUntil: "domcontentloaded", timeout: 45_000 });
    await this.waitForFeed();
  }

  /** Wait for the feed, and do not fail the attach when it does not come.
   *  A room that is between lots, or a wall, has no messages and never will
   *  within the timeout — throwing here would turn "nobody has spoken yet"
   *  into a failed attach, and the watchdog below already handles silence. */
  private async waitForFeed(): Promise<void> {
    await this.page!
      .waitForSelector(this.spec.selectors.ready, { timeout: 30_000 })
      .catch(() => null);
  }

  private tick(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        const s = await this.scrape();
        this.noteWall(s.blocked);
        for (const m of s.messages) {
          const k = dedupeKey(m);
          if (this.seen.has(k)) continue;
          this.seen.add(k);
          this.lastMessageAt = Date.now();
          this.ev.onMessage?.({ id: m.id || k, author: m.author, text: m.text });
        }
        // The set only ever grows while a room runs; cap it.
        if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2000));
        if (s.item) this.emitItem(s.item);
        const n = s.viewers && this.spec.viewers ? this.spec.viewers(s.viewers) : null;
        if (n !== null && n !== this.lastViewers) {
          this.lastViewers = n;
          this.lastActivityAt = Date.now();
          this.ev.onViewers?.(n);
        }
        await this.watchdog();
      } catch (e) {
        // A navigation, a deploy, a closed room. Report and keep polling — a
        // transient DOM miss must not tear down the show.
        this.ev.onStatus?.({ connected: false, detail: (e as Error).message.slice(0, 120) });
        await this.recoverIfDead();
      }
      this.tick();
    }, this.pollMs);
  }

  /** Say it once on the way in and once on the way out. A challenge page held
   *  for ten minutes is one fact, not six hundred status lines. */
  private noteWall(now: string | null): void {
    if (now === this.blocked) return;
    this.blocked = now;
    this.ev.onStatus?.(
      now
        ? { connected: false, detail: `${this.spec.label}: ${now}` }
        : { connected: true, detail: `${this.spec.label}: the room is readable again` },
    );
  }

  /** Rebuild when the page, or the browser under it, has died — distinct from
   *  the silence watchdog, which reloads a page that is alive but whose socket
   *  stopped delivering. There is nothing to reload here. */
  private async recoverIfDead(): Promise<void> {
    if (this.stopped) return;
    const dead = !this.page || this.page.isClosed() || !this.ctx?.browser()?.isConnected();
    if (!dead) return;
    try {
      await this.close?.().catch(() => {});
      this.page = null;
      await this.openPage();
      // Everything on screen after a relaunch is history, not new traffic.
      const backlog = await this.scrape();
      for (const m of backlog.messages) this.seen.add(dedupeKey(m));
      this.lastMessageAt = Date.now();
      this.ev.onStatus?.({ connected: true, detail: "browser recovered — feed reattached" });
    } catch (e) {
      // Still down. The next tick tries again; there is no state to corrupt.
      this.ev.onStatus?.({ connected: false, detail: `recovery failed: ${(e as Error).message.slice(0, 100)}` });
    }
  }

  /**
   * The room is moving but chat is not. Reload.
   *
   * Telling "quiet room" from "dead socket" is the whole job: a room with
   * nothing selling and no viewers arriving is simply quiet, and reloading it
   * is churn. A room whose lots keep opening while chat has said nothing for
   * minutes has lost its feed.
   */
  private async watchdog(): Promise<void> {
    const quietMs = Date.now() - this.lastMessageAt;
    const activeMs = Date.now() - this.lastActivityAt;
    if (!this.ended && quietMs > END_SILENCE_MS && activeMs > END_SILENCE_MS) {
      this.ended = true;
      const why = `no chat, viewers or lots for ${Math.round(quietMs / 60_000)} min`;
      this.ev.onStatus?.({ connected: false, detail: `the room appears to have ended — ${why}` });
      this.ev.onEnded?.(why);
      return;
    }
    // A reload cannot get past a sign-in wall or a bot challenge; it can only
    // ask for one again. The fix for a wall is an egress the platform trusts
    // (EBAY_DISCOVERY_PROXY), and that is a human decision, not a retry.
    if (this.blocked) return;
    if (quietMs < COMMENT_SILENCE_MS || activeMs > ACTIVITY_WINDOW_MS) return;
    if (this.reloads >= MAX_RELOADS) return;

    this.reloads++;
    this.ev.onStatus?.({
      connected: false,
      detail: `chat silent ${Math.round(quietMs / 1000)}s while the room is active — reloading the feed (${this.reloads}/${MAX_RELOADS})`,
    });

    try {
      await this.page!.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
      await this.waitForFeed();
      // Everything on screen after a reload is history, not new traffic.
      const backlog = await this.scrape();
      for (const m of backlog.messages) this.seen.add(dedupeKey(m));
      this.lastMessageAt = Date.now();
      this.ev.onStatus?.({ connected: true, detail: `feed reloaded (${backlog.messages.length} backlog suppressed)` });
    } catch (e) {
      this.ev.onStatus?.({ connected: false, detail: `reload failed: ${(e as Error).message.slice(0, 100)}` });
    }
  }

  private emitItem(raw: NonNullable<PageSnapshot["item"]>): void {
    const item = this.spec.item?.(raw, this.target);
    if (!item) return;
    // Only surface an item when something a guard would care about changed.
    const key = `${item.externalRef}|${item.priceCents}|${item.soldOut}`;
    if (key === this.lastItemKey) return;
    this.lastItemKey = key;
    this.lastActivityAt = Date.now();
    this.ev.onItem?.(item);
  }

  /** One DOM read. Every selector this surface owns arrives as data. */
  private async scrape(): Promise<PageSnapshot> {
    if (!this.page) throw new Error(`${this.spec.surface} watcher not started`);
    return this.page.evaluate(extractInPage, this.spec.selectors);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.page = null;
    const close = this.close;
    this.close = null;
    this.ctx = null;
    await close?.().catch(() => {});
  }
}
