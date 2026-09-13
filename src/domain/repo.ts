// Repositories. The only place SQL touches the domain types.
//
// The single most important method here is `mutateListing`: every write to a
// listing goes through it, and it bumps `version` in the same statement. Nothing
// else may UPDATE listings. That is what lets a guardrail prove a reply was
// grounded on a stale read.

import type { DB } from "../db/index.js";
import type { Comp, Listing, PolicyClause, ShowState, AutonomyLevel } from "./types.js";

interface ListingRow {
  id: string; sku: string; title: string; short_name: string; brand: string; model: string; colorway: string;
  size: string; condition: string; price_cents: number; floor_price_cents: number;
  cost_cents: number; qty: number; sold_this_show: number; views: number; state: string;
  pinned: number; version: number; image_url: string; shipping_profile: string;
  authenticated: number; cert_id: string | null; description: string; updated_at: string;
}

export interface ListingWithDescription extends Listing { description: string; shortName: string }

function toListing(r: ListingRow): ListingWithDescription {
  return {
    id: r.id, sku: r.sku, title: r.title, shortName: r.short_name || r.title, brand: r.brand, model: r.model, colorway: r.colorway,
    size: r.size, condition: r.condition as Listing["condition"],
    priceCents: r.price_cents, floorPriceCents: r.floor_price_cents, costCents: r.cost_cents,
    qty: r.qty, soldThisShow: r.sold_this_show, views: r.views,
    state: r.state as Listing["state"], pinned: r.pinned === 1, version: r.version,
    imageUrl: r.image_url, shippingProfile: r.shipping_profile,
    authenticated: r.authenticated === 1, certId: r.cert_id, description: r.description,
    updatedAt: r.updated_at,
  };
}

/** Listing fields a caller may change. Everything else is immutable for a show. */
export interface ListingPatch {
  priceCents?: number;
  qty?: number;
  state?: Listing["state"];
  pinned?: boolean;
  soldThisShow?: number;
  views?: number;
}

export class Repo {
  constructor(private d: DB) {}

  // ── listings ──────────────────────────────────────────────────────────────
  listings(): ListingWithDescription[] {
    return (this.d.prepare("SELECT * FROM listings ORDER BY pinned DESC, title").all() as ListingRow[])
      .map(toListing);
  }

  listing(id: string): ListingWithDescription | null {
    const r = this.d.prepare("SELECT * FROM listings WHERE id = ?").get(id) as ListingRow | undefined;
    return r ? toListing(r) : null;
  }

  pinned(): ListingWithDescription | null {
    const r = this.d.prepare("SELECT * FROM listings WHERE pinned = 1 LIMIT 1").get() as ListingRow | undefined;
    return r ? toListing(r) : null;
  }

  /**
   * The ONLY write path for a listing. Bumps `version` and `updated_at` atomically
   * with the change, so every mutation is observable as a version change.
   * Returns the listing as it is AFTER the write.
   */
  mutateListing(id: string, patch: ListingPatch): ListingWithDescription {
    const sets: string[] = [];
    const args: unknown[] = [];
    const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); args.push(v); };

    if (patch.priceCents !== undefined) put("price_cents", patch.priceCents);
    if (patch.qty !== undefined) put("qty", patch.qty);
    if (patch.state !== undefined) put("state", patch.state);
    if (patch.pinned !== undefined) put("pinned", patch.pinned ? 1 : 0);
    if (patch.soldThisShow !== undefined) put("sold_this_show", patch.soldThisShow);
    if (patch.views !== undefined) put("views", patch.views);
    if (!sets.length) {
      const cur = this.listing(id);
      if (!cur) throw new Error(`listing ${id} not found`);
      return cur;
    }

    sets.push("version = version + 1", "updated_at = ?");
    args.push(new Date().toISOString(), id);
    const info = this.d.prepare(`UPDATE listings SET ${sets.join(", ")} WHERE id = ?`).run(...args as never[]);
    if (info.changes === 0) throw new Error(`listing ${id} not found`);
    return this.listing(id)!;
  }

  /** Unpin everything, then pin one. Used by `swap_pinned`. Single transaction. */
  setPinned(id: string): ListingWithDescription {
    const tx = this.d.transaction((target: string) => {
      const now = new Date().toISOString();
      this.d.prepare("UPDATE listings SET pinned = 0, version = version + 1, updated_at = ? WHERE pinned = 1 AND id != ?").run(now, target);
      this.d.prepare("UPDATE listings SET pinned = 1, version = version + 1, updated_at = ? WHERE id = ?").run(now, target);
    });
    tx(id);
    return this.listing(id)!;
  }

  // ── policies / comps / qa ─────────────────────────────────────────────────
  policies(): PolicyClause[] {
    return this.d.prepare("SELECT id, topic, title, body FROM policies").all() as PolicyClause[];
  }

  policy(id: string): PolicyClause | null {
    return (this.d.prepare("SELECT id, topic, title, body FROM policies WHERE id = ?").get(id) as PolicyClause) ?? null;
  }

  comps(sku: string): Comp[] {
    const rows = this.d
      .prepare("SELECT title, sold_price_cents, sold_at, condition, size FROM comps WHERE sku = ? ORDER BY sold_at DESC")
      .all(sku) as { title: string; sold_price_cents: number; sold_at: string; condition: string; size: string }[];
    return rows.map((r) => ({
      title: r.title, soldPriceCents: r.sold_price_cents, soldAt: r.sold_at,
      condition: r.condition, size: r.size,
    }));
  }

  qa(): { id: string; question: string; answer: string; tags: string }[] {
    return this.d.prepare("SELECT id, question, answer, tags FROM qa").all() as never;
  }

  // ── show ──────────────────────────────────────────────────────────────────
  show(): ShowState {
    const r = this.d.prepare("SELECT * FROM show LIMIT 1").get() as {
      id: string; title: string; seller_handle: string; started_at: string; viewers: number;
      pinned_listing_id: string | null; lot_queue: string; autonomy_level: string; undo_window_s: number;
    } | undefined;
    if (!r) throw new Error("no show row — run `npm run seed` first");
    return {
      id: r.id, title: r.title, sellerHandle: r.seller_handle, startedAt: r.started_at,
      viewers: r.viewers, pinnedListingId: r.pinned_listing_id,
      lotQueue: JSON.parse(r.lot_queue) as string[],
      autonomyLevel: r.autonomy_level as AutonomyLevel, undoWindowS: r.undo_window_s,
    };
  }

  updateShow(patch: Partial<Pick<ShowState, "viewers" | "pinnedListingId" | "lotQueue" | "autonomyLevel">>): ShowState {
    const cur = this.show();
    const next = { ...cur, ...patch };
    this.d.prepare(
      "UPDATE show SET viewers = ?, pinned_listing_id = ?, lot_queue = ?, autonomy_level = ? WHERE id = ?",
    ).run(next.viewers, next.pinnedListingId, JSON.stringify(next.lotQueue), next.autonomyLevel, cur.id);
    return next;
  }
}
