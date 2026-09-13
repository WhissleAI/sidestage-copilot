// On-demand product research, inside the same 2-second budget.
//
// "What is this actually going for?" is the question a live seller has to answer
// in the middle of a negotiation, and the answer has to be defensible: a median
// over recent comparable sales, the spread around it, and where this listing sits
// against it. That is a database query and some arithmetic, not a language-model
// question — so it runs entirely locally and returns in single-digit
// milliseconds, leaving the whole LLM budget for the reply that quotes it.
//
// The `Comp` rows are seeded market data (docs/TDD.md §7 covers what a live comps
// feed would replace them with). The important part is the SHAPE: research
// returns structured evidence with fact ids, so a reply that uses it is
// guard-checkable exactly like any other grounded claim.

import type { Evidence, ResearchCard } from "../domain/types.js";
import type { ListingWithDescription, Repo } from "../domain/repo.js";
import { formatMoney } from "../domain/money.js";
import { median } from "../retrieval/facts.js";
import { terms } from "../retrieval/text.js";

export class ResearchService {
  constructor(private repo: Repo) {}

  run(query: string, listingId?: string | null): ResearchCard {
    const t0 = performance.now();
    const listing = this.resolve(query, listingId ?? null);

    if (!listing) {
      return {
        query, listingId: null,
        headline: "No catalog item matched that query",
        comps: [], medianCents: 0,
        suggestion: "Name a lot from the show, or pin it first, and run this again.",
        latencyMs: Math.round(performance.now() - t0),
        evidence: [],
      };
    }

    const comps = this.repo.comps(listing.sku);
    const prices = comps.map((c) => c.soldPriceCents);
    const med = median(prices);

    const evidence: Evidence[] = [
      {
        factId: `listing:${listing.id}#price`, source: "listing", label: "Listing · price",
        text: `${listing.title} size ${listing.size} is listed at ${formatMoney(listing.priceCents)}.`,
        score: 1, listingVersion: listing.version,
      },
    ];
    if (med) {
      evidence.push({
        factId: `market:${listing.sku}#median`, source: "market", label: "Market · comps",
        text: `Median of ${comps.length} recent comparable sales for ${listing.sku} is ${formatMoney(med)}.`,
        score: 0.95,
      });
    }

    return {
      query,
      listingId: listing.id,
      headline: `${listing.title} — size ${listing.size}, ${listing.condition}`,
      comps: comps.slice(0, 8),
      medianCents: med,
      suggestion: this.suggest(listing, med, prices),
      specDiff: this.specDiff(listing),
      latencyMs: Math.round(performance.now() - t0),
      evidence,
    };
  }

  /** Where this listing sits against the market, and what room the floor leaves. */
  private suggest(l: ListingWithDescription, med: number, prices: number[]): string {
    if (!med) return `No comparable sales on file for ${l.sku}. Price on condition and demand in chat.`;

    const deltaPct = ((l.priceCents - med) / med) * 100;
    const spread = prices.length > 1
      ? ` Recent sales ran ${formatMoney(Math.min(...prices))} to ${formatMoney(Math.max(...prices))}.`
      : "";
    const room = l.priceCents > l.floorPriceCents
      ? ` You have ${formatMoney(l.priceCents - l.floorPriceCents)} of room above your floor.`
      : " You are already at your floor.";

    if (Math.abs(deltaPct) < 3) return `Listed within 3% of the ${formatMoney(med)} median — priced to market.${spread}${room}`;
    if (deltaPct > 0) return `Listed ${deltaPct.toFixed(0)}% above the ${formatMoney(med)} median.${spread}${room}`;
    return `Listed ${Math.abs(deltaPct).toFixed(0)}% below the ${formatMoney(med)} median — room to hold firm.${spread}`;
  }

  /** How this pair differs from the other sizes/conditions that recently sold. */
  private specDiff(l: ListingWithDescription): { attribute: string; ours: string; theirs: string }[] {
    const comps = this.repo.comps(l.sku);
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
  private resolve(query: string, listingId: string | null): ListingWithDescription | null {
    if (listingId) {
      const byId = this.repo.listing(listingId);
      if (byId) return byId;
    }
    const q = new Set(terms(query));
    if (!q.size) return this.repo.pinned();

    let best: { l: ListingWithDescription; score: number } | null = null;
    for (const l of this.repo.listings()) {
      const hay = new Set(terms(`${l.title} ${l.brand} ${l.model} ${l.colorway} ${l.sku}`));
      let score = 0;
      for (const t of q) if (hay.has(t)) score++;
      if (score && (!best || score > best.score)) best = { l, score };
    }
    return best?.l ?? this.repo.pinned();
  }
}
