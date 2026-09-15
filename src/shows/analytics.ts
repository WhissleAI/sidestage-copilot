// Analytics across shows — the view that exists whether or not anything is on
// air.
//
// The analytics screen used to read one live runtime: its pipeline counters,
// its audit chain, its action list. With no show running it had nothing to
// read and said so — "no show is being monitored" — which is the wrong answer
// to "how is the copilot doing", a question whose answer is mostly in the
// shows that already happened.
//
// This aggregates the reports those shows left behind. Every number here is a
// sum or a rate over persisted reports, so it survives restarts and it is the
// same number tomorrow. Where a per-show statistic cannot honestly be summed
// (a median of medians is not a median), it is labelled as what it is.
//
// The live show, when there is one, is a separate object on the same response:
// its numbers move by the second and belong beside the history, not blended in.

import type { Pool } from "../db/pg.js";
import type { ShowReport } from "./sessionRecord.js";
import { AUTO_REPLY_INTENTS } from "../autonomy/ladder.js";

export interface AnalyticsOverview {
  window: { days: number; from: string; to: string };
  shows: {
    finished: number;
    /** Sessions that ended without a report — the ones to look at first. */
    withoutReport: number;
    hoursOnAir: number;
  };
  engagement: {
    commentsSeen: number;
    questionsAsked: number;
    answered: number;
    sent: number;
    /** answered ÷ questions asked, across the window. */
    answeredRate: number;
    /** Median of each show's median — a shape, not a median. */
    medianOfMediansMs: number;
    /** The worst p95 any show recorded. One bad show should not hide. */
    worstP95Ms: number;
    cacheHitRate: number;
  };
  safety: {
    blocked: number;
    revised: number;
    abstained: number;
    /** What the operator marked wrong after sending. A floor, not a total. */
    flaggedWrong: number;
    byGuard: Record<string, number>;
    /** blocked ÷ (answered + blocked): how often a guard had to stop a draft. */
    blockRate: number;
    /** Shows whose audit chain verified intact, over shows with a report. */
    chainsIntact: number;
  };
  actions: { proposed: number; committed: number; rolledBack: number; failed: number };
  gmv: {
    /** Sum of hammer value across shows that carried PRD metrics. */
    grossCents: number;
    lotsSold: number;
    /** Shows old enough to predate PRD metrics carry no GMV; said, not zeroed. */
    showsWithGmv: number;
  };
  operator: {
    /** Median of each show's median decision time, where recorded. */
    medianDecisionMs: number | null;
    editRate: number | null;
  };
  /**
   * Where it is strong and where it is not, by topic.
   *
   * The table that decides what belongs on the auto-reply allow-list. Today
   * that list is a constant in the ladder; this is the evidence it should be
   * argued from. Rates are over proposals, because a proposal is where a
   * question meets the copilot — a comment the gate dropped never got a topic.
   */
  byIntent: {
    intent: string;
    asked: number;
    answeredRate: number;
    abstainedRate: number;
    blocked: number;
    editedRate: number;
    /** Whether the ladder would let this topic auto-send at L3. */
    autoReply: "allow-listed" | "never";
  }[];
  perShow: {
    showId: string;
    title: string;
    startedAt: string;
    durationMin: number;
    answeredRate: number;
    p95LatencyMs: number;
    blocked: number;
    flaggedWrong: number;
    gmvCents: number | null;
    chainOk: boolean;
  }[];
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export async function analyticsOverview(d: Pool, days: number, ownerId: string | null = null): Promise<AnalyticsOverview> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  const { rows } = await d.query<{
    id: string; title: string; started_at: string; status: string; report: ShowReport | null;
  }>(
    `SELECT s.id, s.title, s.started_at, s.status, r.report
       FROM shows s LEFT JOIN show_reports r ON r.show_id = s.id
      WHERE s.started_at::timestamptz >= $1 AND s.status = 'ended'
        AND (s.owner_account_id IS NULL OR $2::text IS NULL OR s.owner_account_id = $2)
      ORDER BY s.started_at DESC`,
    [from.toISOString(), ownerId],
  );

  const reported = rows.filter((r): r is typeof r & { report: ShowReport } => r.report != null);

  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + (f(x) || 0), 0);
  const byGuard: Record<string, number> = {};
  for (const r of reported) {
    for (const [g, n] of Object.entries(r.report.safety.byGuard ?? {})) {
      byGuard[g] = (byGuard[g] ?? 0) + n;
    }
  }

  const intents = await d.query<{
    intent: string | null; asked: number; answered: number; abstained: number; blocked: number;
    edited: number; sent: number;
  }>(
    `SELECT p.intent,
            count(*)::int AS asked,
            count(*) FILTER (WHERE NOT p.abstained AND p.verdict <> 'block')::int AS answered,
            count(*) FILTER (WHERE p.abstained)::int AS abstained,
            count(*) FILTER (WHERE p.verdict = 'block')::int AS blocked,
            count(*) FILTER (WHERE p.edited)::int AS edited,
            count(*) FILTER (WHERE p.status IN ('sent','auto_sent'))::int AS sent
       FROM reply_proposals p JOIN shows s ON s.id = p.show_id
      WHERE s.started_at::timestamptz >= $1 AND s.status = 'ended'
        AND (s.owner_account_id IS NULL OR $2::text IS NULL OR s.owner_account_id = $2)
      GROUP BY p.intent ORDER BY asked DESC`,
    [from.toISOString(), ownerId],
  );
  const byIntent: AnalyticsOverview["byIntent"] = intents.rows.map((r) => {
    const intent = r.intent ?? "other";
    return {
      intent,
      asked: r.asked,
      answeredRate: r.asked ? r.answered / r.asked : 0,
      abstainedRate: r.asked ? r.abstained / r.asked : 0,
      blocked: r.blocked,
      editedRate: r.sent ? r.edited / r.sent : 0,
      autoReply: (AUTO_REPLY_INTENTS as Set<string>).has(intent) ? "allow-listed" : "never",
    };
  });

  const questions = sum(reported, (r) => r.report.engagement.questionsAsked);
  const answered = sum(reported, (r) => r.report.engagement.answered);
  const blocked = sum(reported, (r) => r.report.safety.blocked);
  const withGmv = reported.filter((r) => r.report.prd?.gmv);
  const decision = reported
    .map((r) => r.report.prd?.operatorLoad?.medianDecisionMs)
    .filter((x): x is number => typeof x === "number");
  const edits = reported
    .map((r) => r.report.prd?.trust?.editRate)
    .filter((x): x is number => typeof x === "number");

  return {
    window: { days, from: from.toISOString(), to: to.toISOString() },
    shows: {
      finished: rows.length,
      withoutReport: rows.length - reported.length,
      hoursOnAir: Math.round((sum(reported, (r) => r.report.durationMin) / 60) * 10) / 10,
    },
    engagement: {
      commentsSeen: sum(reported, (r) => r.report.engagement.commentsSeen),
      questionsAsked: questions,
      answered,
      sent: sum(reported, (r) => r.report.engagement.sent),
      answeredRate: questions ? answered / questions : 0,
      // A show that drafted nothing has no median, not a median of zero; four
      // such shows next to one real one used to read as "0ms" here.
      medianOfMediansMs: median(
        reported.map((r) => r.report.engagement.medianLatencyMs).filter((ms) => ms > 0),
      ),
      worstP95Ms: Math.max(0, ...reported.map((r) => r.report.engagement.p95LatencyMs)),
      cacheHitRate: reported.length
        ? sum(reported, (r) => r.report.engagement.cacheHitRate) / reported.length
        : 0,
    },
    safety: {
      blocked,
      revised: sum(reported, (r) => r.report.safety.revised),
      abstained: sum(reported, (r) => r.report.safety.abstained),
      flaggedWrong: sum(reported, (r) => r.report.safety.flaggedWrong ?? 0),
      byGuard,
      blockRate: answered + blocked ? blocked / (answered + blocked) : 0,
      chainsIntact: reported.filter((r) => (r.report.safety?.auditChain?.ok ?? false)).length,
    },
    actions: {
      proposed: sum(reported, (r) => (r.report.actions?.proposed ?? 0)),
      committed: sum(reported, (r) => (r.report.actions?.committed ?? 0)),
      rolledBack: sum(reported, (r) => (r.report.actions?.rolledBack ?? 0)),
      failed: sum(reported, (r) => (r.report.actions?.failed ?? 0)),
    },
    gmv: {
      grossCents: sum(withGmv, (r) => r.report.prd!.gmv.grossCents),
      lotsSold: sum(withGmv, (r) => r.report.prd!.gmv.lotsSold),
      showsWithGmv: withGmv.length,
    },
    operator: {
      medianDecisionMs: decision.length ? median(decision) : null,
      editRate: edits.length ? edits.reduce((a, b) => a + b, 0) / edits.length : null,
    },
    byIntent,
    perShow: rows.map((r) => ({
      showId: r.id,
      title: r.title,
      startedAt: r.started_at,
      durationMin: r.report?.durationMin ?? 0,
      answeredRate: r.report?.engagement.answeredRate ?? 0,
      p95LatencyMs: r.report?.engagement.p95LatencyMs ?? 0,
      blocked: r.report?.safety.blocked ?? 0,
      flaggedWrong: r.report?.safety.flaggedWrong ?? 0,
      gmvCents: r.report?.prd?.gmv.grossCents ?? null,
      chainOk: r.report?.safety.auditChain.ok ?? false,
    })),
  };
}
