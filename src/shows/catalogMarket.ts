// The catalog, with the market against it — fetched ahead of being asked for.
//
// Market data existed only inside the research card, which means it only ever
// existed for the one lot someone happened to ask about, one lot at a time, and
// vanished when the palette closed. A seller preparing for a show wants the
// opposite: the whole lineup, priced against what things are actually going
// for, before anyone asks anything.
//
// So this is a per-catalog index, warmed in the background and served from
// cache. The same discipline as the research path and for the same measured
// reason: a sandbox Browse call runs 0.7–4.6 seconds, and forty items would be
// minutes. Nothing here ever blocks a request on eBay.
//
// Sold prices are preferred and asking prices are the fallback, and the two are
// never averaged together — they answer different questions and a median across
// both describes neither.

import { ebay } from "../ingest/ebay/client.js";
import { EbayError } from "../ingest/ebay/client.js";
import type { CatalogItem } from "./catalogImport.js";

export interface MarketRow {
  sku: string;
  title: string;
  /** What the seller is asking, from their own catalog. */
  priceCents: number;
  qty: number;
  market: {
    basis: "sold" | "asking" | "none";
    medianCents: number;
    lowCents: number;
    highCents: number;
    /** How many comparables the median is over. One comp is not a market. */
    samples: number;
    /** The query that found them — a broad match is worth knowing about. */
    query: string;
    checkedAt: string;
  } | null;
  /** Null while a lookup for this item is in flight, so the UI can say so
   *  rather than rendering "no market" over a question still being asked. */
  checking: boolean;
  /** Where this lot sits against the market, as a percentage. Null without one. */
  deltaPct: number | null;
}

export interface CatalogMarket {
  catalogId: string;
  rows: MarketRow[];
  /** Items still being looked up. The page polls while this is above zero. */
  pending: number;
  /** Set when eBay refused in a way retrying will not fix. */
  error: string | null;
  /** A capability the index is working without; rows still match on asking. */
  note: string | null;
}

const TTL_MS = 30 * 60_000;

interface Entry {
  at: number;
  basis: "sold" | "asking" | "none";
  prices: number[];
  query: string;
}

export class MarketIndex {
  private cache = new Map<string, Entry>();
  private inFlight = new Map<string, Promise<void>>();
  private off: string | null = null;
  /** Sold comps are a capability, not the index. In production the keyset has
   *  no Marketplace Insights grant (limited release, on application), and the
   *  first 403 used to switch the WHOLE index off — twenty lots "queued"
   *  forever under a raw JSON error. Now it switches off sold lookups alone,
   *  says so in one sentence, and matches on asking prices. */
  private soldOff: string | null = null;

  /** Narrow to broad: a catalog title written for a human matches nothing. */
  private static queries(i: CatalogItem): string[] {
    const model = i.model || i.title;
    // A model often repeats the brand ("Topps" + "Topps Chrome"); a query that
    // says a word twice is a query written by a machine, and eBay ranks it
    // like one. Keep each word once, in first-seen order.
    const dedupe = (parts: (string | undefined | null)[]) => {
      const seen = new Set<string>();
      return parts
        .filter(Boolean)
        .join(" ")
        .split(/\s+/)
        .filter((w) => w && !seen.has(w.toLowerCase()) && (seen.add(w.toLowerCase()), true))
        .join(" ");
    };
    return [
      dedupe([i.brand, model, i.colorway]),
      dedupe([i.brand, model]),
      model.split(/\s+/).slice(0, 3).join(" ") || i.brand || i.title,
    ].filter((q, n, all) => Boolean(q) && all.indexOf(q) === n);
  }

  private fresh(sku: string): Entry | null {
    const e = this.cache.get(sku);
    return e && Date.now() - e.at < TTL_MS ? e : null;
  }

  private refresh(item: CatalogItem): Promise<void> {
    if (this.off || !ebay.configured || !item.sku) return Promise.resolve();
    const existing = this.inFlight.get(item.sku);
    if (existing) return existing;

    const queries = MarketIndex.queries(item);
    const run = (async () => {
      try {
        // Sold first. What a thing went for is the number to price against.
        if (!this.soldOff) {
          try {
            const sold = await ebay.soldWidening(queries, { limit: 12 });
            if (sold.rows.length) {
              this.cache.set(item.sku, {
                at: Date.now(),
                basis: "sold",
                prices: sold.rows.map((r) => r.priceCents),
                query: sold.query,
              });
              return;
            }
          } catch (e) {
            if (!(e instanceof EbayError && e.permanent)) throw e;
            this.soldOff =
              "Sold prices need eBay's Marketplace Insights grant for this app, which eBay gives on application " +
              "and production does not have yet — every lot is matched against active listings (asking prices) instead.";
          }
        }
        const active = await ebay.searchWidening(queries, { limit: 12 });
        this.cache.set(item.sku, {
          at: Date.now(),
          // An empty result is cached too: "eBay has nothing like this" is an
          // answer, and re-asking it every ten seconds is not.
          basis: active.rows.length ? "asking" : "none",
          prices: active.rows.map((r) => r.priceCents),
          query: active.query,
        });
      } catch (e) {
        if (e instanceof EbayError && e.permanent) this.off = e.message;
      } finally {
        this.inFlight.delete(item.sku);
      }
    })();

    this.inFlight.set(item.sku, run);
    return run;
  }

  /**
   * The catalog with whatever market data is already in hand.
   *
   * Misses start a background lookup and come back `checking: true`. The caller
   * polls; nothing waits.
   */
  read(catalogId: string, items: CatalogItem[]): CatalogMarket {
    const rows: MarketRow[] = items.map((i) => {
      const hit = this.fresh(i.sku);
      if (!hit) void this.refresh(i);

      const prices = hit ? [...hit.prices].sort((a, b) => a - b) : [];
      const median = prices.length
        ? prices.length % 2
          ? prices[(prices.length - 1) / 2]!
          : Math.round((prices[prices.length / 2 - 1]! + prices[prices.length / 2]!) / 2)
        : 0;

      return {
        sku: i.sku,
        title: i.title,
        priceCents: i.priceCents,
        qty: i.qty ?? 0,
        market:
          hit && median
            ? {
                basis: hit.basis,
                medianCents: median,
                lowCents: prices[0]!,
                highCents: prices[prices.length - 1]!,
                samples: prices.length,
                query: hit.query,
                checkedAt: new Date(hit.at).toISOString(),
              }
            : hit
              ? {
                  basis: "none" as const,
                  medianCents: 0, lowCents: 0, highCents: 0, samples: 0,
                  query: hit.query, checkedAt: new Date(hit.at).toISOString(),
                }
              : null,
        checking: this.inFlight.has(i.sku),
        deltaPct: hit && median ? Math.round(((i.priceCents - median) / median) * 100) : null,
      };
    });

    return {
      catalogId,
      rows,
      pending: rows.filter((r) => r.checking).length,
      error: this.off,
      note: this.soldOff,
    };
  }

  /** Fill the whole catalog, sequentially. Called on demand, not on a timer. */
  async warm(items: CatalogItem[]): Promise<void> {
    for (const i of items) {
      if (this.off) return;
      if (this.fresh(i.sku)) continue;
      await this.refresh(i);
    }
  }
}

/** One index per process: the cache is the point. */
export const marketIndex = new MarketIndex();
