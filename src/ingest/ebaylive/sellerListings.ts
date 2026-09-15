// A seller's active listings, read from their public results page through the
// signed-in browser profile.
//
// The Browse API does this properly — `filter=sellers:{username}` — and is the
// first choice. It has one precondition this product cannot always meet: the
// API environment has to know the seller. A SANDBOX key does not know a single
// production seller, so every real eBay Live host is "invalid" to it, and a
// product with sandbox credentials would never be able to prepare a real show.
//
// The results page has no such precondition. It is public, it lists the same
// listings, and with the session `npm run ebay:signin` created it renders for
// us. It is also a scrape, subject to selector drift on any eBay deploy — which
// is why it is the fallback and why every catalog built from it says so.
//
// Read once per seller and cached: a page load is seconds, and preparing four
// of one seller's scheduled shows should read their page once.

import { hasSession, openContext, withProfileLock } from "./session.js";
import type { EbayListing } from "../ebay/client.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TTL_MS = 15 * 60_000;
const cache = new Map<string, { at: number; rows: EbayListing[] }>();

/** Runs inside the page. Written against the live markup: `li.s-card`. */
function readResults(): { id: string; title: string; price: string; condition: string; img: string; href: string }[] {
  const out: { id: string; title: string; price: string; condition: string; img: string; href: string }[] = [];
  for (const card of document.querySelectorAll("li.s-card, li.s-item")) {
    // The title node carries a screen-reader suffix ("Opens in a new window or
    // tab") on its own line; the listing's name is the first line only.
    const title =
      (card.querySelector(".s-card__title, .s-item__title") as HTMLElement | null)?.innerText
        ?.split("\n")[0]
        ?.trim() ?? "";
    // Two kinds of row that are not inventory: eBay's own "Shop on eBay"
    // promotional filler, and the $100 "Live show link" placeholders sellers
    // list to advertise a show. Thirteen of the latter sat at the top of one
    // seller's newest-first results and would have been the catalog's opening
    // lots.
    if (!title || /^shop on ebay$/i.test(title) || /live show link/i.test(title)) continue;
    const a = card.querySelector('a[href*="/itm/"]') as HTMLAnchorElement | null;
    const href = a?.href ?? "";
    const id = card.getAttribute("data-listingid") || href.match(/\/itm\/(\d{9,})/)?.[1] || "";
    if (!id) continue;
    const price = (card.querySelector(".s-card__price, .s-item__price") as HTMLElement | null)?.innerText?.trim() ?? "";
    const condition = (card.querySelector(".s-card__subtitle, .SECONDARY_INFO") as HTMLElement | null)?.innerText?.trim() ?? "";
    const img = (card.querySelector("img") as HTMLImageElement | null)?.src ?? "";
    out.push({ id, title: title.replace(/^new listing/i, "").trim(), price, condition, img, href });
  }
  return out;
}

const usernames = new Map<string, string | null>();

/**
 * The eBay USERNAME behind an eBay Live seller page.
 *
 * Three names attach to one seller and only one of them keys their listings.
 * The card shows a display name ("GoldStandardAuction"); the seller link uses a
 * Live-page slug ("q_EImPfySam"); the listings page and the Browse API want the
 * account username ("gold_standard_guy"). The Live seller page carries a link to
 * `/usr/<username>`, which is the one reliable bridge between them. Without this
 * step a seller only resolved when their display name happened to equal their
 * username — which is why one of two real shows prepared and the other did not.
 */
export async function resolveSellerUsername(slug: string): Promise<string | null> {
  const key = slug.toLowerCase();
  if (usernames.has(key)) return usernames.get(key) ?? null;
  if (!hasSession()) return null;
  return withProfileLock(() => resolveUnlocked(slug, key));
}

async function resolveUnlocked(slug: string, key: string): Promise<string | null> {
  const { ctx, close } = await openContext({ headless: true, userAgent: UA });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`https://www.ebay.com/ebaylive/sellers/${encodeURIComponent(slug)}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForSelector('a[href*="/usr/"]', { timeout: 15_000 }).catch(() => null);
    const href = await page
      .evaluate(() => document.querySelector('a[href*="/usr/"]')?.getAttribute("href") ?? null)
      .catch(() => null);
    const username = href?.match(/\/usr\/([^/?#]+)/)?.[1] ?? null;
    usernames.set(key, username);
    return username;
  } finally {
    await close();
  }
}

export async function sellerListings(username: string, limit = 120): Promise<EbayListing[]> {
  const key = username.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows.slice(0, limit);

  if (!hasSession()) return [];
  return withProfileLock(() => listingsUnlocked(username, key, limit));
}

async function listingsUnlocked(username: string, key: string, limit: number): Promise<EbayListing[]> {
  const { ctx, close } = await openContext({ headless: true, userAgent: UA });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await ctx.route("**/*", (r) => {
      const t = r.request().resourceType();
      return t === "media" || t === "font" ? r.abort() : r.continue();
    });
    await page.goto(
      `https://www.ebay.com/sch/i.html?_ssn=${encodeURIComponent(username)}&_sop=10&_ipg=${Math.min(240, limit)}`,
      { waitUntil: "domcontentloaded", timeout: 45_000 },
    );
    await page.waitForSelector("li.s-card, li.s-item", { timeout: 20_000 }).catch(() => null);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(500);
    }
    const raw = await page.evaluate(readResults);

    const rows: EbayListing[] = [];
    for (const r of raw) {
      // "$100.00", "$12.50 to $40.00", "GBP 9.99" — take the first number.
      const cents = Math.round(Number((r.price.match(/[\d,]+(?:\.\d+)?/)?.[0] ?? "").replace(/,/g, "")) * 100);
      if (!Number.isFinite(cents) || cents <= 0) continue;
      rows.push({
        itemId: r.id,
        title: r.title,
        priceCents: cents,
        currency: /^\$|USD/.test(r.price) ? "USD" : r.price.replace(/[\d.,\s]/g, "").slice(0, 3) || "USD",
        condition: r.condition || null,
        categoryId: null,
        categoryName: null,
        sellerFeedback: null,
        imageUrl: r.img || null,
        itemWebUrl: r.href || null,
      });
    }
    cache.set(key, { at: Date.now(), rows });
    return rows.slice(0, limit);
  } finally {
    await close();
  }
}
