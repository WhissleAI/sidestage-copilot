// On-demand product research, inside the same 2-second budget.
//
// "What is this actually going for?" is the question a live seller has to answer
// in the middle of a negotiation, and the answer has to be defensible: a median
// over recent comparable sales, the spread around it, and where this listing sits
// against it. That is a database query and some arithmetic, not a language-model
// question — so it runs entirely locally and returns in single-digit
// milliseconds, leaving the whole LLM budget for the reply that quotes it.
//
// Two sources of market data, and the card always says which one it is on:
//
//   eBay Browse   real ACTIVE listings. What people are asking today. Bounded
//                 by a hard timeout, because a live seller waiting mid-sentence
//                 is the whole constraint this file exists under.
//   seeded        the fixture sales in `comps`. Real SOLD prices in shape, made
//                 up in content. Used when eBay has nothing or is not
//                 configured, and never silently blended with the first.
//
// Sold prices from eBay would be better than either and are not available:
// Marketplace Insights is a limited-release API this application is not
// approved for. So an asking-price median is called an asking-price median
// everywhere it appears. That distinction is load-bearing — asking prices skew
// high, because the optimistic listings are the ones still sitting there, and a
// seller who holds firm against a number they believe is a sale price is being
// misled by their own copilot.
//
// The important part is unchanged: research returns structured evidence with
// fact ids, so a reply that quotes it is guard-checkable like any other claim.

import type { Comp, CompBasis, Evidence, ResearchCard } from "../domain/types.js";
import { ebay, EbayError } from "../ingest/ebay/client.js";
import type { ListingWithDescription, Repo } from "../domain/repo.js";
import { formatMoney } from "../domain/money.js";
import { median } from "../retrieval/facts.js";
import { terms } from "../retrieval/text.js";

/** A live show asks the same question repeatedly; eBay should hear it once. */
const MARKET_TTL_MS = 10 * 60_000;

export class ResearchService {
  private market = new Map<string, { at: number; comps: Comp[] }>();
  /** Refreshes in flight, by sku. A pinned lot asked about three times in one
   *  second must not open three ladders. */
  private refreshing = new Map<string, Promise<void>>();
  /** Set when eBay refuses for a reason retrying cannot fix (no approval, no
   *  application configured). Stops a show spending its budget re-asking. */
  private marketOff: string | null = null;

  constructor(private repo: Repo) {}

  async run(
    query: string,
    listingId?: string | null,
    /** `reply` is the hot path behind a buyer's question. Defaults to the
     *  operator's budget, since that is the explicit, patient caller. */
    opts: { caller?: "reply" | "operator" } = {},
  ): Promise<ResearchCard> {
    const t0 = performance.now();
    // Kept in the signature: the caller distinction is real, and the next thing
    // that differs by it (how hard to widen) belongs here.
    void opts;
    const listing = await this.resolve(query, listingId ?? null);

    if (!listing) {
      return {
        query, listingId: null,
        headline: "No catalog item matched that query",
        comps: [], medianCents: 0, marketBasis: "none", marketSource: "none",
        suggestion: "Name a lot from the show, or pin it first, and run this again.",
        latencyMs: Math.round(performance.now() - t0),
        evidence: [],
      };
    }

    // Real listings first; the fixture sales are the fallback, not a blend. A
    // median over two different bases is a number that means nothing.
    const live = this.liveComps(listing);
    const seeded = live.length ? [] : await this.repo.comps(listing.sku);
    const comps = live.length ? live : seeded;
    const source: ResearchCard["marketSource"] = live.length
      ? live[0]!.basis === "sold"
        ? "ebay-sold"
        : "ebay-active"
      : seeded.length
        ? "seeded"
        : this.pending(listing)
          ? "checking"
          : "none";
    const basis: ResearchCard["marketBasis"] = comps.length ? comps[0]!.basis : "none";

    const prices = comps.map((c) => c.priceCents);
    const med = median(prices);

    const evidence: Evidence[] = [
      {
        factId: `listing:${listing.id}#price`, source: "listing", label: "Listing · price",
        text: `${listing.title} size ${listing.size} is listed at ${formatMoney(listing.priceCents)}.`,
        score: 1, listingVersion: listing.version,
      },
    ];
    if (med) {
      // The fact TEXT is what a reply quotes and what the grounding guard checks
      // it against, so the basis has to be in the sentence itself — not only in
      // a field beside it that the composer never sees.
      evidence.push({
        factId: `market:${listing.sku}#median`,
        source: "market",
        label: basis === "asking" ? "Market · asking now" : "Market · comps",
        text:
          basis === "asking"
            ? `Median ASKING price across ${comps.length} active eBay listings matching ${listing.sku} is ${formatMoney(med)}. These are current asking prices, not sold prices.`
            : `Median of ${comps.length} recent comparable sales for ${listing.sku} is ${formatMoney(med)}.`,
        score: basis === "asking" ? 0.8 : 0.95,
      });
    }

    return {
      query,
      listingId: listing.id,
      headline: `${listing.title} — size ${listing.size}, ${listing.condition}`,
      comps: comps.slice(0, 8),
      medianCents: med,
      marketBasis: basis,
      marketSource: source,
      suggestion: this.suggest(listing, med, prices, basis),
      specDiff: await this.specDiff(listing),
      latencyMs: Math.round(performance.now() - t0),
      evidence,
    };
  }

  /**
   * What this lot is going for on eBay, from cache — never from the network.
   *
   * The first design put the eBay call on the request path behind a timeout.
   * Measured against the real sandbox, one Browse call takes 0.7–4.6 seconds
   * and the widening ladder took seven — against a two-second end-to-end budget
   * for the whole reply. No timeout makes that work; it only decides how often
   * the feature silently does nothing.
   *
   * So nothing here waits on eBay. A miss starts a refresh and returns nothing,
   * so the card answers now on the other source and answers better next time.
   */
  private liveComps(l: ListingWithDescription): Comp[] {
    const hit = this.market.get(l.sku);
    if (hit && Date.now() - hit.at < MARKET_TTL_MS) return hit.comps;
    void this.refresh(l);
    return [];
  }

  /** Is a lookup for this lot in flight? The card says "checking eBay" rather
   *  than implying the market has nothing in it. */
  private pending(l: ListingWithDescription): boolean {
    return this.refreshing.has(l.sku);
  }

  /**
   * Fill the cache for the lots that are about to matter.
   *
   * Called when a catalog lands and when the pinned lot changes, which is why a
   * miss is rare by the time a buyer actually asks. Sequential and unhurried:
   * this is background work, and hammering eBay with a burst is how an
   * application earns a rate limit.
   */
  async warm(listings: ListingWithDescription[]): Promise<void> {
    for (const l of listings.slice(0, 6)) {
      if (this.marketOff) return;
      const hit = this.market.get(l.sku);
      if (hit && Date.now() - hit.at < MARKET_TTL_MS) continue;
      await this.refresh(l);
    }
  }

  private refresh(l: ListingWithDescription): Promise<void> {
    if (this.marketOff || !ebay.configured) return Promise.resolve();
    const existing = this.refreshing.get(l.sku);
    if (existing) return existing;

    // The SKU is ours, not eBay's. Search the way a buyer would — and widen
    // when the precise query finds nothing, because "Jordan Air Jordan 1 Retro
    // High OG Chicago Reimagined" matches zero listings while "Air Jordan 1"
    // matches the market this lot actually lives in.
    const model = l.model || l.title;
    const queries = [
      [l.brand, model, l.colorway].filter(Boolean).join(" "),
      [l.brand, model].filter(Boolean).join(" "),
      model.split(/\s+/).slice(0, 3).join(" ") || l.brand,
    ].filter((q, i, all) => Boolean(q) && all.indexOf(q) === i);

    const run = (async () => {
      try {
        // SOLD first. What a thing went for is the number to price against;
        // what someone is asking is a weaker proxy, and mixing the two into one
        // median produces a figure that describes neither. Sandbox carries no
        // sales history, so in practice this falls through there — which is why
        // the asking path is not a fallback to be embarrassed about.
        const sold = await ebay.soldWidening(queries, { limit: 12 });
        const comps: Comp[] = sold.rows.length
          ? sold.rows.map((r) => ({
              title: r.title,
              priceCents: r.priceCents,
              soldAt: r.soldAt,
              condition: r.condition ?? "unstated",
              size: "unstated",
              basis: "sold" as CompBasis,
              ...(r.itemWebUrl ? { url: r.itemWebUrl } : {}),
            }))
          : (await ebay.searchWidening(queries, { limit: 12 })).rows.map((r) => ({
              title: r.title,
              priceCents: r.priceCents,
              soldAt: null,
              condition: r.condition ?? "unstated",
              // eBay does not break size out of a summary, and claiming this
              // comp is the same size as the lot would be inventing the one
              // attribute that moves a sneaker price most.
              size: "unstated",
              basis: "asking" as CompBasis,
              ...(r.itemWebUrl ? { url: r.itemWebUrl } : {}),
            }));
        // Cached even when empty: "eBay has nothing like this" is an answer,
        // and re-asking it every ten seconds is not.
        this.market.set(l.sku, { at: Date.now(), comps });
      } catch (e) {
        if (e instanceof EbayError && e.permanent) {
          this.marketOff = e.message;
          console.warn(`[research] live comps off for this process: ${e.message}`);
        }
      } finally {
        this.refreshing.delete(l.sku);
      }
    })();

    this.refreshing.set(l.sku, run);
    return run;
  }

  /** Where this listing sits against the market, and what room the floor leaves. */
  private suggest(
    l: ListingWithDescription,
    med: number,
    prices: number[],
    basis: ResearchCard["marketBasis"],
  ): string {
    if (!med) return `No comparable prices on file for ${l.sku}. Price on condition and demand in chat.`;

    const asking = basis === "asking";
    const deltaPct = ((l.priceCents - med) / med) * 100;
    const spread = prices.length > 1
      ? asking
        ? ` Active listings run ${formatMoney(Math.min(...prices))} to ${formatMoney(Math.max(...prices))}.`
        : ` Recent sales ran ${formatMoney(Math.min(...prices))} to ${formatMoney(Math.max(...prices))}.`
      : "";
    const room = l.priceCents > l.floorPriceCents
      ? ` You have ${formatMoney(l.priceCents - l.floorPriceCents)} of room above your floor.`
      : " You are already at your floor.";

    // Never "priced to market" against asking prices: matching what other
    // sellers HOPE for is not evidence that anything sells there.
    const of = asking ? `${formatMoney(med)} median asking price` : `${formatMoney(med)} median`;
    if (Math.abs(deltaPct) < 3) {
      return asking
        ? `Listed within 3% of the ${of} — in line with what others are asking, which is not the same as what sells.${spread}${room}`
        : `Listed within 3% of the ${of} — priced to market.${spread}${room}`;
    }
    if (deltaPct > 0) return `Listed ${deltaPct.toFixed(0)}% above the ${of}.${spread}${room}`;
    return `Listed ${Math.abs(deltaPct).toFixed(0)}% below the ${of} — room to hold firm.${spread}`;
  }

  /** How this pair differs from the other sizes/conditions that recently sold. */
  private async specDiff(l: ListingWithDescription): Promise<{ attribute: string; ours: string; theirs: string }[]> {
    const comps = await this.repo.comps(l.sku);
    if (!comps.length) return [];
    const sizes = [...new Set(comps.map((c) => c.size))].filter((s) => s !== l.size);
    const conds = [...new Set(comps.map((c) => c.condition))].filter((c) => c !== l.condition);
    const out: { attribute: string; ours: string; theirs: string }[] = [
      { attribute: "Size", ours: l.size, theirs: sizes.length ? sizes.join(", ") : l.size },
      { attribute: "Condition", ours: l.condition, theirs: conds.length ? conds.join(", ") : l.condition },
      { attribute: "Authentication", ours: l.authenticated ? `cert ${l.certId}` : "none", theirs: "not reported in comps" },
    ];
    return out;
  }

  /** Resolve the query to a lot: explicit id wins, then title/brand token overlap. */
  private async resolve(query: string, listingId: string | null): Promise<ListingWithDescription | null> {
    if (listingId) {
      const byId = await this.repo.listing(listingId);
      if (byId) return byId;
    }
    const q = new Set(terms(query));
    if (!q.size) return this.repo.pinned();

    let best: { l: ListingWithDescription; score: number } | null = null;
    for (const l of await this.repo.listings()) {
      const hay = new Set(terms(`${l.title} ${l.brand} ${l.model} ${l.colorway} ${l.sku}`));
      let score = 0;
      for (const t of q) if (hay.has(t)) score++;
      if (score && (!best || score > best.score)) best = { l, score };
    }
    return best?.l ?? this.repo.pinned();
  }
}

