// Where Whatnot keeps the facts.
//
// Whatnot has no public API. The partner API it does have is for inventory and
// order sync under a signed agreement, and it does not carry a room's chat at
// all — so a copilot that helps a seller DURING their show has one way in, the
// same one eBay Live needed: the public page in a real browser.
//
// Two measurements shape everything below.
//
//   1. 2026-09-18, a plain HTTPS GET of `whatnot.com/live/<id>` with a normal
//      desktop user agent: **403, 5.8 KB, `<title>Just a moment...</title>`**
//      — Cloudflare's interstitial, not the room. Whatnot is behind a managed
//      challenge. That is why this surface drives real Chrome through
//      `openContext` (which already carries `EBAY_DISCOVERY_PROXY`, the egress
//      that exists precisely because a datacenter address gets treated as a
//      robot), and why the first thing the extractor looks for is the
//      challenge page. A room nobody is reading must SAY it is not being read.
//   2. The room itself is client-rendered. Nothing in the delivered HTML holds
//      a message, so there is no cheaper reader than a browser and no JSON
//      blob to prefer over the DOM.
//
// The selectors are therefore the volatile part, and they are volatile in a
// specific, known way: Whatnot ships hashed CSS-module class names, so a class
// is matched on its PREFIX and never whole, exactly as the eBay watcher matches
// `chatMessage-BPsSWw`. Where the app ships a `data-testid`, that is preferred
// — a test id changes when the component's PURPOSE changes, a class changes
// when someone edits its stylesheet.
//
// `test/fixtures/whatnot-live.html` is the contract these selectors assume. It
// is a hand-trimmed page of that shape, not a capture of a particular room —
// capturing one would mean shipping a real seller's chat into the repo, and the
// challenge above means it cannot be re-captured on demand anyway. When Whatnot
// changes, change the fixture and the selectors in the same commit: the test
// is then the thing that tells you whether the extractor still works, instead
// of a live room at 9pm on a Friday.

import { audienceCount, moneyCents, type ScrapeSelectors } from "../scrapeDom.js";
import type { ScrapeSpec } from "../scrapeWatcher.js";
import type { SurfaceTarget } from "../types.js";

export const WHATNOT_SELECTORS: ScrapeSelectors = {
  ready: '[data-testid="chat-message"], [data-message-id], ul[class*="chatFeed"] li[data-id]',
  message: {
    row: '[data-testid="chat-message"], [data-message-id], ul[class*="chatFeed"] li[data-id]',
    // Whatnot's feed is virtualised: rows are recycled as it scrolls, so the
    // DOM position of a message is meaningless and its id is the only thing
    // that survives. Server-issued, so it also survives a reload — which is
    // what makes the backlog suppression after a reload correct rather than
    // approximate.
    id: ["data-message-id", "data-id", "id"],
    author: '[data-testid="chat-message-username"], [class*="username"], [class*="Username"]',
    text: '[data-testid="chat-message-body"], [class*="messageText"], [class*="MessageText"]',
  },
  item: {
    card: '[data-testid="auction-card"], [data-testid="current-listing"], [class*="AuctionCard"]',
    title: '[data-testid="listing-title"], [class*="listingTitle"], h2, h3',
    // The CURRENT BID, not the start price and not the buy-it-now. On a live
    // auction the bid is the only number a buyer's question is ever about, and
    // it is the number the stale-price guard compares a draft against.
    price: '[data-testid="current-bid"], [class*="currentBid"], [class*="CurrentBid"]',
    soldOut: '[data-testid="sold-badge"], [class*="soldBadge"], [class*="SoldBadge"]',
    ref: ["data-listing-id", "data-lot-id", "data-id"],
  },
  viewers: '[data-testid="viewer-count"], [class*="viewerCount"], [class*="ViewerCount"]',
  blocked: [
    {
      // Measured, not guessed: the 403 body above carries `#challenge-error-text`
      // and nothing else identifiable. Turnstile's widget id is listed with it
      // because the interactive variant of the same challenge renders that one.
      what:
        "Cloudflare is challenging this browser, so the room is not being read — " +
        "point EBAY_DISCOVERY_PROXY at an egress Whatnot trusts",
      sel: '#challenge-error-text, #challenge-running, #cf-chl-widget, [class*="cf-turnstile"]',
    },
    {
      what: "Whatnot is asking this browser to sign in, so the room is not being read",
      sel: '[data-testid="login-modal"], [data-testid="auth-gate"], [class*="SignupGate"]',
    },
  ],
};

/** `whatnot.com/live/<id>` when we have the room's own id, and the host's live
 *  URL when all we were given is a handle. Whatnot redirects the second to the
 *  first, so a handle-addressed watch follows the host into whatever room they
 *  open — which is what a seller pasting their own profile means by it. */
export function whatnotUrl(t: SurfaceTarget): string {
  return t.meta?.kind === "handle"
    ? `https://www.whatnot.com/user/${t.externalId}/live`
    : `https://www.whatnot.com/live/${t.externalId}`;
}

export const whatnotSpec: ScrapeSpec = {
  surface: "whatnot",
  label: "Whatnot",
  selectors: WHATNOT_SELECTORS,
  url: whatnotUrl,
  viewers: audienceCount,

  item(raw, t) {
    // A card with no title is a card mid-transition — Whatnot renders the frame
    // before the lot's data arrives. Emitting it would put an item called ""
    // into the catalog view and, worse, would reset the change key so the real
    // lot a beat later looked like the same one.
    if (!raw.title) return null;
    return {
      // The platform's own lot id when the card carries one; the title
      // otherwise, which is what the eBay adapter uses for the same reason —
      // it is the only stable thing a guard can match a draft's claim against.
      externalRef: raw.ref || raw.title,
      title: raw.title,
      priceCents: moneyCents(raw.price),
      soldOut: raw.soldOut,
      url: whatnotUrl(t),
      meta: { lotId: raw.ref ?? null },
    };
  },

  title(pageTitle) {
    return pageTitle.replace(/\s*[|·-]\s*Whatnot.*$/i, "").trim();
  },
};
