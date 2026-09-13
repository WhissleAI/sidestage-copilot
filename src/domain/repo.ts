// Repositories. The only place SQL touches the domain types.
//
// The single most important method here is `mutateListing`: every write to a
// listing goes through it, and it bumps `version` in the same statement. Nothing
// else may UPDATE listings. That is what lets a guardrail prove a reply was
// grounded on a stale read.

import type { DB } from "../db/index.js";
import type { Comp, Listing, PolicyClause, ShowState, AutonomyLevel } from "./types.js";
import { createHash } from "node:crypto";

interface ListingRow {
  id: string; sku: string; title: string; short_name: string; brand: string; model: string; colorway: string;
  size: string; condition: string; price_cents: number; floor_price_cents: number;
  cost_cents: number; qty: number; sold_this_show: number; views: number; state: string;
  pinned: number; version: number; image_url: string; shipping_profile: string;
  authenticated: number; cert_id: string | null; description: string; updated_at: string;
  external_ref: string | null; observed_at: string | null;
}

export interface ListingWithDescription extends Listing {
  description: string;
  shortName: string;
  /** Stable id of the lot on the source platform, when ingested from a live show. */
  externalRef: string | null;
}

function toListing(r: ListingRow): ListingWithDescription {
  return {
    id: r.id, sku: r.sku, title: r.title, shortName: r.short_name || r.title, brand: r.brand, model: r.model, colorway: r.colorway,
    size: r.size, condition: r.condition as Listing["condition"],
    priceCents: r.price_cents, floorPriceCents: r.floor_price_cents, costCents: r.cost_cents,
    qty: r.qty, soldThisShow: r.sold_this_show, views: r.views,
    state: r.state as Listing["state"], pinned: r.pinned === 1, version: r.version,
    imageUrl: r.image_url, shippingProfile: r.shipping_profile,
    authenticated: r.authenticated === 1, certId: r.cert_id, description: r.description,
    externalRef: r.external_ref, updatedAt: r.updated_at,
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

  /** Insert a catalog item the seller imported. Live-stream lots go through
   *  `upsertObservedLot` instead — different identity, different lifecycle. */
  insertListing(i: {
    sku: string; title: string; shortName: string; brand: string; model: string; colorway: string;
    size: string; condition: Listing["condition"]; priceCents: number; floorPriceCents: number;
    costCents: number; qty: number; state: Listing["state"]; shippingProfile: string;
    authenticated: boolean; certId: string | null; description: string; imageUrl: string;
  }): ListingWithDescription {
    const id = `lst_${createHash("sha1").update(i.sku).digest("hex").slice(0, 12)}`;
    this.d.prepare(`
      INSERT INTO listings (id, sku, title, short_name, brand, model, colorway, size, condition,
        price_cents, floor_price_cents, cost_cents, qty, sold_this_show, views, state, pinned,
        version, image_url, shipping_profile, authenticated, cert_id, description, updated_at)
      VALUES (@id, @sku, @title, @short, @brand, @model, @colorway, @size, @condition,
        @price, @floor, @cost, @qty, 0, 0, @state, 0,
        1, @image, @shipping, @auth, @cert, @desc, @now)
    `).run({
      id, sku: i.sku, title: i.title, short: i.shortName, brand: i.brand, model: i.model,
      colorway: i.colorway, size: i.size, condition: i.condition, price: i.priceCents,
      floor: i.floorPriceCents, cost: i.costCents, qty: i.qty, state: i.state,
      image: i.imageUrl, shipping: i.shippingProfile, auth: i.authenticated ? 1 : 0,
      cert: i.certId, desc: i.description, now: new Date().toISOString(),
    });
    return this.listing(id)!;
  }

  /**
   * Upsert a lot observed on a live stream.
   *
   * Identity is the lot's title hashed into a stable ref, because eBay Live does
   * not expose an item id in the player DOM. The important property is the same
   * one that governs every other write: if the price or availability MOVED, the
   * row goes through `mutateListing` and the version bumps. That is what makes a
   * reply grounded seconds ago provably stale — now against real auction
   * movement rather than a scripted demo.
   *
   * Returns the listing and whether this observation actually changed anything.
   */
  upsertObservedLot(lot: {
    title: string; priceCents: number; soldOut: boolean; highBidder?: string | null;
  }): { listing: ListingWithDescription; changed: boolean; created: boolean } {
    const ref = "ebaylive:" + createHash("sha1").update(lot.title).digest("hex").slice(0, 16);
    const now = new Date().toISOString();
    const existing = this.d.prepare("SELECT * FROM listings WHERE external_ref = ?").get(ref) as ListingRow | undefined;
    const qty = lot.soldOut ? 0 : 1;

    if (!existing) {
      const id = `lot_${ref.slice(-10)}`;
      this.d.prepare(`
        INSERT INTO listings (id, sku, title, short_name, brand, model, colorway, size, condition,
          price_cents, floor_price_cents, cost_cents, qty, sold_this_show, views, state, pinned,
          version, image_url, shipping_profile, authenticated, cert_id, description, updated_at,
          external_ref, observed_at)
        VALUES (@id, @sku, @title, @short, '', '', '', '', 'USED',
          @price, @price, 0, @qty, 0, 0, 'live', 1,
          1, '', 'us-standard', 0, NULL, @desc, @now, @ref, @now)
      `).run({
        id, sku: ref, title: lot.title, short: shortLotName(lot.title),
        price: lot.priceCents, qty, now, ref,
        desc: "Lot observed on the live stream. Condition and specifics are whatever the host states on air.",
      });
      // A newly observed lot becomes the one on screen.
      this.setPinned(id);
      return { listing: this.listing(id)!, changed: true, created: true };
    }

    const changed = existing.price_cents !== lot.priceCents || existing.qty !== qty || existing.pinned !== 1;
    if (!changed) {
      this.d.prepare("UPDATE listings SET observed_at = ? WHERE id = ?").run(now, existing.id);
      return { listing: this.listing(existing.id)!, changed: false, created: false };
    }

    // Floor tracks the live price on a stream we do not own: there is no seller
    // floor to read, and pretending one exists would let a markdown look legal.
    this.d.prepare("UPDATE listings SET floor_price_cents = ?, observed_at = ? WHERE id = ?")
      .run(lot.priceCents, now, existing.id);
    this.mutateListing(existing.id, { priceCents: lot.priceCents, qty });
    if (existing.pinned !== 1) this.setPinned(existing.id);
    return { listing: this.listing(existing.id)!, changed: true, created: false };
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
  /** Provision the single show row for a freshly created per-show database. */
  createShow(s: {
    id: string; title: string; sellerHandle: string; source: string;
    externalId?: string | null; readOnly?: boolean; autonomyLevel: AutonomyLevel; undoWindowS: number;
  }): ShowState {
    this.d.prepare(`
      INSERT OR REPLACE INTO show (id, title, seller_handle, started_at, viewers, pinned_listing_id,
        lot_queue, autonomy_level, undo_window_s, source, external_id, read_only, status)
      VALUES (?, ?, ?, ?, 0, NULL, '[]', ?, ?, ?, ?, ?, 'live')
    `).run(
      s.id, s.title, s.sellerHandle, new Date().toISOString(),
      s.autonomyLevel, s.undoWindowS, s.source, s.externalId ?? null, s.readOnly ? 1 : 0,
    );
    return this.show();
  }

  show(): ShowState {
    const r = this.d.prepare("SELECT * FROM show LIMIT 1").get() as {
      id: string; title: string; seller_handle: string; started_at: string; viewers: number;
      pinned_listing_id: string | null; lot_queue: string; autonomy_level: string; undo_window_s: number;
      source: string; external_id: string | null; read_only: number; status: string;
    } | undefined;
    if (!r) throw new Error("no show row — run `npm run seed` first");
    return {
      id: r.id, title: r.title, sellerHandle: r.seller_handle, startedAt: r.started_at,
      viewers: r.viewers, pinnedListingId: r.pinned_listing_id,
      lotQueue: JSON.parse(r.lot_queue) as string[],
      autonomyLevel: r.autonomy_level as AutonomyLevel, undoWindowS: r.undo_window_s,
      source: r.source as ShowState["source"], externalId: r.external_id,
      readOnly: r.read_only === 1, status: r.status as ShowState["status"],
    };
  }

  updateShow(patch: Partial<Pick<ShowState, "viewers" | "pinnedListingId" | "lotQueue" | "autonomyLevel" | "status">>): ShowState {
    const cur = this.show();
    const next = { ...cur, ...patch };
    this.d.prepare(
      "UPDATE show SET viewers = ?, pinned_listing_id = ?, lot_queue = ?, autonomy_level = ?, status = ? WHERE id = ?",
    ).run(next.viewers, next.pinnedListingId, JSON.stringify(next.lotQueue), next.autonomyLevel, next.status, cur.id);
    return next;
  }
}

/** A chip-sized name for an observed lot: strip the lot number and date prefix
 *  eBay sellers put in every title ("#372 - SUNDAY - 9/13/26- MLB $.99 Starts"). */
export function shortLotName(title: string): string {
  const lotNo = title.match(/#(\d+)/)?.[1];
  const tail = title
    .replace(/^#\d+\s*[-–]\s*/, "")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b\s*[-–]?\s*/, "")
    .replace(/\b(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)\b\s*[-–]?\s*/i, "")
    .replace(/\s*[-–]\s*/g, " ")
    .trim();
  return lotNo ? `Lot ${lotNo}${tail ? ` · ${tail.slice(0, 40)}` : ""}` : tail.slice(0, 48) || title.slice(0, 48);
}
