// A marketplace that behaves like a marketplace: it is slow, it occasionally
// fails mid-write, and it moves under you.
//
// This is not a stub that returns success. It holds its own authoritative copy of
// listing state, separate from our SQLite mirror, and:
//   • `reserve` rejects when the remote version has moved (optimistic concurrency),
//   • `apply` fails at the configured rate, AFTER having taken the reservation —
//     the genuinely awkward case, where we do not know whether the write landed,
//   • every call costs configurable latency, so the latency bench measures a
//     realistic commit rather than a function call.
//
// The failure injection is what makes the rollback tests meaningful. `npm test`
// runs them with MARKETPLACE_FAIL_RATE=1 to force the compensation path.

import { config } from "../../config.js";
import {
  MarketplaceApplyError, MarketplaceConflict,
  type ActionIntent, type MarketplaceAdapter, type RemoteListing, type Reservation,
} from "./port.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface MockOptions {
  failRate?: number;
  latencyMs?: number;
  /** Deterministic failure switch for tests, overriding failRate. */
  failNextApply?: boolean;
}

export class MockMarketplace implements MarketplaceAdapter {
  readonly name = "mock";
  private remote = new Map<string, RemoteListing>();
  private reservations = new Map<string, Reservation>();
  private opts: Required<Omit<MockOptions, "failNextApply">> & { failNextApply: boolean };

  /** Replace the mirrored remote state. Used once a show has loaded its
   *  catalog — the adapter is constructed before the listings are read. */
  reset(seed: RemoteListing[]): void {
    this.remote.clear();
    for (const l of seed) this.remote.set(l.id, { ...l });
  }

  constructor(seed: RemoteListing[], opts: MockOptions = {}) {
    for (const l of seed) this.remote.set(l.id, { ...l });
    this.opts = {
      failRate: opts.failRate ?? config.marketplaceFailRate,
      latencyMs: opts.latencyMs ?? config.marketplaceLatencyMs,
      failNextApply: opts.failNextApply ?? false,
    };
  }

  /** Test seam: force the next apply to fail, wherever it is called from. */
  failNext(on = true): void {
    this.opts.failNextApply = on;
  }

  /** Test seam: move the remote out from under a planned action, to provoke a
   *  reservation conflict the way a second device editing the listing would. */
  driftRemote(listingId: string, patch: Partial<RemoteListing>): void {
    const cur = this.remote.get(listingId);
    if (!cur) return;
    this.remote.set(listingId, { ...cur, ...patch, version: cur.version + 1 });
  }

  async get(listingId: string): Promise<RemoteListing | null> {
    await sleep(this.opts.latencyMs / 3);
    const l = this.remote.get(listingId);
    return l ? { ...l } : null;
  }

  async reserve(intent: ActionIntent): Promise<Reservation> {
    await sleep(this.opts.latencyMs / 2);
    const cur = this.remote.get(intent.listingId);
    if (!cur) throw new MarketplaceApplyError(`listing ${intent.listingId} does not exist remotely`);
    if (cur.version !== intent.expectedVersion) {
      throw new MarketplaceConflict(intent.listingId, intent.expectedVersion, cur.version);
    }
    const res: Reservation = {
      token: `res_${intent.idempotencyKey}`,
      listingId: intent.listingId,
      expectedVersion: intent.expectedVersion,
      intent,
    };
    this.reservations.set(res.token, res);
    return res;
  }

  async apply(res: Reservation): Promise<RemoteListing> {
    await sleep(this.opts.latencyMs);
    if (!this.reservations.has(res.token)) {
      throw new MarketplaceApplyError(`reservation ${res.token} is not held`);
    }
    if (this.opts.failNextApply || Math.random() < this.opts.failRate) {
      this.opts.failNextApply = false;
      throw new MarketplaceApplyError("marketplace rejected the write (simulated upstream 503)");
    }

    const cur = this.remote.get(res.listingId)!;
    const next = { ...cur, ...mutationFor(res.intent, cur), version: cur.version + 1 };
    this.remote.set(res.listingId, next);

    // `swap_pinned` is the one action that touches more than one listing: pinning
    // a lot must unpin whatever was pinned, remotely as well as locally.
    if (res.intent.kind === "swap_pinned") {
      for (const [id, l] of this.remote) {
        if (id !== res.listingId && l.pinned) this.remote.set(id, { ...l, pinned: false, version: l.version + 1 });
      }
    }
    return { ...next };
  }

  async confirm(res: Reservation): Promise<void> {
    this.reservations.delete(res.token);
  }

  async cancel(res: Reservation): Promise<void> {
    this.reservations.delete(res.token);
  }

  async compensate(res: Reservation, before: Partial<RemoteListing>): Promise<RemoteListing> {
    await sleep(this.opts.latencyMs);
    const cur = this.remote.get(res.listingId);
    if (!cur) throw new MarketplaceApplyError(`listing ${res.listingId} vanished before compensation`);
    // Restore the prior field values, but keep moving the version forward — a
    // rollback is a new event in the listing's history, not a rewind of it.
    const next: RemoteListing = { ...cur, ...before, id: cur.id, version: cur.version + 1 };
    this.remote.set(res.listingId, next);
    this.reservations.delete(res.token);
    return { ...next };
  }

  /** Inspect remote truth. Tests assert against this to prove the two sides agree. */
  snapshot(listingId: string): RemoteListing | null {
    const l = this.remote.get(listingId);
    return l ? { ...l } : null;
  }
}

/** The field change each action kind represents. */
export function mutationFor(intent: ActionIntent, cur: RemoteListing): Partial<RemoteListing> {
  const p = intent.params;
  switch (intent.kind) {
    case "markdown_price":
      return { priceCents: Number(p.newPriceCents) };
    case "adjust_stock":
      return { qty: Number(p.newQty) };
    case "swap_pinned":
      return { pinned: true, state: "live" };
    case "push_listing":
      return { state: "live" };
    case "end_listing":
      return { state: "ended", pinned: false };
    default:
      return {};
  }
}
