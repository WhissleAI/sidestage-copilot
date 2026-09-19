// A seller's real inventory, as a catalog.
//
// A catalog has been a JSON file someone wrote by hand. That is right for a
// fixture and absurd for a person with four hundred listings — and it is the
// single largest piece of work between "I have an eBay store" and "the copilot
// can answer about my stock". Their inventory already exists. This reads it.
//
// What comes across, and why each field matters to the copilot:
//
//   sku, title            what the retriever indexes and what a reply cites.
//   price, quantity       what PriceGuard and AvailabilityGuard check against.
//   condition             the single most-asked attribute in live resale.
//   aspects               Brand, Colour, Size — eBay's own structured fields,
//                         which is exactly the data the hand-written catalogs
//                         had to invent a shape for.
//
// Written to the same `fixtures/catalogs/<id>.json` the rest of the product
// reads, so an imported catalog and a hand-written one are the same thing
// everywhere downstream. A production build would write to the seller's account
// instead and nothing else would change.

import { writeCatalogFile } from "../../shows/catalogs.js";
import { join } from "node:path";
import { config } from "../../config.js";
import type { Catalog } from "../../shows/catalogs.js";
import type { CatalogItem } from "../../shows/catalogImport.js";
import type { Listing } from "../../domain/types.js";

const HOST = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
} as const;

export interface ImportSummary {
  catalogId: string;
  items: number;
  /** Listings eBay returned that we could not use, with the reason. Reported
   *  rather than dropped: a seller whose catalog came back short deserves to
   *  know which listings did not make it and why. */
  skipped: { sku: string; why: string }[];
  path: string;
}

interface InventoryItem {
  sku?: string;
  product?: {
    title?: string;
    description?: string;
    aspects?: Record<string, string[]>;
    imageUrls?: string[];
  };
  condition?: string;
  availability?: { shipToLocationAvailability?: { quantity?: number } };
}

interface Offer {
  sku?: string;
  offerId?: string;
  status?: string;
  pricingSummary?: { price?: { value?: string } };
}

/** eBay's condition vocabulary is long; the product's is four values wide. */
function mapCondition(c: string | undefined): Listing["condition"] {
  switch ((c ?? "").toUpperCase()) {
    case "NEW":
    case "NEW_OTHER":
    case "NEW_WITH_DEFECTS":
      return "DS";
    case "LIKE_NEW":
    case "USED_EXCELLENT":
      return "VNDS";
    case "USED_VERY_GOOD":
    case "USED_GOOD":
    case "USED_ACCEPTABLE":
      return "USED";
    default:
      return "USED";
  }
}

/** First matching aspect, case-insensitively — eBay's names vary by category. */
function aspect(aspects: Record<string, string[]> | undefined, ...names: string[]): string | undefined {
  if (!aspects) return undefined;
  for (const want of names) {
    const key = Object.keys(aspects).find((k) => k.toLowerCase() === want.toLowerCase());
    if (key && aspects[key]?.[0]) return aspects[key][0];
  }
  return undefined;
}

export async function importSellerListings(opts: {
  token: string;
  env: "sandbox" | "production";
  catalogId: string;
  limit: number;
  fetcher?: typeof fetch;
}): Promise<ImportSummary> {
  const fetcher = opts.fetcher ?? fetch;
  const call = async <T>(path: string): Promise<T> => {
    const res = await fetcher(`${HOST[opts.env]}${path}`, {
      headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/json" },
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let said = text.slice(0, 300);
      try {
        const p = JSON.parse(text) as { errors?: { longMessage?: string; message?: string }[] };
        said = p.errors?.[0]?.longMessage || p.errors?.[0]?.message || said;
      } catch {
        /* not JSON */
      }
      throw new Error(`eBay ${path.split("?")[0]} ${res.status}: ${said}`);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  };

  // Inventory items and offers are separate collections keyed by the same SKU:
  // the item is what the thing IS, the offer is what it costs and whether it is
  // published. A catalog needs both, so both are paged and joined here.
  const items: InventoryItem[] = [];
  for (let offset = 0; items.length < opts.limit; offset += 100) {
    const page = await call<{ inventoryItems?: InventoryItem[]; total?: number }>(
      `/sell/inventory/v1/inventory_item?limit=100&offset=${offset}`,
    );
    const batch = page.inventoryItems ?? [];
    items.push(...batch);
    if (batch.length < 100) break;
  }

  const offers = new Map<string, Offer>();
  for (let offset = 0; ; offset += 100) {
    const page = await call<{ offers?: Offer[] }>(
      `/sell/inventory/v1/offer?limit=100&offset=${offset}`,
    ).catch(() => ({ offers: [] as Offer[] }));
    const batch = page.offers ?? [];
    for (const o of batch) if (o.sku) offers.set(o.sku, o);
    if (batch.length < 100) break;
  }

  const skipped: ImportSummary["skipped"] = [];
  const catalogItems: CatalogItem[] = [];

  for (const it of items.slice(0, opts.limit)) {
    const sku = it.sku;
    if (!sku) continue;
    const offer = offers.get(sku);
    const cents = Math.round(Number(offer?.pricingSummary?.price?.value ?? NaN) * 100);

    // A listing with no price cannot be answered about without inventing one,
    // and inventing a price is the single worst thing this product could do.
    if (!Number.isFinite(cents)) {
      skipped.push({ sku, why: offer ? "the offer carries no price" : "no offer — not listed" });
      continue;
    }
    const title = it.product?.title?.trim();
    if (!title) {
      skipped.push({ sku, why: "no title" });
      continue;
    }

    const qty = it.availability?.shipToLocationAvailability?.quantity ?? 0;
    catalogItems.push({
      sku,
      title,
      priceCents: cents,
      // The seller's floor is a decision only they can make. Defaulting it to
      // the list price means no markdown passes preflight until they set one —
      // which is the safe direction to be wrong in.
      floorPriceCents: cents,
      qty,
      state: offer?.status === "PUBLISHED" ? "live" : "queued",
      condition: mapCondition(it.condition),
      ...(aspect(it.product?.aspects, "Brand") ? { brand: aspect(it.product?.aspects, "Brand")! } : {}),
      ...(aspect(it.product?.aspects, "Model", "Style", "Product Line")
        ? { model: aspect(it.product?.aspects, "Model", "Style", "Product Line")! }
        : {}),
      ...(aspect(it.product?.aspects, "Colorway", "Color", "Colour")
        ? { colorway: aspect(it.product?.aspects, "Colorway", "Color", "Colour")! }
        : {}),
      ...(aspect(it.product?.aspects, "US Shoe Size", "Size", "Shoe Size")
        ? { size: aspect(it.product?.aspects, "US Shoe Size", "Size", "Shoe Size")! }
        : {}),
      ...(it.product?.description ? { description: it.product.description.slice(0, 2000) } : {}),
      ...(it.product?.imageUrls?.[0] ? { imageUrl: it.product.imageUrls[0] } : {}),
    });
  }

  const catalog: Catalog = {
    id: opts.catalogId,
    name: `Imported from eBay ${opts.env} — ${new Date().toLocaleDateString()}`,
    seller: {
      handle: opts.catalogId,
      name: opts.catalogId,
      about: "Imported from the seller's eBay inventory.",
      // Left deliberately plain. Voice is the seller's own decision and a
      // made-up one would go straight onto their agent and into public chat.
      voice: "Answer the actual question first, then at most one detail.",
    },
    // Policies do NOT come across: eBay's business policies are shipping and
    // return POLICIES on an account, not the clause text a reply can cite, and
    // grounding an answer in a policy we invented is the exact failure the
    // guardrails exist to prevent. Readiness reports the absence as a blocker.
    policies: [],
    items: catalogItems,
  };

  const path = join(config.catalogsDir, `${opts.catalogId}.json`);
  // The same atomic, directory-creating write every other catalog write uses:
  // an import that truncates a file a live show is reading is the same hazard
  // here as anywhere else, and CATALOGS_DIR may not exist yet.
  writeCatalogFile(path, JSON.stringify(catalog, null, 2) + "\n");

  return { catalogId: opts.catalogId, items: catalogItems.length, skipped, path };
}
