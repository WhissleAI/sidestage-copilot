// The money side of the Whissle account, read straight from the gateway.
//
// Three endpoints, three different questions:
//
//   GET /api/whoami                      which org am I spending from
//   GET /api/orgs/{org}/wallet           what is left  (billing:read)
//   GET /api/orgs/{org}/usage/summary    what was consumed  (usage:read)
//
// Wallet and usage are deliberately separate on the platform and stay separate
// here: one is dollars, the other is tokens/seconds/characters. Conflating them
// is how a dashboard ends up quoting a token count as a price.
//
// Every read degrades to a NAMED failure rather than a zero. A missing
// `billing:read` scope and a zero balance must never render identically — that
// was a real bug in the CLI (`ledger: []`, exit 0) and it is the kind of thing a
// seller only discovers when the agent stops answering mid-show.

import { config } from "../config.js";
import { meter } from "./meter.js";

export interface Org { id: string; name: string; slug: string }

export interface Wallet {
  balanceUsd: number | null;
  availableUsd: number | null;
  heldUsd: number | null;
  ratePerMinUsd: number | null;
  freeTestRemainingUsd: number | null;
  lowBalance: boolean;
  paymentsEnabled: boolean;
}

export interface UsageTotal {
  service: string;
  quantity: number;
  unit: string | null;
  events: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface UsageSummary {
  days: number;
  totals: UsageTotal[];
  daily: { day: string; service: string; quantity: number }[];
}

/** A read that failed, carrying WHY — never collapsed into an empty result. */
export interface ReadError { status: number; message: string }

export type Reading<T> = { ok: true; value: T } | { ok: false; error: ReadError };

export class WhissleBilling {
  private base: string;
  private org: Org | null = null;

  constructor(private apiKey: string, baseUrl?: string) {
    this.base = (baseUrl || config.whissle.base).replace(/\/$/, "");
  }

  /** The org this key spends from. Cached: it cannot change under one key. */
  async whoami(): Promise<Reading<Org>> {
    if (this.org) return { ok: true, value: this.org };
    const r = await this.get<{ organization?: Org }>("/api/whoami");
    if (!r.ok) return r;
    const o = r.value.organization;
    if (!o?.id) return { ok: false, error: { status: 502, message: "whoami returned no organization" } };
    this.org = o;
    return { ok: true, value: o };
  }

  async wallet(): Promise<Reading<Wallet>> {
    const who = await this.whoami();
    if (!who.ok) return who;
    const r = await this.get<Record<string, unknown>>(`/api/orgs/${who.value.id}/wallet`);
    if (!r.ok) return r;
    const w = r.value;
    const n = (k: string): number | null => (typeof w[k] === "number" ? (w[k] as number) : null);
    return {
      ok: true,
      value: {
        balanceUsd: n("balance_usd"),
        availableUsd: n("available_usd"),
        heldUsd: n("held_usd"),
        ratePerMinUsd: n("rate_per_min_usd"),
        freeTestRemainingUsd: n("free_test_remaining_usd"),
        lowBalance: Boolean(w.low_balance),
        paymentsEnabled: Boolean(w.payments_enabled),
      },
    };
  }

  /** Consumption for the trailing window. `days` is the platform's own param. */
  async usage(days = 7): Promise<Reading<UsageSummary>> {
    const who = await this.whoami();
    if (!who.ok) return who;
    const r = await this.get<{
      days?: number;
      totals?: Record<string, unknown>[];
      daily?: Record<string, unknown>[];
    }>(`/api/orgs/${who.value.id}/usage/summary?days=${days}`);
    if (!r.ok) return r;
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    const maybe = (v: unknown): number | null => (typeof v === "number" ? v : null);
    return {
      ok: true,
      value: {
        days: r.value.days ?? days,
        totals: (r.value.totals || []).map((t) => ({
          service: String(t.service ?? "—"),
          quantity: num(t.quantity),
          unit: t.unit == null ? null : String(t.unit),
          events: num(t.events),
          promptTokens: maybe(t.prompt_tokens),
          completionTokens: maybe(t.completion_tokens),
        })),
        daily: (r.value.daily || []).map((d) => ({
          day: String(d.day ?? ""),
          service: String(d.service ?? "—"),
          quantity: num(d.quantity),
        })),
      },
    };
  }

  private async get<T>(path: string): Promise<Reading<T>> {
    const t0 = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(`${this.base}${path}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: ctl.signal,
      });
      const ms = performance.now() - t0;
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        meter.record({ door: "billing", ms, ok: false, status: r.status, error: body.slice(0, 200) });
        return {
          ok: false,
          error: {
            status: r.status,
            // A 403 here means a SCOPE, and saying which one turns a dead panel
            // into a one-line fix. The gateway names it in the body.
            message: r.status === 403
              ? `not permitted — this key is missing a scope (billing:read for the wallet, usage:read for consumption). ${body.slice(0, 160)}`
              : body.slice(0, 200) || r.statusText,
          },
        };
      }
      meter.record({ door: "billing", ms, ok: true, status: r.status });
      return { ok: true, value: (await r.json()) as T };
    } catch (e) {
      const ms = performance.now() - t0;
      const message = (e as Error).name === "AbortError" ? "gateway timeout" : (e as Error).message;
      meter.record({ door: "billing", ms, ok: false, error: message });
      return { ok: false, error: { status: 0, message } };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * What a window of work actually cost, measured against the wallet.
 *
 * No token price is guessed. A balance is read when the window opens and again
 * when it is asked for, and the difference is the spend. That makes the number
 * verifiable — the seller can open the Whissle console and see the same two
 * balances.
 *
 * The caveat travels with the number, because it is not optional: the wallet is
 * ORG-wide, so anything else running in the same workspace during the window is
 * counted too. It is an upper bound on this show's cost, and the UI says so.
 */
export class SpendWindow {
  private opened = new Map<string, { at: string; balanceUsd: number }>();

  /** Record the opening balance for a window (a show id, or "process"). */
  open(key: string, balanceUsd: number | null): void {
    if (balanceUsd == null || this.opened.has(key)) return;
    this.opened.set(key, { at: new Date().toISOString(), balanceUsd });
  }

  close(key: string): void {
    this.opened.delete(key);
  }

  /** Spend so far for every open window, against the balance just read. */
  since(balanceUsd: number | null): Record<string, { openedAt: string; openingUsd: number; spentUsd: number }> {
    const out: Record<string, { openedAt: string; openingUsd: number; spentUsd: number }> = {};
    if (balanceUsd == null) return out;
    for (const [k, v] of this.opened) {
      out[k] = {
        openedAt: v.at,
        openingUsd: v.balanceUsd,
        // Rounded to the cent the wallet is denominated in. A negative delta
        // (a top-up landed mid-window) is reported as 0 rather than as income.
        spentUsd: Math.max(0, Math.round((v.balanceUsd - balanceUsd) * 10000) / 10000),
      };
    }
    return out;
  }
}

export const spendWindow = new SpendWindow();
