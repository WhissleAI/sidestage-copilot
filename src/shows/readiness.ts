// Is this catalog's agent actually ready to answer for a show?
//
// The copilot's whole claim is that replies are grounded, and the grounding
// lives in two places that can silently disagree: this process (retrieval over
// the catalog) and the Whissle agent (its knowledge base and its armed
// guardrails). A session that starts with half of that missing does not fail —
// it abstains, politely, on every question, which looks like the model being
// cautious rather than the corpus being absent.
//
// So this asks the gateway what it ACTUALLY holds and compares it with what the
// catalog says it should. Read-back, never assumption: `seed:agent` has always
// done this for guardrails, and the same reasoning applies to everything else
// a session depends on.

import { config } from "../config.js";
import type { Catalog } from "./catalogs.js";

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** A blocker stops a session being useful; a warning costs quality. */
  severity: "blocker" | "warning" | "info";
}

export interface Readiness {
  catalogId: string;
  agentId: string | null;
  ok: boolean;
  checks: ReadinessCheck[];
}

async function api<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${config.whissle.base}${path}`, {
      headers: { Authorization: `Bearer ${config.whissle.apiKey}` },
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function checkReadiness(catalog: Catalog): Promise<Readiness> {
  const checks: ReadinessCheck[] = [];
  const agentId = catalog.agentId ?? null;

  // ── what this process will ground against ────────────────────────────────
  checks.push({
    name: "Catalog items",
    ok: catalog.items.length > 0,
    detail: `${catalog.items.length} items — every price, size and condition the copilot can cite`,
    severity: "blocker",
  });
  checks.push({
    name: "Policy clauses",
    ok: catalog.policies.length > 0,
    detail: catalog.policies.length
      ? `${catalog.policies.length} clauses — shipping, returns, authenticity, discount floor`
      : "none — every shipping or returns question will abstain",
    severity: "blocker",
  });
  checks.push({
    name: "Market comps",
    ok: (catalog.comps?.length ?? 0) > 0,
    detail: catalog.comps?.length
      ? `${catalog.comps.length} recent comparable sales`
      : "none — \"is that a good price?\" has nothing to answer from, so product research will abstain",
    severity: "warning",
  });

  if (!agentId) {
    checks.push({
      name: "Whissle agent",
      ok: false,
      detail: "this catalog has no agent — run `npm run seed:agent`",
      severity: "blocker",
    });
    return { catalogId: catalog.id, agentId, ok: false, checks };
  }

  // ── what the gateway actually holds ──────────────────────────────────────
  const kb = await api<unknown>(`/api/agents/${agentId}/kb`);
  // `{items: [...]}` is the shape the gateway actually returns; the other two
  // are tolerated because this is the kind of thing that changes quietly.
  const kbBody = kb as { items?: unknown[]; documents?: unknown[] } | unknown[];
  const docs = (Array.isArray(kbBody)
    ? kbBody
    : kbBody?.items ?? kbBody?.documents ?? []) as { title?: string; file_name?: string }[];
  const names = docs.map((d) => d.title || d.file_name || "");
  const has = (frag: string) => names.some((n) => n.includes(frag));

  checks.push({
    name: "Inventory in the agent's KB",
    ok: has(`${catalog.id}-inventory`),
    detail: has(`${catalog.id}-inventory`)
      ? "the agent can search this catalog itself, not only through our retrieval"
      : "missing — the agent will answer only from the per-turn facts we inject",
    severity: "warning",
  });
  checks.push({
    name: "Policies in the agent's KB",
    ok: has(`${catalog.id}-policies`),
    detail: has(`${catalog.id}-policies`) ? "present" : "missing",
    severity: "warning",
  });

  // Stale show corpora from OTHER shows are worse than a missing one: the agent
  // retrieves a lot that sold two days ago and answers about it confidently.
  const showDocs = names.filter((n) => n.startsWith("sidestage-show-"));
  checks.push({
    name: "No stale show corpora",
    ok: showDocs.length <= 1,
    detail: showDocs.length <= 1
      ? "clean"
      : `${showDocs.length} show documents on this agent — it can retrieve lots from shows that already ended`,
    severity: "warning",
  });

  // ── what is armed, read back rather than assumed ─────────────────────────
  const gr = await api<{ groups?: { items?: { label: string; value: unknown; configurable?: boolean }[] }[] }>(
    `/api/agents/${agentId}/guardrails`,
  );
  const items = (gr?.groups ?? []).flatMap((g) => g.items ?? []);
  const content = items.find((i) => /content guardrail/i.test(i.label));
  const neverSay = Number((content?.value as { never_say_count?: unknown })?.never_say_count ?? 0);
  checks.push({
    name: "Layer A armed on the agent",
    ok: neverSay > 0,
    detail: neverSay > 0
      ? `${neverSay} never-say rules live on the agent — they fire on voice and embed too, where this app is not in the loop`
      : "no content guardrails armed — Layer A is not protecting anything",
    severity: "blocker",
  });

  return {
    catalogId: catalog.id,
    agentId,
    ok: checks.every((c) => c.ok || c.severity !== "blocker"),
    checks,
  };
}
