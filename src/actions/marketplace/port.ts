// The marketplace, behind a port.
//
// A listing edit is a write to a system we do NOT own. That is the whole
// difficulty: our SQLite row and the marketplace's row can disagree, and the
// window in which they disagree is where a seller loses money. So the port is
// not `updateListing(id, price)` — it is a two-phase protocol with an explicit
// reservation, so a failure has a defined outcome instead of an unknown one.
//
//   reserve(intent)  -> takes an optimistic lock on (listingId, expectedVersion).
//                       Fails fast if the remote has moved under us.
//   apply(res)       -> performs the write. May fail. This is the only step that
//                       changes remote state.
//   confirm(res)     -> releases the reservation after we have durably recorded
//                       the result locally.
//   cancel(res)      -> releases a reservation we never applied.
//   compensate(res)  -> the inverse write, from the captured prior state. This is
//                       rollback, and it is a first-class operation, not a retry.
//
// `MockMarketplace` implements this with injectable latency, injectable apply
// failures and real optimistic-concurrency conflicts, because a rollback path
// that is never exercised is a rollback path that does not work.

import type { ActionKind } from "../../domain/types.js";

export interface ActionIntent {
  kind: ActionKind;
  listingId: string;
  /** The listing version this action was planned against. */
  expectedVersion: number;
  params: Record<string, unknown>;
  idempotencyKey: string;
}

export interface Reservation {
  token: string;
  listingId: string;
  expectedVersion: number;
  intent: ActionIntent;
}

export interface RemoteListing {
  id: string;
  priceCents: number;
  qty: number;
  state: "draft" | "queued" | "live" | "ended";
  pinned: boolean;
  version: number;
}

export class MarketplaceConflict extends Error {
  constructor(public listingId: string, public expected: number, public actual: number) {
    super(`listing ${listingId} changed remotely: expected version ${expected}, remote is ${actual}`);
    this.name = "MarketplaceConflict";
  }
}

export class MarketplaceApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceApplyError";
  }
}

export interface MarketplaceAdapter {
  readonly name: string;
  get(listingId: string): Promise<RemoteListing | null>;
  reserve(intent: ActionIntent): Promise<Reservation>;
  apply(res: Reservation): Promise<RemoteListing>;
  confirm(res: Reservation): Promise<void>;
  cancel(res: Reservation): Promise<void>;
  compensate(res: Reservation, before: Partial<RemoteListing>): Promise<RemoteListing>;
}
