// The per-show spend cap, enforced.
//
// `automation.perShowCapUsd` and `automation.warnBalanceUsd` were settable for
// weeks and read by nothing: a seller could type $2.00 into a field, save it,
// watch the page confirm the save, and spend $9. A control that does not
// control is worse than no control, because it buys confidence it has not
// earned.
//
// What enforcement can honestly mean here is bounded by how the money is
// measured. There is no per-token price for text on this plan and the gateway
// attributes nothing per-agent, so spend is a WALLET DELTA — org-wide, which
// makes it an upper bound rather than an invoice (see meter.ts). Two things
// follow:
//
//  1. The cap is checked against a bound, so it trips EARLY, never late. That
//     is the right direction for a spending limit and the console says which
//     number it is enforcing against.
//  2. The wallet has to be READ for the number to move, and it is only read
//     when someone opens the cost page. So this polls — slowly, and only while
//     a show is live, because each read is a gateway round trip.
//
// Tripping the cap stops the copilot DRAFTING. It does not stop ingesting: the
// questions keep arriving, marked with why they were not answered, because a
// seller who has hit their cap still needs to see what they are missing.

import { spendWindow, type WhissleBilling } from "./billing.js";

export interface BudgetState {
  /** Upper bound on what this show has cost, in dollars. Null = never read. */
  spentUsd: number | null;
  /** The seller's cap, or null when they have not set one. */
  capUsd: number | null;
  /** True once spend has reached the cap. Latched: it does not flap. */
  capped: boolean;
  balanceUsd: number | null;
  /** The wallet is below `warnBalanceUsd` — a warning, never a stop. */
  lowBalance: boolean;
  /** When the wallet was last read. Null means it never has been. */
  readAt: string | null;
  /** Why the wallet could not be read, when it could not. */
  error: string | null;
}

const BLANK: BudgetState = {
  spentUsd: null,
  capUsd: null,
  capped: false,
  balanceUsd: null,
  lowBalance: false,
  readAt: null,
  error: null,
};

export class BudgetWatch {
  private balanceUsd: number | null = null;
  private readAt: string | null = null;
  private error: string | null = null;
  private capped = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private billing: WhissleBilling,
    /** Read fresh each time: the seller can change it mid-show. */
    private limits: () => { perShowCapUsd: number | null; warnBalanceUsd: number },
    /** Which shows are live. No live show, no reason to poll. */
    private liveShows: () => Promise<string[]>,
    /** Called once, the first time a show crosses its cap. */
    private onCapped?: (showId: string, state: BudgetState) => void,
  ) {}

  start(everyMs = 60_000): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A show that ended should not stay latched if its id is ever reused. */
  release(showId: string): void {
    this.capped.delete(showId);
  }

  /** One read, now. The poller's own tick, exposed so a test — or a "check
   *  now" button — can take a reading without waiting out the interval. */
  async checkNow(): Promise<void> {
    await this.poll();
  }

  private async poll(): Promise<void> {
    const live = await this.liveShows().catch(() => [] as string[]);
    if (live.length === 0) return;

    const w = await this.billing.wallet();
    if (!w.ok) {
      this.error = `${w.error.status}: ${w.error.message}`;
      return;
    }
    this.error = null;
    this.balanceUsd = w.value.balanceUsd;
    this.readAt = new Date().toISOString();
    // Recomputes every open window's spend and remembers it, which is what
    // `state()` reads back.
    spendWindow.since(w.value.balanceUsd);

    const { perShowCapUsd } = this.limits();
    if (perShowCapUsd == null) return;
    for (const showId of live) {
      const spent = spendWindow.lastKnown(showId);
      if (spent != null && spent >= perShowCapUsd && !this.capped.has(showId)) {
        this.capped.add(showId);
        this.onCapped?.(showId, this.state(showId));
      }
    }
  }

  state(showId: string): BudgetState {
    const { perShowCapUsd, warnBalanceUsd } = this.limits();
    const spentUsd = spendWindow.lastKnown(showId);
    return {
      ...BLANK,
      spentUsd,
      capUsd: perShowCapUsd,
      capped: this.capped.has(showId),
      balanceUsd: this.balanceUsd,
      lowBalance: this.balanceUsd != null && this.balanceUsd < warnBalanceUsd,
      readAt: this.readAt,
      error: this.error,
    };
  }

  /** The one question the pipeline asks: may I spend on this show? */
  isCapped(showId: string): boolean {
    return this.capped.has(showId);
  }
}

// ── one watch, reachable from both ends ─────────────────────────────────────
//
// The pipeline must ask "may I spend?" on every message and has no business
// holding a billing client; the routes own the billing client and have no
// business reaching into a pipeline. A module-level handle is the seam.

let current: BudgetWatch | null = null;

export function setBudgetWatch(w: BudgetWatch | null): void {
  current = w;
}

/** Started by the server, never by `buildApp`: the test suite must not poll a
 *  gateway, and a wallet read is a real round trip. */
export function startBudgetWatch(everyMs?: number): void {
  current?.start(everyMs);
}

export function stopBudgetWatch(): void {
  current?.stop();
}

export function budgetState(showId: string): BudgetState {
  return current ? current.state(showId) : BLANK;
}

/** The one question the pipeline asks. False whenever nothing is watching. */
export function isOverBudget(showId: string): boolean {
  return current?.isCapped(showId) ?? false;
}
