// Latency instrumentation.
//
// The 2-second budget is a product promise, so it is measured per stage and
// reported on every single reply rather than sampled. When a reply is slow the
// operator can see WHICH stage was slow, and so can we — `npm run bench` prints
// the same breakdown across a 200-message show.
//
// Budget allocation (docs/TDD.md §5), against a p95 target of 2000 ms:
//   admit + classify     120 ms   local, regex + token work
//   retrieve             150 ms   in-process index, no network
//   compose             1400 ms   the only network hop, and the whole variance
//   guard                 80 ms   deterministic, no I/O
//   headroom             250 ms
// Everything except `compose` is local by design: the only way to hold a
// sub-2s budget with a remote LLM in the path is to spend nothing else on I/O.

import type { SpanBreakdown } from "../domain/types.js";

export type Stage = "admit" | "classify" | "retrieve" | "compose" | "guard" | "repair";

export class SpanTimer {
  private t0 = performance.now();
  private last = this.t0;
  private spans: Record<Stage, number> = {
    admit: 0, classify: 0, retrieve: 0, compose: 0, guard: 0, repair: 0,
  };

  /** Close the current stage and attribute the elapsed time to it. */
  mark(stage: Stage): void {
    const now = performance.now();
    this.spans[stage] += now - this.last;
    this.last = now;
  }

  /** Attribute an explicit duration — for work that ran concurrently and so
   *  cannot be measured by the wall-clock cursor above. */
  add(stage: Stage, ms: number): void {
    this.spans[stage] += ms;
  }

  get totalMs(): number {
    return performance.now() - this.t0;
  }

  result(budgetMs: number, cacheHit: boolean): SpanBreakdown {
    const total = this.totalMs;
    const r = (x: number) => Math.round(x * 10) / 10;
    return {
      admitMs: r(this.spans.admit),
      classifyMs: r(this.spans.classify),
      retrieveMs: r(this.spans.retrieve),
      composeMs: r(this.spans.compose),
      guardMs: r(this.spans.guard),
      repairMs: r(this.spans.repair),
      totalMs: r(total),
      cacheHit,
      budgetMs,
      overBudget: total > budgetMs,
    };
  }
}

/** A rolling window of end-to-end latencies. Bounded so a long show cannot grow
 *  it without limit; percentiles over the last N replies are what an operator
 *  cares about anyway — a p95 including the first minute of the show is stale. */
export class LatencyTracker {
  private samples: number[] = [];
  private _breaches = 0;
  private _cacheHits = 0;
  private _total = 0;

  constructor(private budgetMs: number, private window = 500) {}

  record(totalMs: number, cacheHit: boolean): void {
    this.samples.push(totalMs);
    if (this.samples.length > this.window) this.samples.shift();
    this._total++;
    if (cacheHit) this._cacheHits++;
    if (totalMs > this.budgetMs) this._breaches++;
  }

  percentiles(): { p50: number; p95: number; p99: number; budgetMs: number; breaches: number } {
    const s = [...this.samples].sort((a, b) => a - b);
    return {
      p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99),
      budgetMs: this.budgetMs, breaches: this._breaches,
    };
  }

  get cacheHitRate(): number {
    return this._total ? Number((this._cacheHits / this._total).toFixed(3)) : 0;
  }

  get count(): number {
    return this._total;
  }
}

/** Nearest-rank percentile. On an empty sample the honest answer is 0, not NaN. */
export function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]);
}
