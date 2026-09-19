// Reading a live page, in one place, so a selector is data and not a program.
//
// Whatnot and TikTok Live are the same integration problem eBay Live already
// is: no public API for the chat of a room we do not own, a React app that
// renders it, and a browser as the only reader. The eBay watcher answers that
// problem by writing the selectors inline in a `page.evaluate` callback, which
// is right for one surface and wrong for three — the callback cannot be run
// outside a browser, so the only way to know whether a selector still works is
// to point it at a live room and watch.
//
// So the DOM read is split in two. The part that is the SAME on every scraped
// surface — walk the rows, take an id off an attribute, pull an author and a
// text out of each — is `extractInPage` below, and it is generic. The part that
// differs — WHICH attribute, WHICH class prefix — is a `ScrapeSelectors` table
// living in each surface's `scrape.ts`, and a table is something a fixture can
// be tested against without a browser (test/scraped-surfaces.test.ts).
//
// `extractInPage` is handed to `page.evaluate`, which serialises it with
// `toString()`. That is why it closes over NOTHING: no imports, no module
// constants, no helpers defined outside it. Every value it needs arrives as its
// argument, and `document` it reads off `globalThis` — which is also what lets
// the test call it directly with a parsed fixture in that slot.

/** The three DOM members a scrape actually uses. A real `Element` satisfies
 *  this structurally; so does the test's parsed fixture, which is the point. */
export interface ElementLike {
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
  querySelector(selector: string): ElementLike | null;
  querySelectorAll(selector: string): Iterable<ElementLike>;
}

export interface DocumentLike {
  querySelector(selector: string): ElementLike | null;
  querySelectorAll(selector: string): Iterable<ElementLike>;
}

/**
 * Where the facts are on one surface's page.
 *
 * Every value is a CSS selector or an attribute name, i.e. serialisable, i.e.
 * it survives the trip into `page.evaluate` as data. Comma lists are allowed
 * and used heavily: both platforms ship more than one markup at a time (an A/B
 * test, a slow rollout, a mobile-width tree), and "either of these two shapes"
 * is a thing CSS already says well.
 */
export interface ScrapeSelectors {
  /** What must exist before the page counts as loaded. Matched the way the
   *  eBay watcher matches `li[data-id]` and not a bare `li`: waiting on the
   *  feed's own spacer element returns instantly, the backlog scrape then sees
   *  zero messages, and the next poll replays the room's whole visible history
   *  into the reply pipeline as if it were new traffic. */
  ready: string;
  message: {
    row: string;
    /** Attributes to try, in order, for the platform's own message id. The
     *  first one present wins, and an empty string means the row carried none
     *  — `ScrapedPageWatcher.key` decides what to dedupe on then. */
    id: readonly string[];
    author: string;
    text: string;
  };
  /** The thing currently on sale, when the surface has one. */
  item?: {
    card: string;
    title: string;
    price?: string;
    qty?: string;
    /** Presence means sold out — a badge, not a text match. */
    soldOut?: string;
    /** Attributes on the card carrying the platform's own id for it. */
    ref?: readonly string[];
  };
  viewers?: string;
  /** A wall, not a room. Each entry names what the operator is actually
   *  looking at, because "sign in" and "prove you are not a robot" have
   *  different fixes and a single `connected: false` tells them apart for
   *  nobody. */
  blocked?: readonly { what: string; sel: string }[];
}

/** Raw strings, exactly as the page had them. `extractInPage` parses nothing:
 *  deciding WHICH number a card meant — is that the current bid or the buy-it-
 *  now, is that watching-now or total-joined — is a judgement about one
 *  platform's UI and belongs in that platform's `scrape.ts`. Getting the digits
 *  out of "$1,250.00" is not a judgement, and lives at the bottom of this file
 *  so two surfaces cannot disagree about it. */
export interface PageSnapshot {
  messages: { id: string; author: string; text: string }[];
  item: {
    ref: string | null; title: string; price: string; qty: string; soldOut: boolean;
  } | null;
  viewers: string | null;
  /** The `what` of the first matching `blocked` entry, or null. */
  blocked: string | null;
}

/**
 * One DOM read, on any scraped surface.
 *
 * Runs inside the page under Playwright and inside the test against a parsed
 * fixture. Self-contained by necessity (see the header) — if you add a helper,
 * define it inside this function or the browser will throw `… is not defined`
 * at a call site nothing in the repo can reproduce.
 *
 * Text comes off `textContent`, never `innerText`. `innerText` is defined in
 * terms of LAYOUT: it collapses what CSS hid and inserts line breaks where
 * boxes broke, so its value depends on the viewport, the fonts that resolved
 * and whether the renderer got as far as laying the node out. That is a fine
 * source when a human is looking at the page and a terrible one for a fixture,
 * which has no layout at all.
 */
export function extractInPage(sel: ScrapeSelectors): PageSnapshot {
  const doc = (globalThis as unknown as { document: DocumentLike }).document;
  const txt = (e: ElementLike | null | undefined): string =>
    (e?.textContent || "").replace(/\s+/g, " ").trim();

  for (const b of sel.blocked || []) {
    if (doc.querySelector(b.sel)) {
      // Stop at the first wall. A challenge page has no chat to read, and
      // reporting "0 messages" from it is the failure this check exists to
      // prevent: an operator watching a room that is silently not being read.
      return { messages: [], item: null, viewers: null, blocked: b.what };
    }
  }

  const messages: { id: string; author: string; text: string }[] = [];
  for (const row of doc.querySelectorAll(sel.message.row)) {
    let id = "";
    for (const attr of sel.message.id) {
      const v = row.getAttribute(attr);
      if (v) { id = v; break; }
    }
    const author = txt(row.querySelector(sel.message.author));
    const text = txt(row.querySelector(sel.message.text));
    // A row with no author and no text is chrome — a date separator, a
    // "welcome to the stream" system card, the feed's own spacer.
    if (author || text) messages.push({ id, author, text });
  }

  let item: PageSnapshot["item"] = null;
  if (sel.item) {
    const card = doc.querySelector(sel.item.card);
    if (card) {
      let ref: string | null = null;
      for (const attr of sel.item.ref || []) {
        const v = card.getAttribute(attr);
        if (v) { ref = v; break; }
      }
      item = {
        ref,
        title: txt(card.querySelector(sel.item.title)),
        price: sel.item.price ? txt(card.querySelector(sel.item.price)) : "",
        qty: sel.item.qty ? txt(card.querySelector(sel.item.qty)) : "",
        soldOut: Boolean(sel.item.soldOut && card.querySelector(sel.item.soldOut)),
      };
    }
  }

  const viewers = sel.viewers ? txt(doc.querySelector(sel.viewers)) || null : null;
  return { messages, item, viewers, blocked: null };
}

// ── digits ────────────────────────────────────────────────────────────────────
//
// Shared because both platforms write money and audiences the way every
// consumer app does, and because two copies of "strip everything but digits"
// is two places to fix when one of them turns out to drop a decimal.

/** "$1,250.00" → 125000. Zero for anything with no number in it, which is what
 *  a card shows for the first frames after a lot opens. */
export function moneyCents(text: string): number {
  const n = Number((text || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** "1.2K watching" → 1200, "1,204 viewers" → 1204, "" → null.
 *
 *  The K/M suffix is not decoration: both platforms switch to it above a
 *  thousand, so a room that crosses that line would otherwise read as its
 *  viewer count collapsing from 999 to 1 — a drop the activity watchdog would
 *  take as real movement and the console would draw as a cliff. */
export function audienceCount(text: string): number | null {
  const m = (text || "").replace(/,/g, "").match(/([0-9]*\.?[0-9]+)\s*([KkMm])?/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const scale = m[2] ? (m[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1;
  return Math.round(n * scale);
}
