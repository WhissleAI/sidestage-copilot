// Seller catalogs.
//
// A catalog is the unit the operator picks when they start a session: *which of
// my inventories am I selling tonight?* It carries three things the copilot
// cannot get from a live stream:
//
//   items     the sellable inventory — eBay Live renders only the lot on the
//             block, so without this the copilot can only answer about one lot
//   seller    who is talking, and in what voice
//   policies  shipping, returns, authenticity, discount, tone, prohibited claims
//
// Shipped as JSON under fixtures/catalogs/. A production build would read these
// from the seller's account; the shape is the same either way.

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import type { Repo } from "../domain/repo.js";
import type { Comp, PolicyClause } from "../domain/types.js";
import { importCatalog, type CatalogItem, type ImportResult } from "./catalogImport.js";

export interface SellerProfile {
  handle: string;
  name: string;
  about: string;
  voice: string;
}

export interface Catalog {
  id: string;
  name: string;
  /** The Whissle agent that carries this seller's persona, guardrails and KB.
   *  Written by `npm run seed:agent`. */
  agentId?: string;
  seller: SellerProfile;
  policies: PolicyClause[];
  items: CatalogItem[];
  /**
   * Recent comparable sales, keyed by SKU — the grounding for product research.
   *
   * Without these `ResearchService` has nothing to retrieve, so "is that a good
   * price?" abstains on every real catalog and the comps evidence only ever
   * appeared on the seeded demo. A catalog that ships market data is what makes
   * the research path real rather than demonstrated.
   */
  comps?: (Comp & { sku: string })[];
}

export interface CatalogSummary {
  id: string;
  name: string;
  agentId: string | null;
  seller: SellerProfile;
  itemCount: number;
  policyCount: number;
  /** A few representative items, so the picker can show what this actually is. */
  sample: { title: string; priceCents: number }[];
}

let cache: Map<string, Catalog> | null = null;

function load(): Map<string, Catalog> {
  if (cache) return cache;
  cache = new Map();
  const dir = config.catalogsDir;
  if (!existsSync(dir)) return cache;

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const c = JSON.parse(readFileSync(join(dir, file), "utf8")) as Catalog;
      if (!c.id || !Array.isArray(c.items)) continue;
      cache.set(c.id, {
        ...c,
        policies: Array.isArray(c.policies) ? c.policies : [],
      });
    } catch (e) {
      console.warn(`[catalogs] skipped ${file}: ${(e as Error).message}`);
    }
  }
  return cache;
}

export function listCatalogs(): CatalogSummary[] {
  return [...load().values()].map((c) => ({
    id: c.id,
    name: c.name,
    agentId: c.agentId ?? null,
    seller: c.seller,
    itemCount: c.items.length,
    policyCount: c.policies.length,
    sample: c.items.slice(0, 4).map((i) => ({ title: i.title, priceCents: i.priceCents })),
  }));
}

export function getCatalog(id: string): Catalog | null {
  return load().get(id) ?? null;
}

/** Record the agent `seed:agent` provisioned for a catalog, back into its file. */
export function setCatalogAgent(catalogId: string, agentId: string): void {
  const path = join(config.catalogsDir, `${catalogId}.json`);
  if (!existsSync(path)) return;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Catalog;
  raw.agentId = agentId;
  writeFileSync(path, JSON.stringify(raw, null, 1) + "\n");
  const cached = load().get(catalogId);
  if (cached) cached.agentId = agentId;
}

/** Test/dev seam — pick up an edited catalog without a restart. */
export function reloadCatalogs(): void {
  cache = null;
}

export interface ApplyResult extends ImportResult {
  catalogId: string;
  catalogName: string;
  agentId: string | null;
  policies: number;
  seller: SellerProfile;
}

/**
 * Apply a catalog to a show: inventory, policies and seller identity together.
 *
 * Policies matter as much as items here. A freshly attached show has an empty
 * per-show database, so without them the policy guard has no clause to check a
 * shipping or returns claim against, and the copilot either abstains or leans on
 * whatever a listing happens to say.
 */
export async function applyCatalog(repo: Repo, catalog: Catalog): Promise<ApplyResult> {
  const imported = await importCatalog(repo, catalog.items);
  for (const p of catalog.policies) await repo.upsertPolicy(p);
  for (const c of catalog.comps ?? []) await repo.insertComp(c);

  await repo.updateShow({ sellerHandle: catalog.seller.handle });

  return {
    ...imported,
    catalogId: catalog.id,
    catalogName: catalog.name,
    agentId: catalog.agentId ?? null,
    policies: catalog.policies.length,
    seller: catalog.seller,
  };
}
