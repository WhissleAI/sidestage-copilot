// Where TikTok Live keeps the facts.
//
// Measured 2026-09-18: a plain HTTPS GET of `tiktok.com/@<handle>/live` with a
// desktop user agent returns **200 and 216 KB**, and none of it is the room.
// The rehydration blob it ships (`__UNIVERSAL_DATA_FOR_REHYDRATION__`) carries
// only app config and i18n — no live-room scope, no host, no chat. Every
// message arrives afterwards over a websocket and is rendered client-side, so
// the DOM is the only reader, exactly as on Whatnot and eBay Live.
//
// Unlike Whatnot, the same fetch also carries the captcha host and the verify
// flow, which is the measurement behind this surface being off by default:
// TikTok does not merely dislike automation, it has a challenge path it can
// drop any session into at any moment, and the thing on the other side of that
// challenge is a real person's account. See `adapter.ts`.
//
// The selectors below lead with `data-e2e`, which is TikTok's own test-hook
// attribute and the most stable thing on the page — it survives restyles and
// changes only when a component's purpose does. The hashed
// `webcast-chatroom___*` classes are listed after it as the fallback, matched
// on prefix like every other hashed class in this codebase.
//
// These have NOT been verified against a live room from this checkout, because
// verifying them means running the surface, and the surface is off. That is the
// honest state of it: `test/fixtures/tiktok-live.html` is the shape they
// assume, the test proves the extractor reads that shape, and the first person
// to turn `TIKTOK_LIVE_ENABLED` on should expect to fix a selector and update
// the fixture in the same commit.

import { audienceCount, moneyCents, type ScrapeSelectors } from "../scrapeDom.js";
import type { ScrapeSpec } from "../scrapeWatcher.js";
import type { SurfaceTarget } from "../types.js";

export const TIKTOK_SELECTORS: ScrapeSelectors = {
  ready: '[data-e2e="chat-message"], [class*="webcast-chatroom___item"]',
  message: {
    row: '[data-e2e="chat-message"], [class*="webcast-chatroom___item"]',
    // TikTok does not always put an id on a chat row — the list is keyed in
    // React and the key never reaches the DOM. When none of these is present
    // the watcher dedupes on author-and-text instead; see
    // `ScrapedPageWatcher.key` for what that costs and why it is the right way
    // to be wrong.
    id: ["data-id", "data-msg-id", "data-index", "id"],
    author: '[data-e2e="message-owner-name"], [class*="nickname"], [class*="username"]',
    text: '[data-e2e="chat-content"], [class*="chat-content"], [class*="content-word"]',
  },
  item: {
    // TikTok Shop's pinned product, when the host has one up. It is the closest
    // thing this surface has to a lot, and it is optional in a way a Whatnot
    // lot is not: most live rooms never show one.
    card: '[data-e2e="live-product-card"], [class*="product-card"], [class*="ProductCard"]',
    title: '[data-e2e="live-product-title"], [class*="product-title"], [class*="ProductTitle"]',
    price: '[data-e2e="live-product-price"], [class*="product-price"], [class*="ProductPrice"]',
    soldOut: '[data-e2e="live-product-soldout"], [class*="sold-out"], [class*="SoldOut"]',
    ref: ["data-product-id", "data-id"],
  },
  viewers: '[data-e2e="live-people-count"], [class*="viewer-count"], [class*="live-people"]',
  blocked: [
    {
      // The verification flow. Its container ids are the stable part; the
      // widget inside them is rebuilt regularly.
      what:
        "TikTok is running a verification challenge, so the room is not being read — " +
        "this one needs a person, not a retry",
      sel: '#captcha_container, [class*="captcha_verify_container"], [id*="captcha-verify"]',
    },
    {
      what: "TikTok is asking this browser to log in, so the room is not being read",
      sel: '[data-e2e="login-modal"], #login-modal, [class*="login-modal"]',
    },
    {
      // A room that ended, or a handle that is not streaming. Distinct from
      // silence: there is nothing to wait for, and saying "quiet" about it
      // would leave the operator watching a page that will never speak.
      what: "this account is not live right now",
      sel: '[data-e2e="live-end-mask"], [class*="live-end"], [class*="LiveEnded"]',
    },
  ],
};

export function tiktokUrl(t: SurfaceTarget): string {
  return `https://www.tiktok.com/@${t.externalId}/live`;
}

export const tiktokLiveSpec: ScrapeSpec = {
  surface: "tiktoklive",
  label: "TikTok Live",
  selectors: TIKTOK_SELECTORS,
  url: tiktokUrl,
  viewers: audienceCount,

  item(raw, t) {
    if (!raw.title) return null;
    return {
      externalRef: raw.ref || raw.title,
      title: raw.title,
      priceCents: moneyCents(raw.price),
      soldOut: raw.soldOut,
      url: tiktokUrl(t),
      meta: { productId: raw.ref ?? null },
    };
  },

  title(pageTitle) {
    return pageTitle.replace(/\s*[|·-]\s*TikTok.*$/i, "").trim();
  },
};
