// What SideStage is spending on Whissle — measured, not estimated.
//
// The platform meters consumption per ORG, and `/usage/sessions` returns
// `agent_id: null` for every text session (verified across 100 sessions on
// 2026-09-13), so the gateway cannot tell us what THIS app, or this show, or
// this agent cost. Two consequences shape this file:
//
//  1. The app meters ITSELF. Every call that leaves for the gateway is counted
//     here, by door and by show. This is the only per-show attribution that
//     exists, and it is exact because we are the one making the calls.
//
//  2. Money comes from the WALLET, never from a token price. There is no
//     published per-token rate for text on this plan, so multiplying tokens by
//     a guessed rate would produce an authoritative-looking number that is
//     wrong. Instead we snapshot the wallet balance when a show starts and
//     diff it — the balance is what the seller is actually charged.
//
// The honest caveat on that diff, stated wherever it is rendered: the wallet is
// ORG-wide. If another app in the same workspace runs during the show, the
// delta over-attributes. It is a bound, not an invoice.

export type GatewayDoor = "chat_turn" | "utility_turn" | "voice_start" | "kb_upload" | "billing" | "visual_read";

export interface DoorStats {
  calls: number;
  failures: number;
  /** Sum of round-trip milliseconds, for the mean. */
  totalMs: number;
  /** Every latency, so percentiles are real rather than a running guess. */
  latencies: number[];
  /** Characters of context we pushed. The grounding block dominates the bill. */
  contextChars: number;
  lastStatus: number | null;
  /** The most recent failure, CLEARED by the next success. A door that has
   *  recovered must not keep showing "service unavailable" — during a gateway
   *  rollout that is exactly the message a seller would read as an outage
   *  minutes after it ended. */
  lastError: string | null;
  lastErrorAt: string | null;
}

/** The wire shape. `latencies` never crosses it — the samples exist to compute
 *  percentiles, and shipping an always-empty array is noise a client must learn
 *  to ignore. */
export type DoorReport = Omit<DoorStats, "latencies"> & {
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
};

export interface MeterSnapshot {
  since: string;
  doors: Record<GatewayDoor, DoorReport>;
  totals: { calls: number; failures: number; contextChars: number };
  byShow: Record<string, ShowMeter>;
}

/** Per-show attribution, including WHICH door the calls went through.
 *  `byShow` used to carry a bare call count, so "where did this show's money
 *  go" was not answerable — only "how many calls did it make". */
export interface ShowMeter {
  calls: number;
  failures: number;
  contextChars: number;
  byDoor: Record<GatewayDoor, { calls: number; failures: number; totalMs: number }>;
}

export function blankShowMeter(): ShowMeter {
  return {
    calls: 0,
    failures: 0,
    contextChars: 0,
    byDoor: Object.fromEntries(DOORS.map((d) => [d, { calls: 0, failures: 0, totalMs: 0 }])) as ShowMeter["byDoor"],
  };
}

const DOORS: GatewayDoor[] = ["chat_turn", "utility_turn", "voice_start", "kb_upload", "billing", "visual_read"];

function blank(): DoorStats {
  return {
    calls: 0, failures: 0, totalMs: 0, latencies: [], contextChars: 0,
    lastStatus: null, lastError: null, lastErrorAt: null,
  };
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[i]);
}

/**
 * Process-wide meter. One instance: the gateway bill is one bill, and every
 * client in this process draws on the same wallet.
 */
export class GatewayMeter {
  private since = new Date().toISOString();
  private doors = new Map<GatewayDoor, DoorStats>(DOORS.map((d) => [d, blank()]));
  private shows = new Map<string, ShowMeter>();

  record(o: {
    door: GatewayDoor;
    ms: number;
    ok: boolean;
    status?: number;
    error?: string;
    showId?: string;
    contextChars?: number;
  }): void {
    const d = this.doors.get(o.door) ?? blank();
    d.calls += 1;
    if (!o.ok) {
      d.failures += 1;
      d.lastError = o.error ?? null;
      d.lastErrorAt = new Date().toISOString();
    } else {
      // Recovered. The cumulative `failures` count keeps the history; the
      // banner does not.
      d.lastError = null;
      d.lastErrorAt = null;
    }
    d.totalMs += o.ms;
    // Bounded: a long show must not turn the meter into a memory leak. 2000
    // samples is far more than percentiles need and costs ~16 KB.
    d.latencies.push(o.ms);
    if (d.latencies.length > 2000) d.latencies.shift();
    d.contextChars += o.contextChars ?? 0;
    if (o.status != null) d.lastStatus = o.status;
    this.doors.set(o.door, d);

    // Per-show attribution — the thing the platform cannot give us — down to
    // the door, so a show's spend can be explained and not just counted.
    const key = o.showId || "unattributed";
    const s = this.shows.get(key) ?? blankShowMeter();
    s.calls += 1;
    if (!o.ok) s.failures += 1;
    s.contextChars += o.contextChars ?? 0;
    const sd = s.byDoor[o.door];
    sd.calls += 1;
    if (!o.ok) sd.failures += 1;
    sd.totalMs += o.ms;
    this.shows.set(key, s);
  }

  snapshot(): MeterSnapshot {
    const doors = {} as MeterSnapshot["doors"];
    let calls = 0, failures = 0, contextChars = 0;
    for (const d of DOORS) {
      const s = this.doors.get(d) ?? blank();
      const { latencies, ...rest } = s;
      const sorted = [...latencies].sort((a, b) => a - b);
      doors[d] = {
        ...rest,
        p50Ms: pct(sorted, 50),
        p95Ms: pct(sorted, 95),
        meanMs: s.calls ? Math.round(s.totalMs / s.calls) : 0,
      };
      calls += s.calls;
      failures += s.failures;
      contextChars += s.contextChars;
    }
    return {
      since: this.since,
      doors,
      totals: { calls, failures, contextChars },
      byShow: Object.fromEntries(this.shows),
    };
  }

  reset(): void {
    this.since = new Date().toISOString();
    this.doors = new Map(DOORS.map((d) => [d, blank()]));
    this.shows.clear();
  }
}

/** The one meter. Imported by the Whissle client, read by /api/billing. */
export const meter = new GatewayMeter();
