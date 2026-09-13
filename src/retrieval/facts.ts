// Fact extraction: turn the structured catalog + policy corpus into a set of
// small, individually addressable facts.
//
// This is the load-bearing idea of the whole grounding design. The copilot is
// never handed "the catalog" as prose — it is handed a numbered list of facts,
// each with a stable `factId`, and is required to cite one per claim. That makes
// three things possible downstream that free-text RAG cannot do:
//   • a guard can check a claim against the exact fact it cites,
//   • a listing fact carries the `version` it was read at, so a stale read is
//     provable rather than suspected,
//   • the operator UI can show provenance chips a human can actually verify.

import type { EvidenceSource } from "../domain/types.js";
import type { Repo, ListingWithDescription } from "../domain/repo.js";
import { formatMoney } from "../domain/money.js";
import { ngramVector, terms, type SparseVec } from "./text.js";

export type FactField =
  | "price" | "availability" | "condition" | "sizing" | "authenticity"
  | "shipping" | "returns" | "discount" | "description" | "identity" | "market" | "qa" | "tone" | "prohibited";

export interface Fact {
  factId: string;
  source: EvidenceSource;
  label: string;
  text: string;
  field: FactField;
  listingId?: string;
  listingVersion?: number;
  /** For price facts: the exact cents the text asserts. Guards compare against this. */
  numericCents?: number;
  /** For availability facts: the exact quantity the text asserts. */
  qty?: number;
  policyTopic?: string;
  /** Precomputed at index build. */
  tokens: string[];
  vector: SparseVec;
}

function mk(f: Omit<Fact, "tokens" | "vector">): Fact {
  const indexable = `${f.label} ${f.text}`;
  return { ...f, tokens: terms(indexable), vector: ngramVector(indexable) };
}

/**
 * A human description of an item, built from the fields that are actually
 * present and distinct.
 *
 * The first version assumed sneaker-shaped data — brand and model always
 * different, size always set — and produced this on a card catalog:
 *
 *   "Ivan Rodriguez 1992 Topps Gold #78 — Topps Topps Gold, colorway Ivan
 *    Rodriguez, size , condition USED."
 *
 * Duplicated brand into model, labelled a player as a colorway, and left a
 * dangling empty size. Three defects in one sentence the operator reads as
 * provenance, in a tooltip whose whole job is to be checkable.
 */
function describe(l: ListingWithDescription): string {
  const parts: string[] = [];
  const brandModel = [l.brand, l.model]
    .map((x) => (x || "").trim())
    .filter(Boolean)
    // "Topps" + "Topps Gold" is one thing said twice.
    .filter((x, idx, arr) => !arr.some((y, j) => j < idx && y.toLowerCase().includes(x.toLowerCase())));
  if (brandModel.length) parts.push(brandModel.join(" "));
  // `colorway` is the catalog's free-form variant field. It is a colourway for
  // sneakers and a player for cards, so name it neutrally.
  if (l.colorway?.trim()) parts.push(l.colorway.trim());
  if (l.size?.trim()) parts.push(`size ${l.size.trim()}`);
  parts.push(`condition ${l.condition}`);
  return parts.join(", ");
}

/** The item's name, with its size only when it has one. */
function itemName(l: ListingWithDescription): string {
  return l.size?.trim() ? `${l.title} size ${l.size.trim()}` : l.title;
}

export function listingFacts(l: ListingWithDescription): Fact[] {
  const name = itemName(l);
  // The chip label has to say WHICH listing, or a reply grounded across several
  // lots renders as five identical "Listing - shipping" chips and the operator
  // cannot verify any of them.
  const short = l.size?.trim() ? `${l.shortName} ${l.size.trim()}` : l.shortName;
  const out: Fact[] = [
    mk({
      factId: `listing:${l.id}#identity`, source: "listing", label: `${short} · item`,
      field: "identity", listingId: l.id, listingVersion: l.version,
      text: `${l.title} — ${describe(l)}.`,
    }),
    mk({
      factId: `listing:${l.id}#price`, source: "listing", label: `${short} · price`,
      field: "price", listingId: l.id, listingVersion: l.version, numericCents: l.priceCents,
      text: `${name} is listed at ${formatMoney(l.priceCents)}.`,
    }),
    mk({
      factId: `listing:${l.id}#availability`, source: "listing", label: `${short} · stock`,
      field: "availability", listingId: l.id, listingVersion: l.version, qty: l.qty,
      text: l.qty > 0
        ? `${name} has ${l.qty} available${l.qty === 1 ? " — it is the last one" : ""}.`
        : `${name} is sold out; there are 0 left.`,
    }),
    mk({
      factId: `listing:${l.id}#condition`, source: "listing", label: `${short} · condition`,
      field: "condition", listingId: l.id, listingVersion: l.version,
      text: `${name} is graded ${l.condition}. ${l.description}`,
    }),
    mk({
      factId: `listing:${l.id}#sizing`, source: "listing", label: `${short} · size`,
      field: "sizing", listingId: l.id, listingVersion: l.version,
      text: l.size?.trim()
        ? `This ${l.model || l.title} is a size ${l.size.trim()}. Only that size is available in this listing.`
        : `This ${l.model || l.title} has no size variant — it is a single item.`,
    }),
    mk({
      factId: `listing:${l.id}#authenticity`, source: "listing", label: `${short} · authentication`,
      field: "authenticity", listingId: l.id, listingVersion: l.version,
      text: l.authenticated && l.certId
        ? `${name} is authenticated by CheckCheck, certificate ${l.certId}, and ships with the certificate card.`
        : `${name} is a general-release pair and is NOT third-party authenticated. It carries the standard 30-day return.`,
    }),
    mk({
      factId: `listing:${l.id}#shipping`, source: "listing", label: `${short} · shipping`,
      field: "shipping", listingId: l.id, listingVersion: l.version,
      text: l.shippingProfile === "us-free-2day"
        ? `${name} ships free within the US on 2-day service.`
        : `${name} ships USPS Ground Advantage at a flat $9.95 within the US.`,
    }),
  ];
  return out;
}

export function buildFacts(repo: Repo): Fact[] {
  const facts: Fact[] = [];
  const listings = repo.listings();

  for (const l of listings) facts.push(...listingFacts(l));

  // One fact describing the whole lineup. This is what makes "do you have X?"
  // answerable and, more importantly, makes "no, not tonight" a GROUNDED answer
  // rather than an absence of one — the model can cite this instead of guessing.
  //
  // Lots OBSERVED on a live stream are excluded. They carry the seller's generic
  // on-air titles ("#414 - SUNDAY - 9/13/26- MLB $.99 Starts"), and once a few
  // dozen have scrolled past they drown the real catalog: a buyer asking "any
  // skenes left" got a confident answer about lot #414. The lineup is the
  // seller's INVENTORY; an observed lot is just what is on screen right now, and
  // it is already represented by the pinned-lot facts.
  const inventory = listings.filter((l) => !l.externalRef);
  const sellable = (inventory.length ? inventory : listings).filter((l) => l.state !== "ended" && l.qty > 0);
  facts.push(mk({
    factId: "catalog:lineup", source: "catalog", label: "Catalog · tonight's lineup",
    field: "identity",
    text: sellable.length
      ? `Tonight's lineup, and the ONLY items available: ${sellable
          .map((l) => `${l.title} (${l.size?.trim() ? `size ${l.size.trim()}, ` : ""}${formatMoney(l.priceCents)})`)
          .join("; ")}.` +
        " Anything not on this list is not in tonight's show."
      : "Nothing is currently available in tonight's lineup.",
  }));

  for (const p of repo.policies()) {
    facts.push(mk({
      factId: `policy:${p.id}`, source: "policy",
      label: `Policy · ${p.topic}`, field: p.topic as FactField, policyTopic: p.topic,
      text: `${p.title}: ${p.body}`,
    }));
  }

  for (const q of repo.qa()) {
    facts.push(mk({
      factId: `qa:${q.id}`, source: "qa", label: "Past answer", field: "qa",
      text: `${q.question}? ${q.answer}`,
    }));
  }

  // One market fact per SKU, carrying the 30-day median of comparable sales.
  const bySku = new Map<string, number[]>();
  for (const l of repo.listings()) {
    const prices = repo.comps(l.sku).map((c) => c.soldPriceCents);
    if (prices.length) bySku.set(l.sku, prices);
  }
  for (const [sku, prices] of bySku) {
    const med = median(prices);
    facts.push(mk({
      factId: `market:${sku}#median`, source: "market", label: "Market · comps",
      field: "market", numericCents: med,
      text: `Recent comparable sales for ${sku} median ${formatMoney(med)} across ${prices.length} sales.`,
    }));
  }

  return facts;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
