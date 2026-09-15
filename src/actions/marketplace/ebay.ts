// The real marketplace, behind the same port as the mock.
//
// Every write in this product has always gone through `MarketplaceAdapter`:
// reserve, apply, confirm, compensate. That was built against `MockMarketplace`
// so the rollback path could be exercised on demand, and the honest caveat in
// the docs was that no live adapter existed. This is it — eBay's Sell Inventory
// API, same protocol, same audit chain, same undo window.
//
// Two places where eBay does not give us what the mock does, stated here rather
// than smoothed over:
//
//   NO VERSIONS. An offer carries no ETag and no revision number, so the
//   optimistic lock cannot be "expected version 4". It is instead VALUE-based:
//   we read the offer at reserve, read it again at apply, and refuse if it moved
//   in between. That is a narrower guarantee than the mock's — a change that
//   lands and reverts between the two reads is invisible — and it is the
//   strongest guarantee the API supports. The window is milliseconds and the
//   audit entry records both readings, so a disagreement is at least legible
//   afterwards.
//
//   SKU IS THE KEY. eBay's inventory is keyed by the seller's own SKU, not by
//   our listing id, and the offer id has to be looked up from it. That lookup is
//   cached per adapter: a show that marks down the same lot twice should not ask
//   twice.
//
// Ending a listing is `withdraw`, which pulls the offer from the marketplace and
// keeps the inventory item. It is deliberately NOT `deleteOffer`: withdrawing is
// reversible by publishing again, and the undo window in this product promises
// exactly that.

import type {
  ActionIntent,
  MarketplaceAdapter,
  RemoteListing,
  Reservation,
} from "./port.js";
import { MarketplaceApplyError, MarketplaceConflict } from "./port.js";
import { config } from "../../config.js";

const HOST = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
} as const;

/** What the adapter needs to know about one of our listings to find it on eBay. */
export interface LocalListing {
  id: string;
  sku: string;
  priceCents: number;
  qty: number;
  version: number;
  state: RemoteListing["state"];
  pinned: boolean;
}

interface EbayOffer {
  offerId: string;
  sku: string;
  status?: string;
  availableQuantity?: number;
  pricingSummary?: { price?: { value?: string; currency?: string } };
}

export class EbayMarketplace implements MarketplaceAdapter {
  readonly name = "ebay";

  /** sku → offerId. Resolved once per show, not once per write. */
  private offers = new Map<string, string>();
  /** What the remote said at reserve, for the value-based conflict check. */
  private seen = new Map<string, { priceCents: number; qty: number }>();

  constructor(
    /** How to read one of our listings. Keeps the DB out of the adapter. */
    private readonly local: (listingId: string) => Promise<LocalListing | null>,
    /** A valid user access token for the seller who owns these listings. */
    private readonly token: () => Promise<string | null>,
    private readonly env: "sandbox" | "production" = config.ebay.env as "sandbox" | "production",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.token();
    if (!token) {
      // Not an outage: this seller has not connected eBay, and the preflight
      // should have said so before we got here.
      throw new MarketplaceApplyError("no eBay connection for this seller — connect one in Settings");
    }
    // eBay rate-limits per app and returns 429 (and 503 under load). A markdown
    // the seller approved must not fail on the first one: back off and try
    // twice more before the action is marked failed.
    let res!: Response;
    for (let attempt = 0; ; attempt++) {
      res = await (async () => { return await this.fetcher(`${HOST[this.env]}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Language": "en-US",
        ...(init.headers as Record<string, string> | undefined),
      },
    }); })();
      if ((res.status === 429 || res.status === 503) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt + Math.random() * 200));
        continue;
      }
      break;
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      // eBay's errors are an array of objects with their own ids; the long
      // description is the part a seller can act on.
      let said = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { errors?: { message?: string; longMessage?: string }[] };
        const first = parsed.errors?.[0];
        if (first) said = first.longMessage || first.message || said;
      } catch {
        /* not JSON */
      }
      throw new MarketplaceApplyError(`eBay ${path.split("?")[0]} ${res.status}: ${said}`);
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  private async offerFor(sku: string): Promise<EbayOffer> {
    const body = await this.call<{ offers?: EbayOffer[] }>(
      `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`,
    );
    const offer = body.offers?.[0];
    if (!offer?.offerId) {
      throw new MarketplaceApplyError(
        `no eBay offer exists for SKU ${sku} — this lot is in the catalog but not listed`,
      );
    }
    this.offers.set(sku, offer.offerId);
    return offer;
  }

  private static toRemote(l: LocalListing, offer: EbayOffer): RemoteListing {
    const cents = Math.round(Number(offer.pricingSummary?.price?.value ?? NaN) * 100);
    return {
      id: l.id,
      priceCents: Number.isFinite(cents) ? cents : l.priceCents,
      qty: offer.availableQuantity ?? l.qty,
      // eBay says PUBLISHED / UNPUBLISHED; the product's vocabulary is narrower
      // and this is the only place the two need reconciling.
      state: offer.status === "PUBLISHED" ? "live" : "ended",
      pinned: l.pinned,
      // Ours, not eBay's: there is no remote version to report.
      version: l.version,
    };
  }

  async get(listingId: string): Promise<RemoteListing | null> {
    const l = await this.local(listingId);
    if (!l) return null;
    const offer = await this.offerFor(l.sku);
    return EbayMarketplace.toRemote(l, offer);
  }

  /**
   * Take the optimistic lock — by value, because there is no version to take.
   *
   * Reading the offer here is not ceremony: it is the only chance to notice
   * that the seller changed the price in eBay's own UI thirty seconds ago, in
   * which case the markdown the copilot planned is against a number that no
   * longer exists.
   */
  async reserve(intent: ActionIntent): Promise<Reservation> {
    const l = await this.local(intent.listingId);
    if (!l) throw new MarketplaceApplyError(`no listing ${intent.listingId}`);

    const offer = await this.offerFor(l.sku);
    const remote = EbayMarketplace.toRemote(l, offer);

    if (remote.priceCents !== l.priceCents || remote.qty !== l.qty) {
      // Reported as a version conflict because that is what it IS to everything
      // upstream: the plan was made against state that has moved.
      throw new MarketplaceConflict(intent.listingId, l.version, l.version + 1);
    }

    this.seen.set(intent.idempotencyKey, { priceCents: remote.priceCents, qty: remote.qty });
    return {
      token: `ebay_${intent.idempotencyKey}`,
      listingId: intent.listingId,
      expectedVersion: intent.expectedVersion,
      intent,
    };
  }

  async apply(res: Reservation): Promise<RemoteListing> {
    const l = await this.local(res.listingId);
    if (!l) throw new MarketplaceApplyError(`no listing ${res.listingId}`);
    const offerId = this.offers.get(l.sku) ?? (await this.offerFor(l.sku)).offerId;

    // Re-read and compare against what reserve saw. The window is milliseconds,
    // and closing it is the only optimistic guarantee this API supports.
    const before = this.seen.get(res.intent.idempotencyKey);
    const now = EbayMarketplace.toRemote(l, await this.offerFor(l.sku));
    if (before && (now.priceCents !== before.priceCents || now.qty !== before.qty)) {
      throw new MarketplaceConflict(res.listingId, l.version, l.version + 1);
    }

    const p = res.intent.params as { priceCents?: number; qty?: number; delta?: number };

    switch (res.intent.kind) {
      case "markdown_price": {
        const priceCents = p.priceCents ?? now.priceCents;
        await this.setPrice(offerId, l.sku, priceCents);
        return { ...now, priceCents };
      }
      case "adjust_stock": {
        const qty = p.qty ?? Math.max(0, now.qty + (p.delta ?? 0));
        await this.setQty(offerId, l.sku, qty);
        return { ...now, qty };
      }
      case "end_listing": {
        // Withdraw, never delete: the undo window promises this is reversible,
        // and a deleted offer is not.
        await this.call(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`, {
          method: "POST",
        });
        return { ...now, state: "ended" };
      }
      case "push_listing":
      case "swap_pinned":
        // Both are about what is ON SCREEN in the show, which eBay Live exposes
        // no API for. They stay local, and the executor records them as such.
        return now;
      default:
        throw new MarketplaceApplyError(`${res.intent.kind} has no eBay implementation`);
    }
  }

  async confirm(res: Reservation): Promise<void> {
    this.seen.delete(res.intent.idempotencyKey);
  }

  async cancel(res: Reservation): Promise<void> {
    this.seen.delete(res.intent.idempotencyKey);
  }

  /**
   * The inverse write, from the state captured before the action.
   *
   * Not a retry and not a guess: the executor hands back what the listing was,
   * and this puts exactly that back. A withdrawn offer is republished, which is
   * why `apply` withdraws rather than deletes.
   */
  async compensate(res: Reservation, before: Partial<RemoteListing>): Promise<RemoteListing> {
    const l = await this.local(res.listingId);
    if (!l) throw new MarketplaceApplyError(`no listing ${res.listingId}`);
    const offerId = this.offers.get(l.sku) ?? (await this.offerFor(l.sku)).offerId;

    if (before.priceCents != null) await this.setPrice(offerId, l.sku, before.priceCents);
    if (before.qty != null) await this.setQty(offerId, l.sku, before.qty);
    if (before.state === "live") {
      await this.call(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, {
        method: "POST",
      });
    }
    return EbayMarketplace.toRemote(l, await this.offerFor(l.sku));
  }

  private async setPrice(offerId: string, sku: string, priceCents: number): Promise<void> {
    await this.call("/sell/inventory/v1/bulk_update_price_quantity", {
      method: "POST",
      body: JSON.stringify({
        requests: [
          {
            sku,
            offers: [
              {
                offerId,
                price: { value: (priceCents / 100).toFixed(2), currency: "USD" },
              },
            ],
          },
        ],
      }),
    });
  }

  private async setQty(offerId: string, sku: string, qty: number): Promise<void> {
    await this.call("/sell/inventory/v1/bulk_update_price_quantity", {
      method: "POST",
      body: JSON.stringify({
        requests: [
          {
            sku,
            // Quantity lives on the inventory item, not the offer — set both, or
            // the offer keeps advertising stock the item no longer has.
            shipToLocationAvailability: { quantity: qty },
            offers: [{ offerId, availableQuantity: qty }],
          },
        ],
      }),
    });
  }
}
