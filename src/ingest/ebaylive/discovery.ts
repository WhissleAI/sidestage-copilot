// Discover which eBay Live shows are on air, and who is running them.
//
// The history of this file is worth keeping, because it explains the shape.
//
// It used to scrape the live grid anonymously and find nothing, so a fallback
// swept the DOM for any 16-character id. Those ids exist — they are eBay's
// FILTER TAGS — so Discover confidently listed "Raw Cards", "$1 Starts" and
// "Coins & Bullion" as monitorable live shows, each with zero viewers and an id
// that 404s on attach. Eleven things that were not shows.
//
// The actual constraint, measured rather than guessed: the grid module streams
// in client-side and does not stream for anonymous visitors. A signed-out
// headless browser waited out to forty seconds finds ZERO event links on the
// page that shows fifty to a signed-in one. No selector fixes that.
//
// So discovery needs a session (`npm run ebay:signin`), and without one it says
// so instead of returning something. An event id now comes only from a real
// `/ebaylive/events/<id>` link — never from a shape that merely looks like one.

import type { BrowserContext } from "playwright";
import { openContext, sessionStatus, withProfileLock } from "./session.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface DiscoveredShow {
  eventId: string;
  title: string;
  /** The show's display name for the seller — what the card shows. */
  host: string;
  /** The handle in the card's own seller link, which is what Browse filters on
   *  and therefore what makes a per-event catalog possible. */
  sellerHandle: string | null;
  viewers: number;
  url: string;
  thumbnailUrl: string | null;
  /** eBay's own tags — "$1 Starts", "Pokémon", "Vintage". The best signal we
   *  have for what a show is actually selling before it starts. */
  tags: string[];
  /** A scheduled card has a start time where a live one has a viewer count. */
  status: "live" | "scheduled";
  /** eBay's own wording — "Today, 4pm", "Tomorrow, 10am". Kept as text: it is
   *  relative to the viewer's clock and eBay does not publish the instant. */
  startsAt: string | null;
}

export interface DiscoveryResult {
  shows: DiscoveredShow[];
  /** Why the list is empty, when it is. The console renders these differently:
   *  "sign in" is an action, "nothing on air" is a fact. */
  reason: "ok" | "no-session" | "stale-session" | "signed-out" | "blocked";
  session: ReturnType<typeof sessionStatus>;
}

async function withBrowser<T>(fn: (ctx: BrowserContext) => Promise<T>, headless: boolean): Promise<T> {
  return withProfileLock(() => withBrowserUnlocked(fn, headless));
}

async function withBrowserUnlocked<T>(fn: (ctx: BrowserContext) => Promise<T>, headless: boolean): Promise<T> {
  // Real Chrome either way — from the persistent profile on a developer's
  // machine, or from the exported state on a server. See `openContext`: the
  // bundled headless shell is exactly what eBay Live refuses to stream to.
  const { ctx, close } = await openContext({ headless, userAgent: UA });
  try {
    // Images and fonts are most of the bytes on this page and none of the data.
    await ctx.route("**/*", (r) => {
      const t = r.request().resourceType();
      return t === "image" || t === "media" || t === "font" ? r.abort() : r.continue();
    });
    // tsx/esbuild compiles with `keepNames`, which wraps functions in a `__name`
    // helper that does not exist in the browser. Any evaluate() callback throws
    // `__name is not defined` without this.
    await ctx.addInitScript(() => {
      (globalThis as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
    });
    return await fn(ctx);
  } finally {
    await close();
  }
}

/**
 * eBay's own verdict on the session, read from the page header. "Hi karan!" is
 * signed in; "Hi! Sign in or register" is not — and a signed-out browser gets
 * the anonymous grid, which streams nothing and shows a "technical issue"
 * banner. That banner used to be read as eBay refusing the network. It was
 * eBay saying the session had ended: measured on 2026-09-14, when a session
 * that read 224 events at 13:00 read zero at 21:00 from the SAME machine,
 * headed or headless, proxied or not, while the user's own Chrome showed 96.
 */
function readSignedOut(): boolean {
  const header = (document.querySelector("#gh, header") as HTMLElement | null)?.innerText ?? document.body.innerText.slice(0, 400);
  return /Sign in or register/i.test(header) || !/\bHi\s+\S/.test(header.replace(/Hi!\s*Sign in/i, ""));
}

/**
 * The card reader, run inside the page.
 *
 * Written against the real rendered markup: each card is an ancestor of an
 * `/ebaylive/events/<id>/stream` link that also carries the seller link, the
 * viewer count as a bare number, the title, and eBay's tag row. Walking up from
 * the link until the block has three lines of text is what finds the card
 * without depending on a class name that changes on every eBay deploy.
 */
function readCards(): DiscoveredShow[] {
  const out: DiscoveredShow[] = [];
  const seen = new Set<string>();

  for (const a of document.querySelectorAll('a[href*="/ebaylive/events/"]')) {
    const href = (a as HTMLAnchorElement).getAttribute("href") || "";
    const eventId = href.match(/events\/([A-Za-z0-9_-]{8,})/)?.[1];
    if (!eventId || seen.has(eventId)) continue;

    let el: HTMLElement | null = a as HTMLElement;
    for (let i = 0; i < 8 && el; i++) {
      if ((el.innerText || "").split("\n").filter(Boolean).length >= 3) break;
      el = el.parentElement;
    }
    if (!el) continue;
    seen.add(eventId);

    const lines = (el.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    // A live card carries a bare viewer count; a scheduled card carries a start
    // time in its place — "Today, 4pm", "Tomorrow, 10:30am", "Sat, 7pm". The
    // longest remaining line is the title and the other short one the seller.
    const startsAt =
      lines.find((l) => /^(today|tomorrow|mon|tue|wed|thu|fri|sat|sun)\b.*\d/i.test(l)) ?? null;
    const viewers = Number((lines.find((l) => /^\d[\d,]*$/.test(l)) || "0").replace(/,/g, ""));
    const words = lines.filter((l) => !/^\d[\d,]*$/.test(l) && l !== startsAt);
    const title = words.slice().sort((x, y) => y.length - x.length)[0] ?? "";
    const host = words.find((l) => l !== title) ?? "";

    const sellerHref = el.querySelector('a[href*="/ebaylive/sellers/"]')?.getAttribute("href") ?? "";
    const img = el.querySelector("img")?.getAttribute("src") ?? null;
    const tags = [...el.querySelectorAll('a[href*="/ebaylive/tags/"]')]
      .map((t) => (t as HTMLElement).innerText.trim())
      .filter(Boolean);

    out.push({
      eventId,
      title,
      host,
      sellerHandle: sellerHref.split("/").filter(Boolean).pop() ?? null,
      viewers,
      url: `https://www.ebay.com/ebaylive/events/${eventId}/stream`,
      thumbnailUrl: img,
      tags,
      status: startsAt && !viewers ? "scheduled" : "live",
      startsAt,
    });
  }
  return out;
}

/**
 * Live shows, from the grid.
 *
 * Needs a session. Without one this returns `reason: "no-session"` and an empty
 * list rather than an empty list that looks like a quiet night.
 */
export async function discoverLiveShows(
  opts: { limit?: number; headless?: boolean } = {},
): Promise<DiscoveryResult> {
  const session = sessionStatus();
  if (!session.present) return { shows: [], reason: "no-session", session };

  const shows = await withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    // `networkidle` never fires here — a live index streams telemetry forever —
    // so load on DOM ready and then scroll, because the grid is lazy-mounted.
    await page.goto("https://www.ebay.com/ebaylive", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page
      .waitForSelector('a[href*="/ebaylive/events/"]', { timeout: 25_000 })
      .catch(() => null);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(900);
    }
    const cards = await page.evaluate(readCards);
    const signedOut = cards.length === 0 ? await page.evaluate(readSignedOut) : false;
    return { cards, signedOut };
  }, opts.headless ?? true).then((r) => (Array.isArray(r) ? { cards: r, signedOut: false } : r));

  if (shows.cards.length === 0) {
    // A session we have but that yields nothing is one of three things, and
    // the difference matters to whoever has to fix it: eBay ended the session
    // (sign in again), the export is old (re-export), or eBay refused this
    // browser (the network or the automation, and only measurement says which).
    const reason = shows.signedOut ? "signed-out" : session.stale ? "stale-session" : "blocked";
    return { shows: [], reason, session };
  }

  return {
    shows: shows.cards.filter((s) => s.title).sort((a, b) => b.viewers - a.viewers).slice(0, opts.limit ?? 24),
    reason: "ok",
    session,
  };
}

/**
 * A seller's own eBay Live page — their live show and whatever they have
 * scheduled.
 *
 * This is the surface a followed seller is checked against, and the only place
 * eBay puts an upcoming show. Same session requirement as the grid.
 */
export async function discoverSellerShows(handle: string): Promise<DiscoveryResult> {
  const session = sessionStatus();
  if (!session.present) return { shows: [], reason: "no-session", session };

  const clean = handle.trim().replace(/^@/, "");
  const shows = await withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(`https://www.ebay.com/ebaylive/sellers/${encodeURIComponent(clean)}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page
      .waitForSelector('a[href*="/ebaylive/events/"]', { timeout: 20_000 })
      .catch(() => null);
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(800);
    }
    const cards = await page.evaluate(readCards);
    const signedOut = cards.length === 0 ? await page.evaluate(readSignedOut) : false;
    return { cards, signedOut };
  }, true);

  return {
    shows: shows.cards,
    reason: shows.cards.length ? "ok" : shows.signedOut ? "signed-out" : session.stale ? "stale-session" : "blocked",
    session,
  };
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
  const { shows, reason, session } = await discoverLiveShows({ limit: 20 });
  if (reason !== "ok") {
    console.log(`\n  no shows — ${reason}`);
    console.log(`  session: ${session.present ? `${session.ageHours}h old` : "none — run `npm run ebay:signin`"}\n`);
  } else {
    console.log(`\n${shows.length} eBay Live shows on air:\n`);
    for (const s of shows) {
      console.log(`  ${String(s.viewers).padStart(5)}  ${s.eventId.padEnd(18)}  ${s.title.slice(0, 58)}`);
      console.log(`         ${s.host}${s.sellerHandle ? ` (@${s.sellerHandle})` : ""}  ${s.tags.join(" · ")}`);
    }
    console.log();
  }
}
