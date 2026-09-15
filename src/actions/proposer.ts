// The action proposer — turns patterns in buyer chat into concrete, bounded
// operational proposals.
//
// This is the half of the product that is not about replying. A solo seller
// loses money to operational lag: four people ask for a discount and nobody
// lowers the price; the pinned lot sold out three minutes ago and chat is still
// asking for it; the item everyone is asking about is not the one on screen.
// Each of those is a detectable pattern with an obvious, reversible fix.
//
// Every proposal is derived from COUNTED EVIDENCE over a time window, and the
// count goes into the rationale, so the seller can see why it fired and judge it
// in a glance. A proposal with no legible reason is one a seller learns to ignore.

import type { ActionKind, ChatIntent } from "../domain/types.js";
import type { Repo } from "../domain/repo.js";
import { formatMoney } from "../domain/money.js";
import { median } from "../retrieval/facts.js";
import { policy } from "../guardrails/policy.js";

export interface Signal {
  at: number;
  intent: ChatIntent;
  listingId: string | null;
  author: string;
}

export interface ProposedAction {
  kind: ActionKind;
  listingId: string;
  params: Record<string, unknown>;
  summary: string;
  rationale: string;
  /** Stable across re-fires, so the pipeline does not propose the same thing twice. */
  dedupeKey: string;
}

export interface ProposerOpts {
  windowMs?: number;
  /** Distinct askers needed before a markdown is proposed. */
  discountThreshold?: number;
  /** Questions about an unpinned lot before proposing a swap. */
  swapThreshold?: number;
}

export class ActionProposer {
  private signals: Signal[] = [];
  private windowMs: number;
  private discountThreshold: number;
  private swapThreshold: number;

  constructor(private repo: Repo, opts: ProposerOpts = {}) {
    this.windowMs = opts.windowMs ?? 180_000;
    this.discountThreshold = opts.discountThreshold ?? 3;
    this.swapThreshold = opts.swapThreshold ?? 4;
  }

  record(s: Signal): void {
    this.signals.push(s);
    const cutoff = Date.now() - this.windowMs;
    while (this.signals.length && this.signals[0].at < cutoff) this.signals.shift();
  }

  /** Evaluate every rule against the current window. Returns zero or more
   *  proposals; the caller de-duplicates on `dedupeKey`. */
  async evaluate(): Promise<ProposedAction[]> {
    const recent = this.signals.filter((s) => s.at >= Date.now() - this.windowMs);
    const out: ProposedAction[] = [];

    // The rules are independent reads, so they run together rather than in a
    // chain of four round trips inside the reply budget.
    const rules = await Promise.all([
      this.markdownRule(recent),
      this.soldOutRule(recent),
      this.swapRule(recent),
      this.pushNextRule(),
    ]);
    for (const r of rules) out.push(...r);

    return out;
  }

  /** Sustained discount pressure on one lot. */
  private async markdownRule(recent: Signal[]): Promise<ProposedAction[]> {
    const byListing = groupDistinctAuthors(recent.filter((s) => s.intent === "discount_request"));
    const out: ProposedAction[] = [];

    for (const [listingId, askers] of byListing) {
      if (askers.size < this.discountThreshold) continue;
      const l = await this.repo.listing(listingId);
      if (!l || l.state === "ended" || l.qty === 0) continue;

      // Target the market median when there is one, but never below the floor,
      // and never more than the policy cap off the current price.
      const comps = (await this.repo.comps(l.sku)).map((c) => c.priceCents);
      const med = median(comps);
      const capFloor = Math.ceil(l.priceCents * (1 - policy().maxDiscountPct / 100));
      const target = Math.max(l.floorPriceCents, capFloor, med || 0);
      const newPrice = Math.min(l.priceCents, roundTo(target, 500));
      if (newPrice >= l.priceCents) continue;

      const off = ((l.priceCents - newPrice) / l.priceCents) * 100;
      out.push({
        kind: "markdown_price",
        listingId,
        params: { newPriceCents: newPrice },
        summary: `Mark down ${l.title} · size ${l.size} — ${formatMoney(l.priceCents)} to ${formatMoney(newPrice)} (${off.toFixed(0)}% off)`,
        rationale: med
          ? `${askers.size} different buyers asked for a discount in the last ${Math.round(this.windowMs / 60000)} minutes; the 30-day median is ${formatMoney(med)}.`
          : `${askers.size} different buyers asked for a discount in the last ${Math.round(this.windowMs / 60000)} minutes.`,
        dedupeKey: `markdown:${listingId}:v${l.version}`,
      });
    }
    return out;
  }

  /** Chat still asking for a lot that has no stock. */
  private async soldOutRule(recent: Signal[]): Promise<ProposedAction[]> {
    const byListing = groupDistinctAuthors(recent.filter((s) => s.intent === "availability"));
    const out: ProposedAction[] = [];

    for (const [listingId, askers] of byListing) {
      const l = await this.repo.listing(listingId);
      if (!l || l.qty > 0 || l.state === "ended") continue;
      if (askers.size < 2) continue;

      out.push({
        kind: "end_listing",
        listingId,
        params: {},
        summary: `End ${l.title} · size ${l.size} — sold out`,
        rationale: `${askers.size} buyers asked about a lot with 0 stock. Ending it stops the questions and clears the board.`,
        dedupeKey: `end:${listingId}:v${l.version}`,
      });
    }
    return out;
  }

  /** Interest has moved to a lot that is not on screen. */
  private async swapRule(recent: Signal[]): Promise<ProposedAction[]> {
    const pinned = await this.repo.pinned();
    const interest = groupDistinctAuthors(
      recent.filter((s) => s.intent !== "hype" && s.listingId && s.listingId !== pinned?.id),
    );
    const out: ProposedAction[] = [];

    for (const [listingId, askers] of interest) {
      if (askers.size < this.swapThreshold) continue;
      const l = await this.repo.listing(listingId);
      if (!l || l.pinned || l.state === "ended" || l.qty === 0) continue;

      out.push({
        kind: "swap_pinned",
        listingId,
        params: {},
        summary: `Pin ${l.title} · size ${l.size}`,
        rationale: `${askers.size} buyers are asking about this lot while ${pinned ? pinned.title : "another lot"} is on screen.`,
        dedupeKey: `swap:${listingId}:v${l.version}`,
      });
    }
    return out;
  }

  /** The pinned lot is done; the queue is not. */
  private async pushNextRule(): Promise<ProposedAction[]> {
    const pinned = await this.repo.pinned();
    if (pinned && pinned.qty > 0 && pinned.state !== "ended") return [];

    const queue = (await this.repo.show()).lotQueue;
    const next = (await Promise.all(queue.map((id) => this.repo.listing(id))))
      .find((l) => l && l.state === "queued" && l.qty > 0);
    if (!next) return [];

    return [{
      kind: "push_listing",
      listingId: next.id,
      params: {},
      summary: `Push ${next.title} · size ${next.size} live — ${formatMoney(next.priceCents)}`,
      rationale: pinned
        ? `${pinned.title} is ${pinned.qty === 0 ? "sold out" : "ended"}; this is next in the lot queue.`
        : "Nothing is pinned and this is next in the lot queue.",
      dedupeKey: `push:${next.id}:v${next.version}`,
    }];
  }
}

function groupDistinctAuthors(signals: Signal[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const s of signals) {
    if (!s.listingId) continue;
    let set = m.get(s.listingId);
    if (!set) m.set(s.listingId, (set = new Set()));
    set.add(s.author);
  }
  return m;
}

/** Round to a sane price point — sellers do not mark down to $371.43. */
function roundTo(cents: number, step: number): number {
  return Math.ceil(cents / step) * step;
}
