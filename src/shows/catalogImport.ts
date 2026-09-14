// Import a seller's product catalog into a watched show.
//
// This is the seam that makes monitoring a real stream useful, and it exists
// because of something the live adapter cannot do. eBay Live renders only the
// lot CURRENTLY on the block; the full lineup sits behind the Items panel, which
// requires sign-in. So watching someone's show from outside, the copilot learns
// the catalog one lot at a time as it passes — and until it does, the honest
// answer to "how much on the Griffey" is "the host will cover that shortly".
//
// The product answer is not to scrape harder. A seller running SideStage on
// their OWN show already has their catalog: it is their inventory. They import
// it (or connect it), and from then on the copilot can answer "do you have X"
// about the whole lineup while the live adapter keeps price and availability
// honest for the lot on screen.
//
// Two sources of truth, cleanly split:
//   imported catalog  -> what exists, what it is, what it costs at open
//   live stream       -> what is on screen right now, at what price, sold or not

import type { Repo } from "../domain/repo.js";
import type { Listing } from "../domain/types.js";

export interface CatalogItem {
  /** Seller's own id. Stable across imports, so a re-import updates in place. */
  sku: string;
  title: string;
  shortName?: string;
  brand?: string;
  model?: string;
  colorway?: string;
  size?: string;
  condition?: Listing["condition"];
  priceCents: number;
  floorPriceCents?: number;
  costCents?: number;
  qty?: number;
  state?: Listing["state"];
  shippingProfile?: string;
  authenticated?: boolean;
  certId?: string | null;
  description?: string;
  imageUrl?: string;
}

export interface ImportResult {
  created: number;
  updated: number;
  total: number;
  errors: string[];
}

/**
 * Upsert items by SKU. A re-import is an UPDATE, not a duplicate — and any price
 * or quantity change goes through `mutateListing`, so the version bumps and the
 * staleness guard treats an imported price change exactly like a live one.
 */
export async function importCatalog(repo: Repo, items: CatalogItem[]): Promise<ImportResult> {
  const result: ImportResult = { created: 0, updated: 0, total: 0, errors: [] };

  // One read for the whole import rather than one per item: a 200-item catalog
  // was doing 200 full-table reads to answer the same question.
  const bySku = new Map((await repo.listings()).map((l) => [l.sku, l]));

  for (const [i, raw] of items.entries()) {
    const item = normalize(raw);
    if (!item) {
      result.errors.push(`item ${i}: needs at least sku, title and a positive priceCents`);
      continue;
    }
    try {
      const existing = bySku.get(item.sku);
      if (existing) {
        if (existing.priceCents !== item.priceCents || existing.qty !== item.qty) {
          await repo.mutateListing(existing.id, { priceCents: item.priceCents, qty: item.qty });
        }
        result.updated++;
      } else {
        const created = await repo.insertListing(item);
        bySku.set(created.sku, created);
        result.created++;
      }
      result.total++;
    } catch (e) {
      result.errors.push(`item ${i} (${item.sku}): ${(e as Error).message}`);
    }
  }

  return result;
}

function normalize(r: CatalogItem): Required<Omit<CatalogItem, "certId">> & { certId: string | null } | null {
  const sku = String(r.sku || "").trim();
  const title = String(r.title || "").trim();
  const priceCents = Math.round(Number(r.priceCents));
  if (!sku || !title || !Number.isFinite(priceCents) || priceCents <= 0) return null;

  // A floor the seller did not set defaults to the asking price: the copilot may
  // not invent headroom to discount into.
  const floor = Math.round(Number(r.floorPriceCents ?? priceCents));

  return {
    sku,
    title,
    shortName: String(r.shortName || title).slice(0, 48),
    brand: String(r.brand || ""),
    model: String(r.model || ""),
    colorway: String(r.colorway || ""),
    size: String(r.size || ""),
    condition: r.condition || "USED",
    priceCents,
    floorPriceCents: Math.min(floor, priceCents),
    costCents: Math.round(Number(r.costCents ?? 0)),
    qty: Math.max(0, Math.round(Number(r.qty ?? 1))),
    state: r.state || "queued",
    shippingProfile: String(r.shippingProfile || "us-standard"),
    authenticated: Boolean(r.authenticated),
    certId: r.certId ?? null,
    description: String(r.description || ""),
    imageUrl: String(r.imageUrl || ""),
  };
}

/** Minimal CSV import: header row naming the CatalogItem fields. */
export function parseCatalogCsv(csv: string): CatalogItem[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCsvRow(lines[0]).map((h) => h.trim());
  const out: CatalogItem[] = [];

  for (const line of lines.slice(1)) {
    const cells = splitCsvRow(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));

    // Accept either cents or a dollar string, because a seller's export will
    // have dollars and nobody should have to pre-multiply their spreadsheet.
    const money = (v: string | undefined): number | undefined => {
      if (!v) return undefined;
      const n = Number(v.replace(/[$,]/g, ""));
      if (!Number.isFinite(n)) return undefined;
      return /[.]/.test(v) || n < 1000 ? Math.round(n * 100) : Math.round(n);
    };

    out.push({
      sku: row.sku || row.SKU || "",
      title: row.title || "",
      shortName: row.shortName || undefined,
      brand: row.brand || undefined,
      model: row.model || undefined,
      colorway: row.colorway || undefined,
      size: row.size || undefined,
      condition: (row.condition as Listing["condition"]) || undefined,
      priceCents: money(row.priceCents || row.price) ?? 0,
      floorPriceCents: money(row.floorPriceCents || row.floor),
      costCents: money(row.costCents || row.cost),
      qty: row.qty ? Number(row.qty) : undefined,
      state: (row.state as Listing["state"]) || undefined,
      authenticated: /^(1|true|yes)$/i.test(row.authenticated || ""),
      certId: row.certId || null,
      description: row.description || undefined,
    });
  }
  return out;
}

/** Split one CSV row, honouring double-quoted cells containing commas. */
function splitCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
