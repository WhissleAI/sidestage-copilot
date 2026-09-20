// How often one caller may knock.
//
// There was no limit of any kind, and the front door is the expensive one:
// `POST /api/auth/login` runs scrypt at N=2^14 — 16 MB and ~100 ms of CPU —
// BEFORE the caller is authenticated, in a container capped at 1100 MB on a
// t3.small, with Fastify applying no concurrency limit of its own. Roughly
// seventy concurrent logins from one unauthenticated caller exhausted the box
// and the app was OOM-killed; `restart: unless-stopped` brought it back for
// the next seventy. There was also no per-account lockout, so guessing a
// password was unbounded.
//
// In-process and dependency-free on purpose: this repo's node_modules is
// shared with another checkout, and a rate limiter is not a reason to move a
// dependency tree. One process is also where the limit belongs today — one
// container serves the whole site. A second instance would want a shared
// store, and the seam for that is this file.
//
// Fixed windows rather than a token bucket. A fixed window allows a burst of
// at most 2× across a boundary, which is the honest cost of an implementation
// an operator can reason about — and the numbers below are set far enough
// above real use that 2× is still nowhere near a person.

export interface Limit {
  /** Window length. */
  windowMs: number;
  /** Requests allowed per key per window. */
  max: number;
}

export interface Verdict {
  ok: boolean;
  /** Whole seconds until the window rolls, for `Retry-After`. */
  retryAfterS: number;
  remaining: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();
  /** Swept lazily: a limiter that grows a Map per attacker IP and never
   *  forgets one is its own memory-exhaustion bug. */
  private lastSweep = 0;

  constructor(private now: () => number = Date.now) {}

  hit(key: string, limit: Limit): Verdict {
    const t = this.now();
    this.sweep(t);
    const w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
      this.windows.set(key, { count: 1, resetAt: t + limit.windowMs });
      return { ok: true, retryAfterS: 0, remaining: limit.max - 1 };
    }
    w.count += 1;
    const retryAfterS = Math.max(1, Math.ceil((w.resetAt - t) / 1000));
    if (w.count > limit.max) return { ok: false, retryAfterS, remaining: 0 };
    return { ok: true, retryAfterS: 0, remaining: Math.max(0, limit.max - w.count) };
  }

  /** Test seam, and what a restart does. */
  reset(): void {
    this.windows.clear();
  }

  get size(): number {
    return this.windows.size;
  }

  private sweep(t: number): void {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    for (const [k, w] of this.windows) if (w.resetAt <= t) this.windows.delete(k);
  }
}

/**
 * A bound on how many expensive things run AT ONCE.
 *
 * Rate limiting bounds arrivals; it does not bound concurrency, and the login
 * failure is a concurrency failure — seventy scrypts in flight is 1.1 GB
 * whether they arrived over a second or a minute. This is the other half:
 * `slots` at a time, everyone else waits, and past `maxWaiting` the request is
 * refused rather than queued, because an unbounded queue is the same leak with
 * a longer fuse.
 */
export class Gate {
  private active = 0;
  private waiting: (() => void)[] = [];
  /** The most that were ever in flight together — the number this class
   *  exists to hold down, kept so a test can assert it. */
  peak = 0;

  constructor(private slots: number, private maxWaiting = 64) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.slots) {
      if (this.waiting.length >= this.maxWaiting) {
        throw new GateBusy(`too many requests are already waiting (${this.waiting.length})`);
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    if (this.active > this.peak) this.peak = this.active;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export class GateBusy extends Error {
  readonly status = 503;
}
