// Whatnot's public browse and search pages, read the way the rooms are read.
//
// This was an INVESTIGATION before it was a file, and the measurements are the
// reason it exists rather than a paragraph saying Whatnot has no discovery.
// All four taken 2026-09-18/19 from this repo's own `openContext`:
//
//   · Plain HTTPS GET of `whatnot.com/browse` with a desktop user agent:
//     **403, 5.6 KB, `<title>Just a moment…</title>`** — Cloudflare's managed
//     challenge. Same for `/search` and every `/tag/<x>`. There is no cheap
//     reader here and there never was.
//   · The SAME URLs in **headless real Chrome** through `openContext`
//     (`channel: "chrome"`, `--disable-dev-shm-usage`, the discovery proxy when
//     one is set): **200, no challenge element present**, ~7.5 s to a painted
//     grid.
//   · `/browse` renders a category index with live viewer counts per category
//     (`/tag/sports_cards` → "12.2K Viewers") and no show cards.
//   · `/tag/<category>` and `/search?query=<term>` BOTH render show cards:
//     420 anchors on the sports-cards tag, 259 on a search for "pokemon", each
//     card carrying `data-testid="livestream-card"`, the room's own
//     `/live/<uuid>`, the host's `/user/<handle>`, an un-truncated title in a
//     `title` attribute, Whatnot's category link, the seller's own tag list,
//     and a "Live · 2.2k" badge.
//
// So Whatnot IS readable headlessly, and the honest verdict is "yes here,
// unverified there". Every measurement above was taken from a laptop on a
// residential connection. Production is a t3.small on a datacentre address, and
// Cloudflare grades the network as well as the browser — eBay Live taught this
// product exactly that lesson, reading 224 events from the laptop and ZERO from
// the box.
//
// Nothing below tries to get around that, and that is a decision rather than an
// omission: no user-agent rotation, no fingerprint patching of our own, no
// challenge solving. The read uses the same real Chrome and the same user agent
// the room watcher already uses, and when Whatnot declines, the source says it
// declined. Two checks make that safe to ship somewhere untested — the
// challenge is recognised by its own markup, and `shell` below catches the
// worse case where a page answers 200 and renders nothing, which would
// otherwise be indistinguishable from a quiet night on Whatnot.
//
// The DOM read follows `scrapeDom.ts`'s rule: one self-contained function that
// closes over NOTHING, so it runs inside `page.evaluate` and inside the test
// against a parsed fixture, and a broken selector is a failing test rather than
// a discovery that quietly returns nothing at 9pm on a Friday.

import type { DocumentLike, ElementLike } from "../scrapeDom.js";

/** Where the facts are on a browse, tag or search page. Selectors only — data,
 *  so it survives the trip into the page. */
export interface BrowseSelectors {
  card: string;
  /** The room's own link. Its href carries the id the watcher attaches to. */
  live: string;
  host: string;
  /** The un-truncated title lives in an attribute; the text is line-clamped. */
  title: string;
  titleAttr: string;
  /** Whatnot's own category for the room. */
  tag: string;
  /** The seller's own tags — "$1 Starts, Vintage, Sudden Death". */
  sellerTags: string;
  /**
   * Proof that this is the real page at all.
   *
   * The load-bearing check, and the reason it is separate from `card`. A
   * challenge page is recognisable; a page that merely renders NOTHING is not,
   * and "zero cards" from it is indistinguishable from "nobody is selling that
   * tonight". Every genuine browse, tag and search page carries the category
   * rail and the Browse link in its header whether or not anything matched —
   * so the absence of this, with no challenge element either, means we are not
   * looking at Whatnot's grid and must say so rather than report a quiet night.
   */
  shell: string;
  blocked: readonly { what: string; sel: string }[];
}

export const WHATNOT_BROWSE_SELECTORS: BrowseSelectors = {
  // A `data-testid` is preferred over a class for the reason the room selectors
  // prefer it: a test id changes when the component's PURPOSE changes, a hashed
  // CSS-module class changes when somebody edits its stylesheet. `data-type` is
  // carried as a second shape because the card ships both today.
  card: '[data-testid="livestream-card"], [data-type="LivestreamCard"]',
  live: 'a[href^="/live/"]',
  host: 'a[href^="/user/"]',
  title: 'a[href^="/live/"] strong',
  titleAttr: "title",
  tag: 'a[href^="/tag/"]',
  sellerTags: "span[title]",
  shell: 'a[href^="/tag/"], a[href="/browse"], [data-testid="livestream-card"]',
  blocked: [
    {
      // Measured: the 403 body carries `#challenge-error-text` and nothing else
      // identifiable. The interactive variant renders the Turnstile widget.
      // Said plainly and prescribing nothing. There is deliberately no evasion
      // here — no user-agent rotation, no challenge solving, no fingerprint
      // games. This reads the page with the same real Chrome and the same
      // user agent the room watcher already uses, and when Whatnot declines,
      // the honest answer is that it declined.
      what:
        "Cloudflare is challenging this server's browser, so Whatnot's grid is not being read — " +
        "attaching to a room by pasting its link is unaffected",
      sel: '#challenge-error-text, #challenge-running, #cf-chl-widget, [class*="cf-turnstile"]',
    },
    {
      what: "Whatnot is asking this browser to sign in, so the grid is not being read",
      sel: '[data-testid="login-modal"], [data-testid="auth-gate"], [class*="SignupGate"]',
    },
  ],
};

/** One card, in the page's own words. Nothing is parsed here — what "2.2k"
 *  means is a judgement about Whatnot's UI and lives with the source. */
export interface BrowseCard {
  /** The room's uuid, which is what `whatnotAdapter.parseTarget` takes. */
  id: string;
  title: string;
  host: string | null;
  /** Whatnot's category, then the seller's own tags. */
  tags: string[];
  /** "2.2k", or null on a card with no live badge. */
  viewersRaw: string | null;
  liveNow: boolean;
  url: string;
}

export interface BrowseSnapshot {
  cards: BrowseCard[];
  /** The `what` of the first matching wall, or null. */
  blocked: string | null;
  /** Did Whatnot's own page furniture render? False means whatever answered
   *  was not the grid, however healthy the HTTP status looked. */
  shell: boolean;
}

/**
 * Read every show card on a Whatnot browse, tag or search page.
 *
 * Runs inside the page under Playwright and inside the test over a parsed
 * fixture. Self-contained by necessity — a helper defined outside this function
 * throws `… is not defined` at a call site nothing in the repo can reproduce.
 *
 * Text comes off `textContent`, never `innerText`, for the reason
 * `extractInPage` gives: `innerText` is defined in terms of layout, and a
 * fixture has none.
 */
export function readBrowseInPage(sel: BrowseSelectors): BrowseSnapshot {
  const doc = (globalThis as unknown as { document: DocumentLike }).document;
  const txt = (e: ElementLike | null | undefined): string =>
    (e?.textContent || "").replace(/\s+/g, " ").trim();

  for (const b of sel.blocked || []) {
    // Stop at the first wall. A challenge page has no grid on it, and reporting
    // "nothing on air" from one is the failure this check exists to prevent.
    if (doc.querySelector(b.sel)) return { cards: [], blocked: b.what, shell: false };
  }

  const shell = Boolean(doc.querySelector(sel.shell));

  const cards: BrowseCard[] = [];
  const seen: Record<string, true> = {};
  for (const card of doc.querySelectorAll(sel.card)) {
    const live = card.querySelector(sel.live);
    const href = live?.getAttribute("href") || "";
    const id = (href.match(/\/live\/([A-Za-z0-9-]{6,})/) || [])[1] || "";
    if (!id || seen[id]) continue;
    seen[id] = true;

    const titleEl = card.querySelector(sel.title);
    const title = (titleEl?.getAttribute(sel.titleAttr) || txt(titleEl) || "").trim();

    const hostEl = card.querySelector(sel.host);
    const hostHref = hostEl?.getAttribute("href") || "";
    const host = (hostHref.match(/\/user\/([^/?#]+)/) || [])[1] || txt(hostEl) || "";

    const tags: string[] = [];
    for (const t of card.querySelectorAll(sel.tag)) {
      const v = txt(t);
      if (v) tags.push(v);
    }
    for (const t of card.querySelectorAll(sel.sellerTags)) {
      const v = (t.getAttribute("title") || "").trim();
      // The card's own title attribute is on the title element, not a tag.
      if (v && v !== title) tags.push(v);
    }

    // The live badge reads "Live · 2.2k". A card with no badge is scheduled or
    // a replay: not live, and with no audience anybody measured.
    const badge = (card.textContent || "").replace(/\s+/g, " ");
    const m = badge.match(/Live\s*[·•|]\s*([0-9][0-9.,]*\s*[kKmM]?)/);

    cards.push({
      id,
      title,
      host: host || null,
      tags,
      viewersRaw: m ? m[1]!.trim() : null,
      liveNow: Boolean(m) || /\bLive\b/.test(badge.slice(0, 40)),
      url: `https://www.whatnot.com/live/${id}`,
    });
  }

  return { cards, blocked: null, shell: shell || cards.length > 0 };
}
