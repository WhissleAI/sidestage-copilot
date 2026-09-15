// What eBay expects a listing in this category to carry, and what the catalog
// actually carries.
//
// This is the useful half of the Taxonomy API for a seller. eBay publishes, per
// leaf category, the aspects a listing should have and which of them are
// required — Brand, Color, Department and US Shoe Size for Athletic Shoes, say.
// Buyers filter on exactly those, so a missing one is not a cosmetic omission:
// it is the reason a lot does not appear in the search that would have sold it.
//
// It is also directly a COPILOT problem, which is why it lives beside readiness
// rather than in a listing tool. An aspect the catalog does not carry is an
// aspect no reply can cite. "What department is this, men's or women's?" is a
// question the copilot will abstain on all night, and the gap list in the
// post-session report will faithfully record that it kept being asked — without
// ever being able to say that eBay names the missing field and it takes one
// edit to close.
//
// Sampled, not exhaustive: one category resolved from the catalog's own items,
// checked against every item. Two network calls, not two per item. The check
// says what it sampled rather than implying it audited the whole inventory.

import { ebay } from "../ingest/ebay/client.js";
import type { CatalogItem } from "./catalogImport.js";

export interface AspectGap {
  /** The leaf category the sample resolved to, in eBay's words. */
  categoryId: string;
  categoryName: string;
  /** How the category was found, so nobody mistakes a guess for a lookup. */
  sampledFrom: string;
  required: string[];
  /** Required aspects no item in the catalog can supply a value for. */
  missing: string[];
  /** Items missing at least one required aspect, worst first. */
  worst: { sku: string; missing: string[] }[];
}

/**
 * Which catalog field answers an eBay aspect.
 *
 * Deliberately a short, explicit table rather than fuzzy matching: an aspect
 * wrongly reported as covered is worse than one reported as unknown, because it
 * is the one the seller will not go and fix.
 */
const SUPPLIED_BY: { match: RegExp; read: (i: CatalogItem) => string | undefined }[] = [
  { match: /^brand$/i, read: (i) => i.brand },
  { match: /^(colou?r|colorway)$/i, read: (i) => i.colorway },
  { match: /shoe size$|^size$/i, read: (i) => i.size },
  { match: /^(model|style|product line)$/i, read: (i) => i.model },
  { match: /^condition$/i, read: (i) => i.condition },
  // The title carries a lot in practice — a "Men's" in the title is a real
  // answer to Department — but only where the aspect's own values appear in it.
];

/** True when the catalog can answer this aspect for this item. */
function supplies(aspect: string, values: string[], item: CatalogItem): boolean {
  for (const rule of SUPPLIED_BY) {
    if (rule.match.test(aspect)) return Boolean(rule.read(item)?.trim());
  }
  // Fall back to the title, but only against eBay's own value list: finding
  // "Men" in a title is evidence; finding nothing is not evidence of absence,
  // so an aspect with no published values is reported as missing rather than
  // assumed present.
  const hay = `${item.title} ${item.description ?? ""}`.toLowerCase();
  return values.some((v) => v.length > 2 && hay.includes(v.toLowerCase()));
}

/**
 * Resolve a category from the catalog's own items and diff the required aspects.
 *
 * Returns null when eBay is unreachable or nothing resolves — the caller
 * reports that as "not checked", never as "nothing missing".
 */
export async function aspectGaps(items: CatalogItem[]): Promise<AspectGap | null> {
  if (!ebay.configured || items.length === 0) return null;

  // Search the way a buyer would, from the item most likely to have a market —
  // and widen, because a catalog title written for a human matches nothing.
  const sample = items.find((i) => i.brand && i.model) ?? items[0]!;
  const model = sample.model ?? sample.title;
  const { rows: hits, query } = await ebay
    .searchWidening(
      [
        [sample.brand, model].filter(Boolean).join(" "),
        model,
        model.split(/\s+/).slice(0, 3).join(" ") || (sample.brand ?? ""),
      ],
      { limit: 3 },
    )
    .catch(() => ({ rows: [], query: "" }));
  const withCategory = hits.find((h) => h.categoryId);
  if (!withCategory?.categoryId) return null;

  const aspects = await ebay
    .aspectsFor(withCategory.categoryId)
    .catch(() => [] as Awaited<ReturnType<typeof ebay.aspectsFor>>);
  const required = aspects.filter((a) => a.required);
  if (required.length === 0) return null;

  const perItem = items.map((i) => ({
    sku: i.sku,
    missing: required.filter((a) => !supplies(a.name, a.values, i)).map((a) => a.name),
  }));

  // An aspect is "missing" for the catalog when NO item can supply it — that is
  // a structural hole in the schema. Per-item gaps are listed separately, worst
  // first, because those are edits rather than a rethink.
  const missing = required
    .map((a) => a.name)
    .filter((name) => perItem.every((p) => p.missing.includes(name)));

  return {
    categoryId: withCategory.categoryId,
    categoryName: withCategory.categoryName ?? withCategory.categoryId,
    sampledFrom: `${sample.sku} via "${query}"`,
    required: required.map((a) => a.name),
    missing,
    worst: perItem
      .filter((p) => p.missing.length)
      .sort((a, b) => b.missing.length - a.missing.length)
      .slice(0, 8),
  };
}
