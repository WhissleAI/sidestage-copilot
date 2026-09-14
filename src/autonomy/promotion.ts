// Is this seller ready to climb a rung?
//
// `ladder.ts` has always STATED a promotion criterion per rung — edit rate under
// 20% over three shows, block rate under 2%, and so on — in a header comment.
// The PRD says those criteria are "implemented in ladder.ts". They were prose.
// Nothing computed them, so nothing could ever tell a seller they were ready,
// and the ladder's central claim — that autonomy is earned against your own
// numbers rather than toggled — was a claim about a document.
//
// This computes them from `show_reports`, which is where finished shows live.
// Two deliberate properties:
//
//   * It reads FINISHED shows only. A criterion evaluated against a show still
//     running would flip back and forth as the numbers moved, and "you may
//     promote" is not a thing to say and then withdraw.
//   * A criterion with too little evidence is `unknown`, never `met`. The
//     failure that matters here is telling someone they have earned autonomy on
//     the strength of two quiet shows.

import type { Pool } from "../db/pg.js";
import type { AutonomyLevel } from "../domain/types.js";
import type { ShowReport } from "../shows/sessionRecord.js";
import { LADDER, rung } from "./ladder.js";

export interface Criterion {
  /** The rung this unlocks. */
  to: AutonomyLevel;
  label: string;
  /** How many completed shows the criterion needs. */
  showsRequired: number;
  showsSeen: number;
  /** The measured value, and the bar. */
  value: number | null;
  target: string;
  state: "met" | "not_met" | "unknown";
  detail: string;
}

export interface PromotionReadiness {
  current: AutonomyLevel;
  next: AutonomyLevel | null;
  /** Only true when every criterion for the NEXT rung is met. */
  ready: boolean;
  criteria: Criterion[];
}

const r3 = (n: number) => Number(n.toFixed(3));

export async function promotionReadiness(
  d: Pool,
  current: AutonomyLevel,
): Promise<PromotionReadiness> {
  const next = LADDER[rung(current) + 1] ?? null;

  // Newest first, capped: a criterion is about recent behaviour, and dragging
  // in a show from three weeks ago answers a question nobody asked.
  const rows = (
    await d.query<{ report: ShowReport }>(
      "SELECT report FROM show_reports ORDER BY generated_at DESC LIMIT 5",
    )
  ).rows.map((x) => x.report);

  if (!next) {
    return { current, next: null, ready: false, criteria: [] };
  }

  const criteria: Criterion[] = [];
  const take = (n: number) => rows.slice(0, n);

  const build = (
    label: string,
    showsRequired: number,
    target: string,
    compute: (rs: ShowReport[]) => number | null,
    ok: (v: number) => boolean,
    detail: (v: number | null, seen: number) => string,
  ): Criterion => {
    const rs = take(showsRequired);
    const value = rs.length >= showsRequired ? compute(rs) : null;
    return {
      to: next,
      label,
      showsRequired,
      showsSeen: rs.length,
      value,
      target,
      state: value === null ? "unknown" : ok(value) ? "met" : "not_met",
      detail: detail(value, rs.length),
    };
  };

  const sum = (rs: ShowReport[], f: (r: ShowReport) => number) => rs.reduce((a, r) => a + f(r), 0);

  if (next === "L1_SUGGEST") {
    criteria.push(
      build(
        "The show actually asks questions",
        1,
        "≥ 10 admitted questions in a show",
        (rs) => sum(rs, (r) => r.engagement.questionsAsked),
        (v) => v >= 10,
        (v, n) =>
          v === null
            ? "no finished show yet — run one at L0 to see what the room asks"
            : `${v} questions across ${n} show${n === 1 ? "" : "s"}`,
      ),
    );
  }

  if (next === "L2_ONE_TAP") {
    criteria.push(
      build(
        "Seller edit rate on sent drafts",
        3,
        "< 20%",
        // Pooled, not averaged: a show with two replies must not carry the same
        // weight as a show with two hundred.
        (rs) => {
          const sent = sum(rs, (r) => r.engagement.sent);
          return sent ? r3(sum(rs, (r) => (r.prd?.trust.editRate ?? 0) * r.engagement.sent) / sent) : null;
        },
        (v) => v < 0.2,
        (v, n) => (v === null ? `need 3 finished shows, have ${n}` : `${Math.round(v * 100)}% of sent drafts were edited`),
      ),
    );
  }

  if (next === "L3_AUTO_REPLY") {
    criteria.push(
      build(
        "Guardrail block rate",
        3,
        "< 2%",
        (rs) => {
          const props = sum(rs, (r) => r.engagement.answered + r.safety.blocked);
          return props ? r3(sum(rs, (r) => r.safety.blocked) / props) : null;
        },
        (v) => v < 0.02,
        (v, n) =>
          v === null
            ? `need 3 finished shows, have ${n}`
            : `${Math.round(v * 1000) / 10}% of drafts were blocked — a high rate means the grounding is bad, not that the guards are good`,
      ),
      build(
        "Audit chain intact every show",
        3,
        "no broken chain",
        (rs) => (rs.every((r) => r.safety.auditChain.ok) ? 1 : 0),
        (v) => v === 1,
        (v, n) => (v === null ? `need 3 finished shows, have ${n}` : v === 1 ? "verified across every show" : "a chain broke — investigate before automating"),
      ),
    );
  }

  if (next === "L4_AUTO_ACT") {
    criteria.push(
      build(
        "Actions rolled back",
        5,
        "< 10% of commits",
        (rs) => {
          const c = sum(rs, (r) => r.actions.committed);
          return c ? r3(sum(rs, (r) => r.actions.rolledBack) / c) : null;
        },
        (v) => v < 0.1,
        (v, n) =>
          v === null
            ? `need 5 finished shows with committed actions, have ${n}`
            : `${Math.round(v * 100)}% of committed actions were rolled back — a high rate means preflight is too permissive`,
      ),
    );
  }

  return {
    current,
    next,
    // `unknown` is not `met`. Telling a seller they have earned autonomy on the
    // strength of two quiet shows is the failure this whole file exists to avoid.
    ready: criteria.length > 0 && criteria.every((c) => c.state === "met"),
    criteria,
  };
}
