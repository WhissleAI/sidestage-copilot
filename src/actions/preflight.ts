// Preflight — every check that must pass before a write is even offered to the
// seller for approval.
//
// Two properties matter here:
//
//  1. Preflight runs BEFORE the action is shown, and its result is shown WITH it.
//     The operator console renders the checklist on the card, so the seller
//     approves a write knowing exactly which limits it respects. An approval
//     button with no visible constraints is how sellers learn not to trust a
//     copilot.
//  2. Preflight captures the `before` snapshot. That snapshot is the ONLY input
//     to rollback, so it is taken here, from live state, and carried with the
//     action for its whole life.
//
// Checks are pure functions of (listing, params, policy, show budget). They do no
// I/O, which is why the whole action layer is testable without credentials.

import type { ActionKind, PreflightCheck } from "../domain/types.js";
import type { ListingWithDescription, Repo } from "../domain/repo.js";
import { formatMoney } from "../domain/money.js";
import { policy } from "../guardrails/policy.js";

export interface PreflightContext {
  /** True for a stream we are monitoring but do not own. */
  readOnlyShow?: boolean;
  /** How many actions have already been committed in this show. */
  committedThisShow: number;
  /** Hard ceiling on writes per show, so a stuck proposer cannot churn the catalog. */
  actionBudget: number;
  /** Committed actions in the last minute, for the rate check. */
  committedLastMinute: number;
  ratePerMinute: number;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  before: Record<string, unknown>;
}

const ok = (name: string, detail: string): PreflightCheck => ({ name, ok: true, detail });
const no = (name: string, detail: string): PreflightCheck => ({ name, ok: false, detail });

export function preflight(
  kind: ActionKind,
  listing: ListingWithDescription | null,
  params: Record<string, unknown>,
  repo: Repo,
  ctx: PreflightContext,
): PreflightResult {
  const checks: PreflightCheck[] = [];

  if (!listing) {
    return { ok: false, checks: [no("listing exists", "the listing this action targets was not found")], before: {} };
  }

  // The prior-state snapshot. Captured once, carried for the action's lifetime,
  // and the sole source of truth for compensation.
  const before = {
    priceCents: listing.priceCents,
    qty: listing.qty,
    state: listing.state,
    pinned: listing.pinned,
    version: listing.version,
  };

  // ── ownership ─────────────────────────────────────────────────────────────
  // Monitoring someone else's eBay Live show is read-only by construction: we
  // hold no seller credentials for it, so a markdown we could never commit would
  // be theatre. The copilot still drafts replies; it just cannot act.
  if (ctx.readOnlyShow) {
    checks.push(no("show is yours to edit", "this is a monitored stream — no seller credentials for it"));
  }

  // ── global limits, every action kind ──────────────────────────────────────
  checks.push(
    ctx.committedThisShow < ctx.actionBudget
      ? ok("show action budget", `${ctx.committedThisShow} of ${ctx.actionBudget} writes used this show`)
      : no("show action budget", `budget of ${ctx.actionBudget} writes for this show is spent`),
  );
  checks.push(
    ctx.committedLastMinute < ctx.ratePerMinute
      ? ok("write rate", `${ctx.committedLastMinute} of ${ctx.ratePerMinute} writes in the last minute`)
      : no("write rate", `${ctx.ratePerMinute} writes per minute already used`),
  );

  // ── per-kind ──────────────────────────────────────────────────────────────
  switch (kind) {
    case "markdown_price": {
      const next = Number(params.newPriceCents);
      const p = policy();
      if (!Number.isFinite(next) || next <= 0) {
        checks.push(no("valid price", "newPriceCents is missing or not a positive number"));
        break;
      }
      checks.push(
        next < listing.priceCents
          ? ok("is a markdown", `${formatMoney(listing.priceCents)} to ${formatMoney(next)}`)
          : no("is a markdown", `${formatMoney(next)} is not below the current ${formatMoney(listing.priceCents)}`),
      );
      checks.push(
        next >= listing.floorPriceCents
          ? ok("above floor price", `floor is ${formatMoney(listing.floorPriceCents)}`)
          : no("above floor price", `${formatMoney(next)} is below the ${formatMoney(listing.floorPriceCents)} floor`),
      );
      const discount = ((listing.priceCents - next) / listing.priceCents) * 100;
      checks.push(
        discount <= p.maxDiscountPct + 0.0001
          ? ok(`within ${p.maxDiscountPct}% max discount`, `${discount.toFixed(1)}% off`)
          : no(`within ${p.maxDiscountPct}% max discount`, `${discount.toFixed(1)}% off exceeds the cap`),
      );
      checks.push(
        next > listing.costCents
          ? ok("above cost basis", `cost is ${formatMoney(listing.costCents)}`)
          : no("above cost basis", `${formatMoney(next)} is at or below the ${formatMoney(listing.costCents)} cost basis`),
      );
      checks.push(
        listing.state !== "ended"
          ? ok("listing is active", `state is ${listing.state}`)
          : no("listing is active", "an ended listing cannot be marked down"),
      );
      break;
    }

    case "adjust_stock": {
      const next = Number(params.newQty);
      if (!Number.isInteger(next)) {
        checks.push(no("valid quantity", "newQty is missing or not an integer"));
        break;
      }
      checks.push(
        next >= 0 ? ok("non-negative stock", `new quantity ${next}`) : no("non-negative stock", `${next} is negative`),
      );
      checks.push(
        next !== listing.qty
          ? ok("changes stock", `${listing.qty} to ${next}`)
          : no("changes stock", `already ${listing.qty}`),
      );
      // Guard the fat-finger case: a 10x jump in a live show is far more likely
      // to be a bug in the proposer than a real restock.
      const jump = Math.abs(next - listing.qty);
      checks.push(
        jump <= 10
          ? ok("plausible adjustment", `changes by ${jump}`)
          : no("plausible adjustment", `a change of ${jump} units mid-show needs a manual edit`),
      );
      break;
    }

    case "swap_pinned": {
      checks.push(
        !listing.pinned ? ok("not already pinned", `${listing.title} is not the pinned lot`) : no("not already pinned", "this lot is already pinned"),
      );
      checks.push(
        listing.state !== "ended" ? ok("listing is active", `state is ${listing.state}`) : no("listing is active", "an ended listing cannot be pinned"),
      );
      checks.push(
        listing.qty > 0 ? ok("has stock", `${listing.qty} available`) : no("has stock", "cannot pin a sold-out lot"),
      );
      break;
    }

    case "push_listing": {
      checks.push(
        listing.state === "queued" || listing.state === "draft"
          ? ok("is queued", `state is ${listing.state}`)
          : no("is queued", `state is ${listing.state}; only queued or draft lots can be pushed live`),
      );
      checks.push(
        listing.qty > 0 ? ok("has stock", `${listing.qty} available`) : no("has stock", "cannot push a sold-out lot live"),
      );
      checks.push(
        listing.priceCents >= listing.floorPriceCents
          ? ok("priced above floor", `${formatMoney(listing.priceCents)} vs floor ${formatMoney(listing.floorPriceCents)}`)
          : no("priced above floor", "listed price is below the floor price"),
      );
      break;
    }

    case "end_listing": {
      checks.push(
        listing.state !== "ended" ? ok("not already ended", `state is ${listing.state}`) : no("not already ended", "already ended"),
      );
      checks.push(
        !listing.pinned
          ? ok("not the pinned lot", "ending will not blank the show")
          : no("not the pinned lot", "pin a different lot before ending this one"),
      );
      break;
    }
  }

  return { ok: checks.every((c) => c.ok), checks, before };
}

/** A stable idempotency key: the same intent against the same listing version
 *  produces the same key, so a duplicated approval is recognised as a duplicate. */
export function idempotencyKey(kind: ActionKind, listingId: string, version: number, params: Record<string, unknown>): string {
  const norm = Object.keys(params).sort().map((k) => `${k}=${String(params[k])}`).join("&");
  return `${kind}:${listingId}:v${version}:${norm}`;
}

export function showBudgetContext(
  repo: Repo,
  d: { committedThisShow: number; committedLastMinute: number },
): PreflightContext {
  return {
    readOnlyShow: repo.show().readOnly,
    committedThisShow: d.committedThisShow,
    actionBudget: Number(process.env.ACTION_BUDGET_PER_SHOW || 25),
    committedLastMinute: d.committedLastMinute,
    ratePerMinute: Number(process.env.ACTION_RATE_PER_MIN || 6),
  };
}
