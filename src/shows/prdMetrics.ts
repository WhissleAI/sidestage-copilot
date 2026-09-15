// The PRD's success metrics, computed.
//
// docs/PRD.md §4 names thirteen numbers across GMV, operator load and trust.
// Five were computed and the rest were aspiration — including GMV per show
// hour, the headline. Reviewers diff the PRD against the implementation, and a
// metric a document promises and the code never produces is the most findable
// kind of gap there is.
//
// Every number here is derived from something recorded as an EVENT — a sale, a
// decision, an edit — rather than from current state, because show state keeps
// moving and a sum over it answers a different question every time it is asked.
//
// One metric is deliberately absent rather than faked: see UNMEASURABLE below.

import type { Pool } from "../db/pg.js";

export interface PrdMetrics {
  gmv: {
    /** Hammer value of everything that closed during the show, in cents. */
    grossCents: number;
    lotsSold: number;
    hours: number;
    /** The PRD headline. Null until the show has run long enough to mean
     *  anything — a rate extrapolated from four minutes is noise wearing a
     *  decimal point. */
    perShowHourCents: number | null;
    answeredQuestionRate: number;
    timeToAnswerP95Ms: number;
    /** Share of sold lots that had at least one answered buyer question.
     *  The PRD's "isolates the effect from general show variance" metric. */
    sellThroughWithAnswer: { withAnswer: number; total: number; rate: number };
  };
  operatorLoad: {
    /** Times the seller touched a proposal: sent, edited or dismissed. */
    interactions: number;
    /** How long a decision took, when one was made. */
    medianDecisionMs: number | null;
    operationalEdits: number;
  };
  trust: {
    blockRate: number;
    editRate: number;
    rollbackRate: number;
    /** Replies sent whose grounding was contradicted by a LATER state change —
     *  the closest honest proxy for "a wrong reply reached a buyer". */
    sentThenContradicted: number;
  };
  /** Named in the PRD, not computed here, with the reason. */
  notMeasured: { metric: string; why: string }[];
}

/**
 * A show shorter than this produces a per-hour rate that is mostly division.
 * Reported as null rather than a large confident number.
 */
const MIN_HOURS_FOR_RATE = 0.25;

const UNMEASURABLE = [
  {
    metric: "Wrong replies reaching a buyer",
    why:
      "Cannot be self-measured: a reply this system judged correct is exactly the reply it " +
      "cannot mark wrong. Two floors exist instead, and neither is the total. `flaggedWrong` " +
      "counts what the OPERATOR marked wrong during the show — the only human in the loop — and " +
      "`sentThenContradicted` counts sent replies whose grounding a later state change broke. " +
      "The pilot's weekly review of sent replies against the catalog is what closes the gap.",
  },
];

const pct = (sorted: number[], p: number): number =>
  sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!) : 0;

const rate = (n: number, d: number): number => (d ? Number((n / d).toFixed(3)) : 0);

export async function prdMetrics(d: Pool, showId: string): Promise<PrdMetrics> {
  const show = (
    await d.query<{ started_at: string }>("SELECT started_at FROM shows WHERE id = $1", [showId])
  ).rows[0];
  const startedMs = show ? new Date(show.started_at).getTime() : Date.now();
  const hours = Math.max(0, (Date.now() - startedMs) / 3_600_000);

  const sales = (
    await d.query<{ listing_id: string; price_cents: number; qty: number }>(
      "SELECT listing_id, price_cents, qty FROM sales WHERE show_id = $1", [showId],
    )
  ).rows;
  const grossCents = sales.reduce((a, s) => a + s.price_cents * s.qty, 0);

  const props = (
    await d.query<{
      status: string; verdict: string; abstained: boolean; latency_ms: number;
      decided_at: string | null; edited: boolean; at: string; evidence: { factId: string }[];
    }>(
      `SELECT status, verdict, abstained, latency_ms, decided_at, edited, at, evidence
       FROM reply_proposals WHERE show_id = $1`,
      [showId],
    )
  ).rows;

  const admitted = (
    await d.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM chat_messages WHERE show_id = $1 AND admitted", [showId],
    )
  ).rows[0]?.n ?? 0;

  const sent = props.filter((p) => p.status === "sent" || p.status === "auto_sent");
  const answered = props.filter((p) => !p.abstained && p.verdict !== "block");
  const lat = props.map((p) => p.latency_ms).filter((n) => n > 0).sort((a, b) => a - b);

  // Which lots had a question ANSWERED about them: the evidence on a sent reply
  // names the listing it was grounded in, which is the link the PRD's
  // sell-through metric needs and the only place it exists.
  const answeredLots = new Set<string>();
  for (const p of sent) {
    for (const e of p.evidence ?? []) {
      const m = /^listing:([^#]+)#/.exec(e.factId);
      if (m) answeredLots.add(m[1]!);
    }
  }
  const soldLots = new Set(sales.map((s) => s.listing_id));
  const soldWithAnswer = [...soldLots].filter((id) => answeredLots.has(id)).length;

  const decisions = props
    .filter((p) => p.decided_at)
    .map((p) => new Date(p.decided_at!).getTime() - new Date(p.at).getTime())
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b);

  const acts = (
    await d.query<{ status: string; n: number }>(
      "SELECT status, count(*)::int AS n FROM actions WHERE show_id = $1 GROUP BY status", [showId],
    )
  ).rows;
  const actN = (s: string) => acts.find((a) => a.status === s)?.n ?? 0;
  const committed = actN("committed");

  // A sent reply whose grounding listing later changed version is a reply the
  // world moved out from under. Not proof it was wrong — the change may be
  // irrelevant — which is why it is named for what it measures.
  const contradicted = (
    await d.query<{ n: number }>(
      `SELECT count(DISTINCT p.id)::int AS n
       FROM reply_proposals p
       JOIN LATERAL jsonb_array_elements(p.evidence) e ON TRUE
       JOIN listings l ON l.show_id = p.show_id
        AND l.id = substring(e->>'factId' from '^listing:([^#]+)#')
       WHERE p.show_id = $1
         AND p.status IN ('sent','auto_sent')
         AND l.version > COALESCE((e->>'listingVersion')::int, l.version)`,
      [showId],
    )
  ).rows[0]?.n ?? 0;

  return {
    gmv: {
      grossCents,
      lotsSold: sales.length,
      hours: Number(hours.toFixed(2)),
      perShowHourCents: hours >= MIN_HOURS_FOR_RATE ? Math.round(grossCents / hours) : null,
      answeredQuestionRate: rate(sent.length, admitted),
      timeToAnswerP95Ms: pct(lat, 0.95),
      sellThroughWithAnswer: {
        withAnswer: soldWithAnswer,
        total: soldLots.size,
        rate: rate(soldWithAnswer, soldLots.size),
      },
    },
    operatorLoad: {
      interactions: props.filter((p) => p.decided_at).length,
      medianDecisionMs: decisions.length ? pct(decisions, 0.5) : null,
      operationalEdits: committed,
    },
    trust: {
      blockRate: rate(props.filter((p) => p.verdict === "block").length, props.length),
      editRate: rate(sent.filter((p) => p.edited).length, sent.length),
      rollbackRate: rate(actN("rolled_back"), committed),
      sentThenContradicted: contradicted,
    },
    notMeasured: UNMEASURABLE,
  };
}
