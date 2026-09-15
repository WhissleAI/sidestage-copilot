// The seller's settings — one editable object, two enforcement points.
//
// `src/guardrails/policy.ts` explains WHY the policy is one object: Layer A is
// pushed onto the Whissle agent and fires even when this app is not in the loop;
// Layer B runs here against live catalog state. This file is what makes that
// object EDITABLE, and the interesting property is that a save has to reach
// both — or the two layers drift and the whole argument for the design
// collapses.
//
// So `save()` is not a database write. It is:
//
//   1. persist the override            (so a restart keeps it)
//   2. re-arm Layer B in this process  (the very next reply is checked by it)
//   3. re-push Layer A to the agent    (so the rule holds on voice and embed too)
//   4. READ BACK what the gateway says is armed
//
// Step 4 matters more than it looks. Pushing config and assuming it took is how
// you end up believing in a guardrail that is not there — `seed:agent` already
// reads back for exactly this reason, and a settings page that does not would
// be a worse version of it with a nicer font.

import type { Pool } from "../db/pg.js";
import {
  DEFAULT_POLICY, setPolicy, type SellerGuardrailPolicy,
  toContentGuardrails, toActionPolicy,
} from "../guardrails/policy.js";

/** What the gateway reports as actually armed, after a push. */
export interface ArmedReport {
  ok: boolean;
  /** Human-readable lines, straight from /api/agents/{id}/guardrails. */
  items: { label: string; value: unknown }[];
  error?: string;
  agentId?: string;
}

export interface SettingsView {
  policy: SellerGuardrailPolicy;
  defaults: SellerGuardrailPolicy;
  /** Only the fields that differ from the defaults — what the seller changed. */
  overrides: Partial<SellerGuardrailPolicy>;
  armed: ArmedReport | null;
  updatedAt: string | null;
  /** What Layer B is checking THIS request against — read from the live
   *  policy scope, not from the row. The two agree when tenancy works. */
  enforcing?: SellerGuardrailPolicy;
}

/** Fields a settings client may set. Anything else in the body is ignored
 *  rather than merged, so a stale or hostile client cannot inject keys into the
 *  object the guards read. */
const EDITABLE = new Set<keyof SellerGuardrailPolicy>([
  "neverSay", "redactPii", "onViolation", "maxDiscountPct", "maxReplyChars",
  "allowMarkdown", "allowEmoji", "hypePhrases", "languageMode", "holdForApproval",
  // What the copilot may use, and how much it may do on its own. Both were
  // env-only, which meant a seller could not change either without a restart.
  "ingest", "automation",
]);

export function sanitize(input: unknown): Partial<SellerGuardrailPolicy> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!EDITABLE.has(k as keyof SellerGuardrailPolicy)) continue;
    out[k] = v;
  }
  // Bounds, because these drive real behaviour and a typo should not disable a
  // guard. A discount cap of 100% is not a setting, it is an outage.
  if (typeof out.maxDiscountPct === "number") {
    out.maxDiscountPct = Math.max(0, Math.min(50, out.maxDiscountPct));
  }
  if (typeof out.maxReplyChars === "number") {
    out.maxReplyChars = Math.max(80, Math.min(2000, out.maxReplyChars));
  }
  // Automation bounds. L4 is deliberately not settable as a STARTING rung —
  // bounded auto-acting only ever runs against a mock marketplace, so nobody
  // gets to begin a show there.
  if (out.automation && typeof out.automation === "object") {
    const a = out.automation as Record<string, unknown>;
    const rungs = ["L0_OBSERVE", "L1_SUGGEST", "L2_ONE_TAP", "L3_AUTO_REPLY"];
    if (typeof a.startingRung === "string" && !rungs.includes(a.startingRung)) a.startingRung = "L1_SUGGEST";
    if (typeof a.confidenceFloor === "number") a.confidenceFloor = Math.max(0.5, Math.min(0.99, a.confidenceFloor));
    if (typeof a.undoWindowS === "number") a.undoWindowS = Math.max(10, Math.min(600, a.undoWindowS));
    if (typeof a.actionBudget === "number") a.actionBudget = Math.max(0, Math.min(100, a.actionBudget));
    if (typeof a.warnBalanceUsd === "number") a.warnBalanceUsd = Math.max(0, Math.min(1000, a.warnBalanceUsd));
    if (typeof a.perShowCapUsd === "number") a.perShowCapUsd = Math.max(0, Math.min(1000, a.perShowCapUsd));
  }
  // Buyer chat is not a toggle: with it off there is nothing to answer.
  if (out.ingest && typeof out.ingest === "object") {
    const i = out.ingest as Record<string, unknown>;
    for (const k of ["hostAudio", "cameraFrames", "webResearch", "priorAnswers"]) {
      if (k in i) i[k] = Boolean(i[k]);
    }
  }
  if (Array.isArray(out.neverSay)) {
    out.neverSay = (out.neverSay as unknown[])
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
      .map((r) => ({
        pattern: String(r.pattern ?? "").slice(0, 200),
        regex: Boolean(r.regex),
        why: String(r.why ?? "violates the seller's policy").slice(0, 200),
        ...(r.unlessCertified ? { unlessCertified: true } : {}),
      }))
      .filter((r) => r.pattern.length > 0);
  }
  return out as Partial<SellerGuardrailPolicy>;
}

/**
 * A regex the seller typed must not be able to take the reply path down.
 *
 * `neverSayMatchers` compiles these with `new RegExp`, so an invalid pattern
 * throws inside the policy guard — and a guard that throws returns `block`
 * (chain.ts), which would silently block every reply until someone read the
 * logs. Validating on save turns that into a message on the form.
 */
export function invalidPatterns(p: Partial<SellerGuardrailPolicy>): string[] {
  const bad: string[] = [];
  for (const r of p.neverSay ?? []) {
    if (!r.regex) continue;
    try {
      new RegExp(r.pattern, "i");
    } catch (e) {
      bad.push(`${r.pattern} — ${(e as Error).message}`);
    }
  }
  return bad;
}

export function merge(overrides: Partial<SellerGuardrailPolicy>): SellerGuardrailPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

/** Which keys the seller has actually changed, for the "reset" affordance. */
export function diffFromDefaults(p: SellerGuardrailPolicy): Partial<SellerGuardrailPolicy> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULT_POLICY) as (keyof SellerGuardrailPolicy)[]) {
    if (JSON.stringify(p[k]) !== JSON.stringify(DEFAULT_POLICY[k])) out[k] = p[k];
  }
  return out as Partial<SellerGuardrailPolicy>;
}

export class SettingsStore {
  constructor(private d: Pool) {}

  async load(accountId: string): Promise<{ overrides: Partial<SellerGuardrailPolicy>; updatedAt: string | null }> {
    const r = await this.d.query<{ policy: Partial<SellerGuardrailPolicy>; updated_at: Date }>(
      "SELECT policy, updated_at FROM settings WHERE account_id = $1", [accountId],
    );
    return {
      overrides: r.rows[0]?.policy ?? {},
      updatedAt: r.rows[0]?.updated_at ? new Date(r.rows[0].updated_at).toISOString() : null,
    };
  }

  async persist(accountId: string, overrides: Partial<SellerGuardrailPolicy>): Promise<void> {
    this.perAccount.delete(accountId);
    await this.d.query(
      `INSERT INTO settings (account_id, policy, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (account_id) DO UPDATE SET policy = EXCLUDED.policy, updated_at = now()`,
      [accountId, JSON.stringify(overrides)],
    );
  }

  /** Re-arm Layer B for this process. The next reply drafted is checked by it. */
  activate(p: SellerGuardrailPolicy): void {
    setPolicy(p);
  }

  /** One seller's merged policy, cached a minute; `persist` invalidates. */
  private perAccount = new Map<string, { p: SellerGuardrailPolicy; at: number }>();
  async forAccount(accountId: string): Promise<SellerGuardrailPolicy> {
    const hit = this.perAccount.get(accountId);
    if (hit && Date.now() - hit.at < 60_000) return hit.p;
    const { overrides } = await this.load(accountId);
    const p = merge(overrides);
    this.perAccount.set(accountId, { p, at: Date.now() });
    return p;
  }
}

/**
 * Push Layer A onto one agent and read back what is armed.
 *
 * Deliberately returns a report rather than throwing: a gateway that refuses
 * the push must not lose the seller's edit, and the honest thing to show is
 * "saved here, NOT armed on the agent — here is why".
 */
export async function pushLayerA(
  base: string, apiKey: string, agentId: string,
): Promise<ArmedReport> {
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  try {
    const patch = await fetch(`${base}/api/agents/${agentId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        content_guardrails: toContentGuardrails(),
        action_policy: toActionPolicy(),
      }),
    });
    if (!patch.ok) {
      return { ok: false, agentId, items: [], error: `${patch.status} ${(await patch.text()).slice(0, 200)}` };
    }

    const read = await fetch(`${base}/api/agents/${agentId}/guardrails`, { headers });
    if (!read.ok) {
      return { ok: true, agentId, items: [], error: `pushed, but read-back failed: ${read.status}` };
    }
    const body = (await read.json()) as {
      groups?: { items?: { label: string; configurable?: boolean; value: unknown }[] }[];
    };
    const items: { label: string; value: unknown }[] = [];
    for (const g of body.groups ?? []) {
      for (const it of g.items ?? []) {
        if (it.configurable && /content|language|approval|pii/i.test(it.label)) {
          items.push({ label: it.label, value: it.value });
        }
      }
    }
    return { ok: true, agentId, items };
  } catch (e) {
    return { ok: false, agentId, items: [], error: (e as Error).message };
  }
}
