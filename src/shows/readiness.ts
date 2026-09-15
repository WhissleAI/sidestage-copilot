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
import { aspectGaps, type AspectGap } from "./catalogAspects.js";
import { ebay } from "../ingest/ebay/client.js";

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
  /** What eBay says a listing in this category should carry, and what this
   *  catalog does. Null when eBay could not be asked — which the check reports
   *  as "not checked", never as "nothing missing". */
  aspects?: AspectGap | null;
  /**
   * What the last show on this catalog could not answer.
   *
   * The report ends with the questions the catalog could not ground; setup is
   * the last moment a seller can still fix them before the next show asks the
   * same things. Null when no earlier show on this catalog left a report.
   */
  carried?: {
    fromShowId: string;
    title: string;
    endedAt: string;
    gaps: { question: string; asked: number; reason: string }[];
  } | null;
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

/**
 * Does this catalog have anything to do with what the show is selling?
 *
 * The failure it catches is silent and expensive. Point a baseball-card catalog
 * at a fragrance auction and nothing errors — retrieval simply grounds nothing,
 * every answer abstains, and the queue fills with "the host will cover that
 * shortly" while the operator wonders why the copilot has stopped working. The
 * catalog is not broken and the copilot is not broken; they are about different
 * things, and only a human can see that.
 *
 * Vocabulary overlap, deliberately crude: exact word matching between catalog
 * titles and observed lot titles. It does not need to be clever to separate
 * "cards vs cards" from "cards vs cologne", and anything cleverer would invite
 * trust it has not earned.
 */
export function catalogFit(
  catalogTitles: string[],
  observedTitles: string[],
): { overlap: number; sampled: number; verdict: "match" | "weak" | "mismatch" } {
  const words = (xs: string[]) =>
    new Set(
      xs
        .join(" ")
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOP.has(w)),
    );
  const cat = words(catalogTitles);
  const obs = words(observedTitles);
  if (!obs.size || !cat.size) return { overlap: 0, sampled: observedTitles.length, verdict: "weak" };
  let hit = 0;
  for (const w of obs) if (cat.has(w)) hit++;
  const overlap = hit / obs.size;
  return {
    overlap: Number(overlap.toFixed(3)),
    sampled: observedTitles.length,
    verdict: overlap >= 0.15 ? "match" : overlap > 0.04 ? "weak" : "mismatch",
  };
}

/** Words every live-selling title carries, which would otherwise manufacture
 *  overlap between two catalogs that have nothing in common. */
const STOP = new Set([
  "item", "items", "live", "ebay", "show", "shown", "screen", "lot", "part",
  "starts", "start", "sold", "used", "with", "from", "this", "that", "your",
  "auction", "bid", "bids", "free", "ship", "shipping", "sale",
]);

export async function checkReadiness(
  catalog: Catalog,
  opts: { agentId?: string | null } = {},
): Promise<Readiness> {
  const checks: ReadinessCheck[] = [];
  // The SHOW's agent when there is one. A prepared show carries its agent in
  // `prepared_shows` and a running show in `shows.agent_id`; the catalog file
  // knows neither, and reading only the file told the operator "this catalog
  // has no agent — run seed:agent" about a show that was answering from its
  // own agent at that moment.
  const agentId = opts.agentId ?? catalog.agentId ?? null;

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
  // Comparables come from eBay now — completed sales where they exist, active
  // asking prices otherwise — fetched in the background per lot. The seeded
  // comps in a catalog file are the fallback for a machine with no eBay
  // application, which is the only case where their absence is a warning.
  checks.push({
    name: "Market comps",
    ok: ebay.configured || (catalog.comps?.length ?? 0) > 0,
    detail: ebay.configured
      ? `live from eBay — sold prices where a lot has any, asking prices otherwise${catalog.comps?.length ? `, plus ${catalog.comps.length} seeded sales` : ""}`
      : catalog.comps?.length
        ? `${catalog.comps.length} seeded comparable sales — no eBay application, so nothing live`
        : "none — no eBay application and no seeded sales, so \"is that a good price?\" will abstain",
    severity: "warning",
  });

  // ── what eBay expects a listing here to carry ────────────────────────────
  //
  // Two calls, and the whole check degrades to "not checked" rather than to a
  // clean bill of health, because those look identical to a seller skimming and
  // are opposite facts.
  const gaps = await aspectGaps(catalog.items).catch(() => null);
  checks.push(
    gaps
      ? {
          name: "Listing aspects eBay expects",
          ok: gaps.missing.length === 0,
          detail: gaps.missing.length
            ? `${gaps.categoryName}: no item carries ${gaps.missing.join(", ")} — buyers filter on these, and the copilot cannot cite a field the catalog does not have`
            : `${gaps.categoryName}: all ${gaps.required.length} required aspects are covered${gaps.worst.length ? `, though ${gaps.worst.length} items are missing one` : ""}`,
          severity: "warning",
        }
      : {
          name: "Listing aspects eBay expects",
          ok: true,
          // Two different reasons, and the difference is whether there is
          // anything the seller can do about it.
          detail: ebay.configured
            ? "not checked — no item carried enough brand or model detail to resolve an eBay category"
            : "not checked — no eBay application configured",
          severity: "info",
        },
  );

  if (!agentId) {
    checks.push({
      name: "Whissle agent",
      ok: false,
      // Product language. A seller does not run npm scripts; attaching a show
      // or preparing one creates the agent, and that is the instruction.
      detail: "no agent yet — one is created when you monitor or prepare a show",
      severity: "blocker",
    });
    return { catalogId: catalog.id, agentId, ok: false, checks, aspects: gaps };
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
  //
  // Monitored shows now get their OWN agent, so this can only be non-empty on a
  // catalog agent that ran sessions before that change — but it stays, because
  // the failure it catches is silent and the check costs one request.
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
    aspects: gaps,
  };
}
