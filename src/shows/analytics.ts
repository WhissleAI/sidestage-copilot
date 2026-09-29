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
import { answerableShare, answeredRate, blockRate, share } from "./metrics.js";
import { capabilitiesOf } from "../surfaces/types.js";

export interface AnalyticsOverview {
  window: { days: number; from: string; to: string };
  shows: {
    finished: number;
    /** Sessions that ended without a report — the ones to look at first. */
    withoutReport: number;
    hoursAttached: number;
    /** Of those, how many ran where we cannot post — so "sent" is the
     *  seller's own mark, not a delivery. See the note where it is counted. */
    draftOnly: number;
  };
  engagement: {
    commentsSeen: number;
    questionsAsked: number;
    answered: number;
    sent: number;
    /**
     * Sent ÷ questions asked, across the window — the SAME figure, from the
     * same function, that each session's own report carries. It used to be
     * `answered ÷ questions` here and `sent ÷ questions` in the report, so this
     * headline and the per-show row for one session disagreed on the same page.
     * Pooled over summed counts, never averaged over per-session rates.
     */
    answeredRate: number | null;
    /** Answered over asked — the copilot's own share, before the seller
     *  decides. See the note where it is computed. */
    groundedRate: number | null;
    /** Median of each show's median — a shape, not a median. */
    medianOfMediansMs: number;
    /** The worst p95 any show recorded. One bad show should not hide. */
    /** Null when nothing in the window answered — not 0, which reads as the
     *  fastest possible reply and used to award a met target. */
    worstP95Ms: number | null;
    /** Null on an empty window, for the same reason. */
    cacheHitRate: number | null;
  };
  safety: {
    blocked: number;
    revised: number;
    abstained: number;
    /** What the operator marked wrong after sending. A floor, not a total. */
    flaggedWrong: number;
    byGuard: Record<string, number>;
    /** Blocked ÷ drafts that reached a verdict (src/shows/metrics.ts) — the
     *  definition each report's PRD block now uses too. */
    blockRate: number | null;
    /** Shows whose audit chain verified intact, over shows with a report. */
    chainsIntact: number;
    /** Of the finished sessions, how many had an empty chain — nothing to
     *  verify. Not a failure, and not evidence. */
    chainsEmpty: number;
  };
  actions: { proposed: number; committed: number; rolledBack: number; failed: number };
  gmv: {
    /** Sum of hammer value across shows that carried PRD metrics. */
    grossCents: number;
    lotsSold: number;
    /** Shows old enough to predate PRD metrics carry no GMV; said, not zeroed. */
    showsWithGmv: number;
    /** Hours of the shows that produced it — the matched denominator. */
    hours: number;
    /** Shows that took money. `showsWithGmv` also counts shows whose gmv is
     *  zero, so it is a reporting count, never a rate's basis. */
    showsThatSold: number;
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
    /** A different figure from the headline, deliberately: the share of
     *  proposals on this topic the copilot could stand behind. */
    answeredRate: number | null;
    abstainedRate: number | null;
    blocked: number;
    editedRate: number | null;
    /** Whether the ladder would let this topic auto-send at L3. */
    autoReply: "allow-listed" | "never";
  }[];
  perShow: {
    showId: string;
    title: string;
    startedAt: string;
    durationMin: number;
    answeredRate: number | null;
    /** Null when the session answered nothing — see ShowReport.engagement. */
    p95LatencyMs: number | null;
    blocked: number;
    flaggedWrong: number;
    gmvCents: number | null;
    chainOk: boolean;
    /** Whether this row has a report at all. Inferred from a rounded duration
     *  before this existed, so a real report for a 20-second session was
     *  labelled "no report" beside its own numbers. */
    hasReport: boolean;
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
    id: string; title: string; started_at: string; status: string; source: string | null; report: ShowReport | null;
  }>(
    `SELECT s.id, s.title, s.started_at, s.status, s.source, r.report
       FROM shows s LEFT JOIN show_reports r ON r.show_id = s.id
      WHERE COALESCE(r.generated_at, s.started_at::timestamptz) >= $1 AND s.status = 'ended'
        -- An UNOWNED show is nobody's, and an aggregate is not a list.
        --
        -- Every other place this clause appears is a LIST of past shows, where
        -- including rows written before ownership existed is the documented
        -- concession (migration 024): they are probably this seller's own
        -- history, and hiding them would lose it. That argument does not survive
        -- being AGGREGATED, because the same ownerless rows are then folded into
        -- EVERY account's figures at once.
        --
        -- Measured on production, 2026-09-28: five ended shows are ownerless.
        -- One seller owns 14 and saw 18 shows-with-GMV; the other owns TWO and
        -- saw SIX, reporting $435.74 of gross and 11 lots sold that it did not
        -- earn. 18 + 6 > 20 total, because the ownerless rows were counted into
        -- both. A seller's dashboard was attributing another seller's revenue to
        -- them.
        --
        -- A null $2 still means unscoped — the box-wide view, used where no
        -- account is asking. A seller who asks gets their own shows and nothing
        -- else, which may under-count a genuine pre-ownership session. That is
        -- the right way round: losing your own history from a chart is a smaller
        -- wrong than being shown revenue you did not make.
        AND ($2::text IS NULL OR s.owner_account_id = $2)
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
        -- An UNOWNED show is nobody's, and an aggregate is not a list.
        --
        -- Every other place this clause appears is a LIST of past shows, where
        -- including rows written before ownership existed is the documented
        -- concession (migration 024): they are probably this seller's own
        -- history, and hiding them would lose it. That argument does not survive
        -- being AGGREGATED, because the same ownerless rows are then folded into
        -- EVERY account's figures at once.
        --
        -- Measured on production, 2026-09-28: five ended shows are ownerless.
        -- One seller owns 14 and saw 18 shows-with-GMV; the other owns TWO and
        -- saw SIX, reporting $435.74 of gross and 11 lots sold that it did not
        -- earn. 18 + 6 > 20 total, because the ownerless rows were counted into
        -- both. A seller's dashboard was attributing another seller's revenue to
        -- them.
        --
        -- A null $2 still means unscoped — the box-wide view, used where no
        -- account is asking. A seller who asks gets their own shows and nothing
        -- else, which may under-count a genuine pre-ownership session. That is
        -- the right way round: losing your own history from a chart is a smaller
        -- wrong than being shown revenue you did not make.
        AND ($2::text IS NULL OR s.owner_account_id = $2)
      GROUP BY p.intent ORDER BY asked DESC`,
    [from.toISOString(), ownerId],
  );
  const byIntent: AnalyticsOverview["byIntent"] = intents.rows.map((r) => {
    const intent = r.intent ?? "other";
    return {
      intent,
      asked: r.asked,
      answeredRate: answerableShare({ answered: r.answered, proposals: r.asked }),
      abstainedRate: share(r.abstained, r.asked),
      blocked: r.blocked,
      editedRate: share(r.edited, r.sent),
      autoReply: (AUTO_REPLY_INTENTS as Set<string>).has(intent) ? "allow-listed" : "never",
    };
  });

  const questions = sum(reported, (r) => r.report.engagement.questionsAsked);
  const answered = sum(reported, (r) => r.report.engagement.answered);
  const sent = sum(reported, (r) => r.report.engagement.sent);
  const blocked = sum(reported, (r) => r.report.safety.blocked);
  const withGmv = reported.filter((r) => r.report.prd?.gmv);
  /**
   * Shows that actually took money, which is NOT `withGmv`.
   *
   * `withGmv` asks whether a report carries a gmv block at all; a session that
   * sold nothing carries one full of zeroes and passes. Using it as a per-hour
   * denominator put the two rooms that were attached overnight and sold
   * nothing straight back in, and the rate did not move: 44.18h of 44.2h,
   * still $205 an hour.
   *
   * A show contributing nothing to the numerator must contribute nothing to
   * the denominator. That is the whole rule.
   */
  const sold = withGmv.filter((r) => (r.report.prd!.gmv.grossCents ?? 0) > 0);
  const decision = reported
    .map((r) => r.report.prd?.operatorLoad?.medianDecisionMs)
    .filter((x): x is number => typeof x === "number");
  const edits = reported
    .map((r) => r.report.prd?.trust?.editRate)
    .filter((x): x is number => typeof x === "number");

  // Every dereference into a stored report is fully optional-chained below.
  //
  // `show_reports.report` is JSONB written by code that changes — the engagement
  // block gained nullable rates earlier today — so a row written under an older
  // shape is a row that exists. `r.report?.safety.auditChain.ok` guards only the
  // report being absent: once `safety` is present and `auditChain` is not, it is a
  // TypeError, and this function serves EVERY seller's dashboard, so one old row
  // would 500 the whole page for everyone. All 20 production reports carry every
  // field today; this is the difference between that being true and it mattering.
  return {
    window: { days, from: from.toISOString(), to: to.toISOString() },
    shows: {
      finished: rows.length,
      withoutReport: rows.length - reported.length,
      /**
       * Time ATTACHED, not airtime.
       *
       * `durationMin` is attach-to-detach, which equals show length for a live
       * event that ends and does not for a room that persists — the Rooms page
       * says it plainly, "a room here is a list, not a running watch". In
       * production a subreddit and a Twitch channel held 21.6 hours each of
       * this, for one gateway call apiece and nobody answered: 98% of the
       * number. Named for what it is, and never a rate's denominator on its
       * own.
       */
      hoursAttached: Math.round((sum(reported, (r) => r.report.durationMin) / 60) * 10) / 10,
      /**
       * Finished shows on a surface this app cannot post to.
       *
       * eBay Live, Whatnot and TikTok Live are all `delivery: "draft-only"` —
       * every live-commerce surface is. Only Twitch and YouTube Live expose a
       * way to post. So on the shows this product exists for, a reply is
       * copied by the seller into the platform's own chat, and "sent" is a box
       * they tick afterwards rather than anything we observed.
       *
       * That is the missing half of the answered rate. Across production the
       * copilot grounded 34 of 45 questions and 3 are marked sent — and the
       * console showed 7% against a >85% target, which on these surfaces is a
       * target for how reliably a seller does bookkeeping mid-show. The number
       * is not wrong; it was being read as something it cannot measure here.
       */
      draftOnly: reported.filter((r) => capabilitiesOf(r.source).delivery === "draft-only").length,
    },
    engagement: {
      commentsSeen: sum(reported, (r) => r.report.engagement.commentsSeen),
      questionsAsked: questions,
      answered,
      sent,
      answeredRate: answeredRate({ sent, questionsAsked: questions }),
      /**
       * What the COPILOT managed, as distinct from what the seller sent.
       *
       * `answeredRate` is sent over asked, and that is right for the PRD's row
       * — "an unanswered question is a buyer who was close", and a draft
       * nobody sent reached no buyer. But the PRD hangs its >85% target on
       * sellers who have reached L3, where the copilot sends for itself.
       *
       * Every show in production has run at L1_SUGGEST. All sixteen. At that
       * level the rate is bounded entirely by whether a human pressed Send, so
       * the console read "7%" against a target of 85% while the copilot had in
       * fact grounded 34 of 45 questions. One number cannot answer both "did
       * the buyer get an answer" and "could we answer them"; this is the
       * second, and `answerableShare` already says so in its own comment.
       */
      groundedRate: answerableShare({ answered, proposals: questions }),
      // A show that drafted nothing has no median, not a median of zero; four
      // such shows next to one real one used to read as "0ms" here.
      medianOfMediansMs: median(
        reported
          .map((r) => r.report.engagement.medianLatencyMs)
          .filter((ms): ms is number => ms != null && ms > 0),
      ),
      /**
       * Null when no session in the window answered anything.
       *
       * `Math.max(0, ...[])` is 0, and the page renders that as "0ms" — under
       * every threshold, so the tile also awarded a MET target. An empty
       * window was reported as the best latency achievable.
       *
       * Same shape as the console meter's `p95 0ms` in green, which came off a
       * live show 46 seconds in. Zero standing in for "nothing measured" has
       * now turned up in five places in this codebase; the rate helpers in
       * `metrics.ts` all return `number | null` for exactly this reason, and
       * these two were computed inline and missed it.
       */
      worstP95Ms: (() => {
        const seen = reported
          .map((r) => r.report.engagement.p95LatencyMs)
          .filter((ms): ms is number => ms != null && ms > 0);
        return seen.length ? Math.max(...seen) : null;
      })(),
      /** Null on an empty window. 0% reads as "the cache never hits", which is
       *  a claim about a cache that was never asked. */
      // Averaged over the sessions that MEASURED one. A session that drafted
      // nothing has no hit rate, and folding its null in as zero would drag the
      // average toward "the cache never hits" — the same mistake one layer up.
      cacheHitRate: (() => {
        const seen = reported
          .map((r) => r.report.engagement.cacheHitRate)
          .filter((x): x is number => x != null);
        return seen.length ? seen.reduce((a, b) => a + b, 0) / seen.length : null;
      })(),
    },
    safety: {
      blocked,
      revised: sum(reported, (r) => r.report.safety.revised),
      abstained: sum(reported, (r) => r.report.safety.abstained),
      flaggedWrong: sum(reported, (r) => r.report.safety.flaggedWrong ?? 0),
      byGuard,
      blockRate: blockRate({ blocked, answered }),
      /**
       * Chains that were verified — not chains that had nothing to verify.
       *
       * `AuditLog.verify()` walks the entries and returns `{ok: true,
       * height: 0}` for an empty one, which is correct as a fact and vacuous as
       * a claim. Counting those made the console read "Audit chains intact
       * 13/13" in green, hint "hash-verified end to end, per session", when
       * eleven of the thirteen held no entries at all. That is the strongest
       * assurance this product gives, on the thing the PRD leans on hardest to
       * justify letting a copilot near a seller's listings, and it was true of
       * sessions that recorded nothing.
       *
       * An empty chain is not a failure either — a show where nobody sent,
       * approved or changed anything has nothing to write down. It is simply
       * not evidence, so it is counted separately and said separately.
       */
      chainsIntact: reported.filter(
        (r) => (r.report.safety?.auditChain?.ok ?? false) && (r.report.safety?.auditChain?.height ?? 0) > 0,
      ).length,
      /** Sessions whose chain was empty: nothing to verify, so nothing verified. */
      chainsEmpty: reported.filter((r) => (r.report.safety?.auditChain?.height ?? 0) === 0).length,
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
      /**
       * The hours BEHIND that GMV, so "GMV per hour" divides two things that
       * describe the same shows.
       *
       * The page divided gross by `hoursAttached`, which includes every room
       * that sold nothing and every hour one sat idle. With 21.6 idle hours in
       * the window that reported $205 an hour against roughly $13,000 — on the
       * metric the PRD names first for proving this product works.
       */
      hours: Math.round((sum(sold, (r) => r.report.durationMin) / 60) * 100) / 100,
      /** How many of `showsWithGmv` actually took money. The other rows carry
       *  a gmv block of zeroes, which is why `withGmv` cannot be the basis. */
      showsThatSold: sold.length,
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
      // `hasReport` is the honest answer to "was this session measured", and
      // it is here so nothing has to infer it from a rounded duration — a real
      // report for a session shorter than thirty seconds rounds `durationMin`
      // to 0 and gets labelled "no report" beside its own numbers.
      //
      // The zero coercions below are deliberately LEFT for now. Replacing them
      // with nulls is audit finding AFTER-10 and it is not this pass's job:
      // the By-show table decides its badge on `durationMin === 0`, so nulling
      // the field here without the matching one-line change on the client
      // turns "no report" into a claim that the session's audit chain is
      // BROKEN — a false statement about trust, which is worse than the zero
      // it replaced. `hasReport` is what that change should read.
      hasReport: r.report != null,
      durationMin: r.report?.durationMin ?? 0,
      answeredRate: r.report?.engagement?.answeredRate ?? 0,
      p95LatencyMs: r.report?.engagement?.p95LatencyMs ?? 0,
      blocked: r.report?.safety?.blocked ?? 0,
      flaggedWrong: r.report?.safety?.flaggedWrong ?? 0,
      gmvCents: r.report?.prd?.gmv?.grossCents ?? null,
      chainOk: r.report?.safety?.auditChain?.ok ?? false,
    })),
  };
}
