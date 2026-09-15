// The only place SQL touches the domain.
//
// Two invariants survive from the SQLite era and are the reason this file is a
// class rather than a bag of functions:
//
//   1. `mutateListing` is the ONLY write path for a listing, and it bumps
//      `version` in the same statement as the change. Retrieved evidence records
//      the version it was read at, so a reply grounded on a stale read is
//      DETECTABLE rather than merely unlikely.
//   2. Tenancy is structural. A show used to be its own database FILE, which
//      enforced isolation whether or not anyone remembered it. On Postgres the
//      boundary is a `show_id` column — so this class is CONSTRUCTED with a show
//      id and binds it into every statement. No call site is ever trusted to
//      write a WHERE clause correctly.
//
// Every method is async because the driver is. The hot path stays fast anyway:
// the retriever holds its index in memory and only rebuilds on a write, so a
// buyer question costs zero database round-trips until the guards re-read
// listing state — which is exactly the read that has to be fresh.

import type { Queryable } from "../db/pg.js";
import { tx, type Pool } from "../db/pg.js";
import type { Comp, Listing, PolicyClause, ShowState, AutonomyLevel } from "./types.js";
import { createHash } from "node:crypto";

interface ListingRow {
  id: string; sku: string; title: string; short_name: string; brand: string; model: string; colorway: string;
  size: string; condition: string; price_cents: number; floor_price_cents: number;
  cost_cents: number; qty: number; sold_this_show: number; views: number; state: string;
  pinned: boolean; version: number; image_url: string; url?: string | null; shipping_profile: string;
  authenticated: boolean; cert_id: string | null; description: string; updated_at: string;
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
    state: r.state as Listing["state"], pinned: r.pinned, version: r.version,
    imageUrl: r.image_url, url: r.url ?? null, shippingProfile: r.shipping_profile,
    authenticated: r.authenticated, certId: r.cert_id, description: r.description,
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
  constructor(private d: Queryable, readonly showId: string) {}

  /**
   * The same repo, bound to one transaction client.
   *
   * This is what keeps "mutate the listing" and "record the idempotency key" in
   * a single atomic unit — the property the two-phase commit rests on. Without
   * it the executor would have to hand-write SQL to stay in the transaction,
   * and the single-write-path invariant above would have an exception.
   */
  bind(c: Queryable): Repo {
    return new Repo(c, this.showId);
  }

  private q<T>(sql: string, args: unknown[] = []): Promise<{ rows: T[]; rowCount: number | null }> {
    return this.d.query(sql, args) as unknown as Promise<{ rows: T[]; rowCount: number | null }>;
  }

  // ── listings ──────────────────────────────────────────────────────────────
  async listings(): Promise<ListingWithDescription[]> {
    const r = await this.q<ListingRow>(
      "SELECT * FROM listings WHERE show_id = $1 ORDER BY pinned DESC, title", [this.showId],
    );
    return r.rows.map(toListing);
  }

  async listing(id: string): Promise<ListingWithDescription | null> {
    const r = await this.q<ListingRow>(
      "SELECT * FROM listings WHERE show_id = $1 AND id = $2", [this.showId, id],
    );
    return r.rows[0] ? toListing(r.rows[0]) : null;
  }

  async pinned(): Promise<ListingWithDescription | null> {
    const r = await this.q<ListingRow>(
      "SELECT * FROM listings WHERE show_id = $1 AND pinned LIMIT 1", [this.showId],
    );
    return r.rows[0] ? toListing(r.rows[0]) : null;
  }

  /**
   * The ONLY write path for a listing. Bumps `version` and `updated_at` atomically
   * with the change, so every mutation is observable as a version change.
   * Returns the listing as it is AFTER the write.
   */
  async mutateListing(id: string, patch: ListingPatch): Promise<ListingWithDescription> {
    const sets: string[] = [];
    const args: unknown[] = [];
    const put = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`); };

    if (patch.priceCents !== undefined) put("price_cents", patch.priceCents);
    if (patch.qty !== undefined) put("qty", patch.qty);
    if (patch.state !== undefined) put("state", patch.state);
    if (patch.pinned !== undefined) put("pinned", patch.pinned);
    if (patch.soldThisShow !== undefined) put("sold_this_show", patch.soldThisShow);
    if (patch.views !== undefined) put("views", patch.views);
    if (!sets.length) {
      const cur = await this.listing(id);
      if (!cur) throw new Error(`listing ${id} not found`);
      return cur;
    }

    put("updated_at", new Date().toISOString());
    sets.push("version = version + 1");
    args.push(this.showId, id);
    // RETURNING, so the post-write state comes back in the same round trip —
    // and, more importantly, is the state this exact statement produced rather
    // than whatever a second SELECT happens to see.
    const r = await this.q<ListingRow>(
      `UPDATE listings SET ${sets.join(", ")}
       WHERE show_id = $${args.length - 1} AND id = $${args.length} RETURNING *`,
      args,
    );
    if (!r.rows[0]) throw new Error(`listing ${id} not found`);
    return toListing(r.rows[0]);
  }

  /** Unpin everything, then pin one. Used by `swap_pinned`. Single statement, so
   *  there is no window in which the show has two pinned lots or none. */
  async setPinned(id: string): Promise<ListingWithDescription> {
    const now = new Date().toISOString();
    await this.q(
      `UPDATE listings SET pinned = (id = $3), version = version + 1, updated_at = $2
       WHERE show_id = $1 AND (pinned OR id = $3)`,
      [this.showId, now, id],
    );
    const l = await this.listing(id);
    if (!l) throw new Error(`listing ${id} not found`);
    return l;
  }

  /** Insert a catalog item the seller imported. Live-stream lots go through
   *  `upsertObservedLot` instead — different identity, different lifecycle. */
  async insertListing(i: {
    sku: string; title: string; shortName: string; brand: string; model: string; colorway: string;
    size: string; condition: Listing["condition"]; priceCents: number; floorPriceCents: number;
    costCents: number; qty: number; state: Listing["state"]; shippingProfile: string;
    authenticated: boolean; certId: string | null; description: string; imageUrl: string; url?: string | null;
  }): Promise<ListingWithDescription> {
    const id = `lst_${createHash("sha1").update(i.sku).digest("hex").slice(0, 12)}`;
    const r = await this.q<ListingRow>(`
      INSERT INTO listings (show_id, id, sku, title, short_name, brand, model, colorway, size, condition,
        price_cents, floor_price_cents, cost_cents, qty, sold_this_show, views, state, pinned,
        version, image_url, shipping_profile, authenticated, cert_id, description, updated_at, url)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, 0, 0, $15, FALSE,
        1, $16, $17, $18, $19, $20, $21, $22)
      ON CONFLICT (show_id, id) DO UPDATE SET
        title = EXCLUDED.title, price_cents = EXCLUDED.price_cents, qty = EXCLUDED.qty,
        url = COALESCE(EXCLUDED.url, listings.url),
        version = listings.version + 1, updated_at = EXCLUDED.updated_at
      RETURNING *`,
      [this.showId, id, i.sku, i.title, i.shortName, i.brand, i.model, i.colorway, i.size, i.condition,
       i.priceCents, i.floorPriceCents, i.costCents, i.qty, i.state,
       i.imageUrl, i.shippingProfile, i.authenticated, i.certId, i.description, new Date().toISOString(), i.url || null],
    );
    return toListing(r.rows[0]!);
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
   */
  async upsertObservedLot(lot: {
    title: string; priceCents: number; soldOut: boolean; highBidder?: string | null;
  }): Promise<{ listing: ListingWithDescription; changed: boolean; created: boolean }> {
    const ref = "ebaylive:" + createHash("sha1").update(lot.title).digest("hex").slice(0, 16);
    const now = new Date().toISOString();
    const qty = lot.soldOut ? 0 : 1;
    // A lot the host has closed is HISTORY, not inventory with zero stock.
    // Leaving it `live` meant every `state !== "ended"` filter in the system —
    // the lineup fact, the knowledge-base document, the hello payload — kept
    // carrying it, so a three-hour show accumulated hundreds of dead lots and
    // offered them to the model as things it could sell.
    const state: Listing["state"] = lot.soldOut ? "ended" : "live";

    const found = await this.q<ListingRow>(
      "SELECT * FROM listings WHERE show_id = $1 AND external_ref = $2", [this.showId, ref],
    );
    const existing = found.rows[0];

    if (!existing) {
      const id = `lot_${ref.slice(-10)}`;
      await this.q(`
        INSERT INTO listings (show_id, id, sku, title, short_name, brand, model, colorway, size, condition,
          price_cents, floor_price_cents, cost_cents, qty, sold_this_show, views, state, pinned,
          version, image_url, shipping_profile, authenticated, cert_id, description, updated_at,
          external_ref, observed_at)
        VALUES ($1, $2, $3, $4, $5, '', '', '', '', 'USED',
          $6, $6, 0, $7, 0, 0, $8, TRUE,
          1, '', 'us-standard', FALSE, NULL, $9, $10, $11, $10)`,
        [this.showId, id, ref, lot.title, shortLotName(lot.title), lot.priceCents, qty, state,
         "Lot observed on the live stream. Condition and specifics are whatever the host states on air.",
         now, ref],
      );
      // A newly observed lot becomes the one on screen.
      await this.setPinned(id);
      return { listing: (await this.listing(id))!, changed: true, created: true };
    }

    const changed =
      existing.price_cents !== lot.priceCents ||
      existing.qty !== qty ||
      existing.state !== state ||
      (state === "live" && !existing.pinned);
    if (!changed) {
      await this.q("UPDATE listings SET observed_at = $3 WHERE show_id = $1 AND id = $2",
        [this.showId, existing.id, now]);
      return { listing: (await this.listing(existing.id))!, changed: false, created: false };
    }

    // Floor tracks the live price on a stream we do not own: there is no seller
    // floor to read, and pretending one exists would let a markdown look legal.
    await this.q(
      "UPDATE listings SET floor_price_cents = $3, observed_at = $4 WHERE show_id = $1 AND id = $2",
      [this.showId, existing.id, lot.priceCents, now],
    );
    // A lot that just went from live to ended is a lot the host hammered, and
    // the price it carried at that moment is what it sold for. This is the only
    // moment that information exists — the row keeps moving afterwards.
    if (state === "ended" && existing.state !== "ended") {
      await this.recordSale({
        listingId: existing.id, title: lot.title, priceCents: lot.priceCents, source: "observed",
      });
    }
    await this.mutateListing(existing.id, { priceCents: lot.priceCents, qty, state });
    // Only a lot still being sold takes the pin. Pinning one that just ended
    // would leave the console showing a closed lot as the item on screen.
    if (state === "live" && !existing.pinned) await this.setPinned(existing.id);
    return { listing: (await this.listing(existing.id))!, changed: true, created: false };
  }

  /**
   * Book a sale.
   *
   * Idempotent on (show, listing, at): a watcher that re-observes an already
   * closed lot must not book it twice, and it re-observes constantly.
   */
  async recordSale(s: {
    listingId: string; title: string; priceCents: number; qty?: number; source: "observed" | "action";
  }): Promise<void> {
    await this.q(
      `INSERT INTO sales (show_id, listing_id, title, price_cents, qty, at, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (show_id, listing_id, at) DO NOTHING`,
      [this.showId, s.listingId, s.title, s.priceCents, s.qty ?? 1, new Date().toISOString(), s.source],
    );
  }

  /**
   * Give an observed lot a human name.
   *
   * Identity only — display name and description, the fields retrieval matches
   * on. Never price, quantity, condition or certificate: a guess about WHICH
   * item is recoverable, a guess about what it costs is not. Deliberately NOT
   * routed through `mutateListing`, because naming a lot is not a change to
   * what is being sold and should not bump the version the staleness guard
   * reads.
   */
  async nameObservedLot(id: string, name: string, basis: string): Promise<void> {
    await this.q(
      `UPDATE listings SET short_name = $3, description = $4
       WHERE show_id = $1 AND id = $2 AND external_ref IS NOT NULL`,
      [this.showId, id, name.slice(0, 80),
       `Identified from the show itself (${basis}) as: ${name}. ` +
       "Price, availability and condition come from what the stream reported, not from this name."],
    );
  }

  // ── policies / comps / qa ─────────────────────────────────────────────────
  async upsertPolicy(p: PolicyClause): Promise<void> {
    await this.q(
      `INSERT INTO policies (show_id, id, topic, title, body) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (show_id, id) DO UPDATE SET topic = EXCLUDED.topic, title = EXCLUDED.title, body = EXCLUDED.body`,
      [this.showId, p.id, p.topic, p.title, p.body],
    );
  }

  async policies(): Promise<PolicyClause[]> {
    const r = await this.q<PolicyClause>(
      "SELECT id, topic, title, body FROM policies WHERE show_id = $1", [this.showId],
    );
    return r.rows;
  }

  async policy(id: string): Promise<PolicyClause | null> {
    const r = await this.q<PolicyClause>(
      "SELECT id, topic, title, body FROM policies WHERE show_id = $1 AND id = $2", [this.showId, id],
    );
    return r.rows[0] ?? null;
  }

  async insertComp(c: Comp & { sku: string }): Promise<void> {
    await this.q(
      "INSERT INTO comps (show_id, sku, title, sold_price_cents, sold_at, condition, size) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [this.showId, c.sku, c.title, c.priceCents, c.soldAt, c.condition, c.size],
    );
  }

  async comps(sku: string): Promise<Comp[]> {
    const r = await this.q<{ title: string; sold_price_cents: number; sold_at: string; condition: string; size: string }>(
      "SELECT title, sold_price_cents, sold_at, condition, size FROM comps WHERE show_id = $1 AND sku = $2 ORDER BY sold_at DESC",
      [this.showId, sku],
    );
    return r.rows.map((x) => ({
      // Rows in this table are seeded SALES. Anything sourced live from eBay is
      // an asking price and never lands here.
      title: x.title, priceCents: x.sold_price_cents, soldAt: x.sold_at, basis: "sold" as const,
      condition: x.condition, size: x.size,
    }));
  }

  async insertQa(q: { id: string; question: string; answer: string; tags: string }): Promise<void> {
    await this.q(
      `INSERT INTO qa (show_id, id, question, answer, tags) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (show_id, id) DO UPDATE SET question = EXCLUDED.question, answer = EXCLUDED.answer, tags = EXCLUDED.tags`,
      [this.showId, q.id, q.question, q.answer, q.tags],
    );
  }

  async qa(): Promise<{ id: string; question: string; answer: string; tags: string }[]> {
    const r = await this.q<{ id: string; question: string; answer: string; tags: string }>(
      "SELECT id, question, answer, tags FROM qa WHERE show_id = $1", [this.showId],
    );
    return r.rows;
  }

  // ── show ──────────────────────────────────────────────────────────────────
  async createShow(s: {
    id: string; title: string; sellerHandle: string; source: string;
    externalId?: string | null; readOnly?: boolean; autonomyLevel: AutonomyLevel; undoWindowS: number;
    ownerAccountId?: string | null; catalogId?: string | null;
  }): Promise<ShowState> {
    await this.q(`
      INSERT INTO shows (id, owner_account_id, title, seller_handle, started_at, viewers, pinned_listing_id,
        lot_queue, autonomy_level, undo_window_s, source, external_id, read_only, status, catalog_id)
      VALUES ($1, $2, $3, $4, $5, 0, NULL, '[]'::jsonb, $6, $7, $8, $9, $10, 'live', $11)
      ON CONFLICT (id) DO UPDATE SET
        -- Re-attaching a show that ended is a new session on the same row:
        -- it goes back on air with a fresh clock. It used to keep 'ended', so
        -- the Shows list showed a watched show as finished and a restart never
        -- resumed it.
        status = 'live', started_at = EXCLUDED.started_at,
        -- Keep what the row already knows when the new attach knows less: a
        -- prepared title over the "eBay Live <id>" placeholder, and a catalog
        -- over the NULL an attach-by-link arrives with. Both used to be wiped.
        title = CASE WHEN EXCLUDED.title LIKE 'eBay Live %' THEN shows.title ELSE EXCLUDED.title END,
        catalog_id = COALESCE(EXCLUDED.catalog_id, shows.catalog_id),
        seller_handle = EXCLUDED.seller_handle,
        source = EXCLUDED.source, external_id = EXCLUDED.external_id,
        read_only = EXCLUDED.read_only`,
      [s.id, s.ownerAccountId ?? null, s.title, s.sellerHandle, new Date().toISOString(),
       s.autonomyLevel, s.undoWindowS, s.source, s.externalId ?? null, s.readOnly ?? false,
       s.catalogId ?? null],
    );
    return this.show();
  }

  async show(): Promise<ShowState> {
    const r = await this.q<{
      id: string; title: string; seller_handle: string; started_at: string; viewers: number;
      pinned_listing_id: string | null; lot_queue: string[]; autonomy_level: string; undo_window_s: number;
      source: string; external_id: string | null; read_only: boolean; status: string;
    }>("SELECT * FROM shows WHERE id = $1", [this.showId]);
    const row = r.rows[0];
    if (!row) throw new Error(`no show ${this.showId} — run \`npm run seed\` first`);
    return {
      id: row.id, title: row.title, sellerHandle: row.seller_handle, startedAt: row.started_at,
      viewers: row.viewers, pinnedListingId: row.pinned_listing_id,
      // jsonb comes back already parsed.
      lotQueue: (row.lot_queue ?? []) as string[],
      autonomyLevel: row.autonomy_level as AutonomyLevel, undoWindowS: row.undo_window_s,
      source: row.source as ShowState["source"], externalId: row.external_id,
      readOnly: row.read_only, status: row.status as ShowState["status"],
    };
  }

  async updateShow(
    patch: Partial<Pick<ShowState, "viewers" | "pinnedListingId" | "lotQueue" | "autonomyLevel" | "status" | "sellerHandle" | "title">>,
  ): Promise<ShowState> {
    const cur = await this.show();
    const next = { ...cur, ...patch };
    await this.q(
      `UPDATE shows SET viewers = $2, pinned_listing_id = $3, lot_queue = $4::jsonb,
         autonomy_level = $5, status = $6, seller_handle = $7, title = $8 WHERE id = $1`,
      [cur.id, next.viewers, next.pinnedListingId, JSON.stringify(next.lotQueue),
       next.autonomyLevel, next.status, next.sellerHandle, next.title],
    );
    return next;
  }
}

/** Run `fn` with a repo bound to one transaction. */
export function repoTx<T>(pool: Pool, showId: string, fn: (r: Repo) => Promise<T>): Promise<T> {
  return tx(pool, (c) => fn(new Repo(c, showId)));
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
