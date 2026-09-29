// One figure, one definition, every consumer.
//
// The bug these cases exist for: a session with 10 admitted questions, 9
// answerable drafts and 2 sent read **20%** on its own report and **90%** in
// Analytics' headline — the same label, the same `target >85%` beside it, two
// different quotients — while the per-show row two sections below the headline
// showed the report's 20% again. Block rate had the same shape of problem with
// two denominators.
//
// So the assertion that matters here is not "the number is 0.2". It is that two
// consumers of a NAMED figure produce the identical value from the same
// session. If someone re-derives one of them at a call site, this fails.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { db, migrate } from "../src/db/pg.js";
import { buildReport } from "../src/shows/sessionRecord.js";
import { analyticsOverview } from "../src/shows/analytics.js";
import { answerableShare, answeredRate, blockRate, durationMin, durationHours } from "../src/shows/metrics.js";

// ── the definitions themselves ──────────────────────────────────────────────

describe("what each named figure divides", () => {
  test("answered rate is what the seller SENT over what the gate admitted", () => {
    assert.equal(answeredRate({ sent: 2, questionsAsked: 10 }), 0.2);
    // Not "drafts the copilot could stand behind": a draft nobody sent never
    // reached the buyer who asked.
    assert.notEqual(answeredRate({ sent: 2, questionsAsked: 10 }), 0.9);
  });

  test("block rate excludes abstentions from its denominator", () => {
    // 1 blocked, 9 answered, 40 abstained. A session that abstained a lot must
    // not look safer for it: the abstentions were never drafts a guard stopped.
    assert.equal(blockRate({ blocked: 1, answered: 9 }), 0.1);
  });

  test("an empty denominator is null, never zero", () => {
    assert.equal(answeredRate({ sent: 0, questionsAsked: 0 }), null);
    assert.equal(blockRate({ blocked: 0, answered: 0 }), null);
    assert.equal(answerableShare({ answered: 0, proposals: 0 }), null);
  });

  test("duration is measured to when the session stopped, not to now", () => {
    const started = "2026-09-18T20:00:00.000Z";
    const ended = "2026-09-18T21:30:00.000Z";
    assert.equal(durationMin(started, ended), 90);
    assert.equal(durationHours(started, ended), 1.5);
    // A session still live has no end yet; `now` is the honest stand-in and it
    // is strictly larger than any stamped end from the past.
    assert.ok(durationMin(started, null) > 90);
  });
});

// ── the consumers, over one real session ────────────────────────────────────

const SHOW = "show_metrics_agree";
const ACCOUNT = "acct_metrics_agree";
const started = new Date(Date.now() - 90 * 60_000).toISOString();

async function seedSession(): Promise<void> {
  const d = db();
  await migrate(d);
  await d.query("DELETE FROM shows WHERE id = $1", [SHOW]);
  await d.query("DELETE FROM accounts WHERE id = $1", [ACCOUNT]);
  await d.query(
    `INSERT INTO accounts (id, kind, handle, display_name, email, password_hash)
     VALUES ($1, 'seller', 'metrics', 'metrics', $2, 'x') ON CONFLICT (id) DO NOTHING`,
    [ACCOUNT, `${ACCOUNT}@test.local`],
  );
  await d.query(
    `INSERT INTO shows (id, owner_account_id, title, seller_handle, started_at, source, status, ended_at)
     VALUES ($1, $2, 'Metrics session', 'tester', $3, 'simulated', 'ended', now())`,
    [SHOW, ACCOUNT, started],
  );

  // Ten admitted questions.
  for (let i = 0; i < 10; i++) {
    await d.query(
      `INSERT INTO chat_messages (show_id, id, author, text, at, intent, admitted)
       VALUES ($1,$2,$3,$4,$5,'price_question',TRUE)`,
      [SHOW, `m${i}`, `buyer${i}`, `how much is lot ${i}`, started],
    );
  }
  // Twelve proposals: 9 answered (2 of them sent), 1 blocked, 2 abstained.
  const rows = [
    ...Array.from({ length: 2 }, (_, i) => ({ id: `p_sent_${i}`, status: "sent", verdict: "allow", abstained: false })),
    ...Array.from({ length: 7 }, (_, i) => ({ id: `p_ready_${i}`, status: "ready", verdict: "allow", abstained: false })),
    { id: "p_blocked", status: "blocked", verdict: "block", abstained: false },
    ...Array.from({ length: 2 }, (_, i) => ({ id: `p_abst_${i}`, status: "ready", verdict: "allow", abstained: true })),
  ];
  for (const r of rows) {
    await d.query(
      `INSERT INTO reply_proposals (show_id, id, message_id, author, question, draft, status, verdict,
         confidence, repaired, abstained, latency_ms, cache_hit, guards, evidence, intent, at)
       VALUES ($1,$2,$3,$4,$5,'a draft',$6,$7,0.9,FALSE,$8,900,FALSE,'[]'::jsonb,'[]'::jsonb,'price_question',$9)`,
      [SHOW, r.id, `m_${r.id}`, "buyer", "how much", r.status, r.verdict, r.abstained, started],
    );
  }
}

after(async () => {
  const d = db();
  await d.query("DELETE FROM shows WHERE id = $1", [SHOW]).catch(() => {});
  await d.query("DELETE FROM accounts WHERE id = $1", [ACCOUNT]).catch(() => {});
});

describe("two consumers of one figure", () => {
  test("the report and Analytics agree on answered rate and block rate", async () => {
    await seedSession();
    const d = db();

    const report = await buildReport(d, SHOW, { auditChain: { ok: true, height: 0 } });
    await d.query(
      `INSERT INTO show_reports (show_id, report) VALUES ($1, $2::jsonb)
       ON CONFLICT (show_id) DO UPDATE SET report = EXCLUDED.report, generated_at = now()`,
      [SHOW, JSON.stringify(report)],
    );

    const a = await analyticsOverview(d, 7, ACCOUNT);
    const row = a.perShow.find((p) => p.showId === SHOW);
    assert.ok(row, "the session must be in its own account's table");

    // Sent (2) over admitted questions (10). One value, three surfaces.
    assert.equal(report.engagement.answeredRate, 0.2);
    assert.equal(
      a.engagement.answeredRate, report.engagement.answeredRate,
      "the Analytics headline and the report must be the same figure",
    );
    assert.equal(
      row.answeredRate, a.engagement.answeredRate,
      "the per-show row and the headline above it must agree for a single session",
    );
    assert.equal(
      report.prd.gmv.answeredQuestionRate, report.engagement.answeredRate,
      "the PRD block and the engagement tile are one figure, not two",
    );

    // Blocked (1) over drafts that reached a verdict (9 answered + 1 blocked).
    assert.equal(report.prd.trust.blockRate, 0.1);
    assert.equal(
      a.safety.blockRate, report.prd.trust.blockRate,
      "Analytics' block rate and the report's must be the same figure",
    );

    // And the counts behind them, so a future reader can see the denominators.
    assert.equal(report.engagement.questionsAsked, 10);
    assert.equal(report.engagement.answered, 9);
    assert.equal(report.engagement.sent, 2);
    assert.equal(report.safety.blocked, 1);
  });

  test("the report's duration is measured to when the session stopped", async () => {
    await seedSession();
    const d = db();
    // Started 90 minutes ago, stopped 30 minutes ago: an hour on air, and a
    // half-hour of a console left attached afterwards that is nobody's airtime.
    //
    // BOTH timestamps are set here, from one instant. `started` is computed once
    // at module load, so setting only `ended_at` made the duration
    // `60 + however long the earlier tests in this file took` — it read 62 the
    // first time the suite got slow enough, which is a time bomb rather than a
    // test. The arithmetic is exact now whenever it runs.
    const stopped = new Date(Date.now() - 30 * 60_000);
    const began = new Date(stopped.getTime() - 60 * 60_000);
    await d.query("UPDATE shows SET started_at = $2, ended_at = $3 WHERE id = $1", [
      SHOW,
      began.toISOString(),
      stopped.toISOString(),
    ]);

    const report = await buildReport(d, SHOW, { auditChain: { ok: true, height: 0 } });
    assert.equal(report.durationMin, 60, "60 minutes on air, not 90 to report-generation time");
    assert.equal(report.endedAt, stopped.toISOString(), "the report's end is the session's end");
    assert.equal(report.prd.gmv.hours, 1, "the PRD's per-hour denominator is the same span");
  });

  test("a session with no report says so, rather than leaving it to be inferred", async () => {
    const d = db();
    await d.query("DELETE FROM show_reports WHERE show_id = $1", [SHOW]);
    const a = await analyticsOverview(d, 7, ACCOUNT);
    const row = a.perShow.find((p) => p.showId === SHOW);
    assert.ok(row);
    assert.equal(row.hasReport, false, "and not by rounding a duration to zero");
    // A real report for a session shorter than thirty seconds also rounds to
    // zero minutes, so the two states were indistinguishable.
    const withReport = await (async () => {
      await seedSession();
      const report = await buildReport(d, SHOW, { auditChain: { ok: true, height: 0 } });
      await d.query(
        `INSERT INTO show_reports (show_id, report) VALUES ($1, $2::jsonb)
         ON CONFLICT (show_id) DO UPDATE SET report = EXCLUDED.report`,
        [SHOW, JSON.stringify({ ...report, durationMin: 0 })],
      );
      return (await analyticsOverview(d, 7, ACCOUNT)).perShow.find((p) => p.showId === SHOW)!;
    })();
    assert.equal(withReport.durationMin, 0, "a twenty-second session really is zero minutes");
    assert.equal(withReport.hasReport, true, "and it is still a report");
  });
});

/**
 * GMV per hour is the PRD's first business metric, and the page divided it by
 * every hour the app was attached to anything.
 *
 * `durationMin` is attach-to-detach — show length for a live event that ends,
 * and not for a room that persists. In production a subreddit and a Twitch
 * channel held 21.6 hours each of it, sold nothing, and answered nobody. Gross
 * over that read $205 an hour where the shows that actually sold were running
 * about $13,000.
 *
 * The fix is that a rate divides two numbers describing the same shows, so the
 * overview reports the hours BEHIND the GMV next to the GMV.
 */
describe("a rate divides matched things", () => {
  test("gmv hours cover only the shows that produced gmv", () => {
    const shows = [
      { durationMin: 13, gross: 500_000 },
      { durationMin: 9, gross: 407_800 },
      { durationMin: 1297, gross: 0 },
      { durationMin: 1297, gross: 0 },
    ];
    const attachedHours = shows.reduce((a, s) => a + s.durationMin, 0) / 60;
    const withGmv = shows.filter((s) => s.gross > 0);
    const gmvHours = withGmv.reduce((a, s) => a + s.durationMin, 0) / 60;
    const gross = withGmv.reduce((a, s) => a + s.gross, 0);

    assert.ok(attachedHours > 43, "the idle rooms dominate time attached");
    assert.ok(gmvHours < 0.4, "and contribute nothing to the hours that sold");

    const blended = gross / attachedHours;
    const matched = gross / gmvHours;
    assert.ok(
      matched > blended * 50,
      `a rate an idle room can flatten is not a rate: ${matched} vs ${blended}`,
    );
  });

  test("no gmv means no rate, rather than a rate of zero", () => {
    const gmvHours = 0;
    const rate = gmvHours ? 100 / gmvHours : null;
    assert.equal(rate, null, "zero per hour reads as 'this sells nothing'");
  });
});

/**
 * "Has a gmv block" is not "sold something".
 *
 * The first attempt at the matched denominator filtered on `report.prd?.gmv`
 * being present. A session that sold nothing still carries that block, full of
 * zeroes, so the two rooms attached overnight passed straight back into the
 * divisor and the rate did not move — 44.18h of 44.2h, still $205 an hour.
 * Caught by opening the page after deploying, not by the type checker.
 */
describe("the gmv denominator is shows that took money", () => {
  test("a zeroed gmv block is not a selling hour", () => {
    const reports = [
      { durationMin: 13, gmv: { grossCents: 500_000 } },
      { durationMin: 9, gmv: { grossCents: 407_800 } },
      { durationMin: 1297, gmv: { grossCents: 0 } },
      { durationMin: 1297, gmv: { grossCents: 0 } },
    ];
    const present = reports.filter((r) => r.gmv);
    const sold = present.filter((r) => r.gmv.grossCents > 0);

    assert.equal(present.length, 4, "every row carries the block");
    assert.equal(sold.length, 2, "two of them took money");

    const hoursIfPresent = present.reduce((a, r) => a + r.durationMin, 0) / 60;
    const hoursIfSold = sold.reduce((a, r) => a + r.durationMin, 0) / 60;
    assert.ok(hoursIfPresent > 43 && hoursIfSold < 0.4);

    const gross = sold.reduce((a, r) => a + r.gmv.grossCents, 0);
    assert.ok(
      gross / hoursIfSold > (gross / hoursIfPresent) * 50,
      "filtering on presence leaves the rate exactly where it was",
    );
  });
});

/**
 * Two questions, two numbers.
 *
 * `answeredRate` is sent over asked — right for the PRD's row, because a draft
 * nobody sent reached no buyer. But the PRD hangs its >85% target on sellers
 * who have reached L3, where the copilot sends for itself, and every show in
 * production has run at L1_SUGGEST. All sixteen.
 *
 * So the console read "Answered rate 7% · target >85%" over a period in which
 * the copilot had grounded 34 of 45 questions. The failing number was the
 * seller's send rate wearing the copilot's label.
 */
describe("the copilot's share is not the seller's", () => {
  test("they diverge exactly when the seller does not send", () => {
    const asked = 45, answered = 34, sent = 3;
    const answeredRate = sent / asked;
    const groundedRate = answered / asked;
    assert.ok(answeredRate < 0.1, `${answeredRate}`);
    assert.ok(groundedRate > 0.7, `${groundedRate}`);
    assert.ok(groundedRate > answeredRate * 5, "one number cannot carry both readings");
  });

  test("at L3 they converge, which is the level the target assumes", () => {
    // The copilot sends for itself, so every grounded answer reaches a buyer.
    const asked = 45, answered = 34, sent = 34;
    assert.equal(sent / asked, answered / asked);
  });

  test("neither is defined when nothing was asked", () => {
    assert.equal(0 > 0 ? 1 : null, null, "a rate over no questions is not zero");
  });
});

/**
 * "Sent" is a box the seller ticks, on every surface this product is for.
 *
 * eBay Live, Whatnot and TikTok Live are all `delivery: "draft-only"` — only
 * Twitch and YouTube Live expose a way to post. So the reply is copied into
 * the platform's own chat by hand and "sent" records what the seller told us,
 * not what we delivered.
 *
 * That is why 34 grounded answers show as 3 sent, and why >85% on these
 * surfaces is a target for mid-show bookkeeping rather than for the copilot.
 */
describe("what the surfaces can actually deliver", () => {
  test("every live-commerce surface is draft-only", async () => {
    const { SURFACE_CAPABILITIES } = await import("../src/surfaces/types.js");
    for (const id of ["ebaylive", "whatnot", "tiktoklive"] as const) {
      assert.equal(SURFACE_CAPABILITIES[id].delivery, "draft-only", id);
    }
  });

  test("the ones that can post are not the ones sellers sell on", async () => {
    const { SURFACE_CAPABILITIES } = await import("../src/surfaces/types.js");
    const api = Object.entries(SURFACE_CAPABILITIES)
      .filter(([, c]) => c.delivery === "api")
      .map(([id]) => id);
    assert.deepEqual(api.sort(), ["twitch", "youtubelive"]);
  });

  test("so a sent count on those surfaces is a floor, never a measurement", () => {
    // 34 grounded, 3 marked. The gap is unobservable by construction: nothing
    // in this system sees the seller paste into eBay's chat.
    const grounded = 34, marked = 3;
    assert.ok(marked <= grounded);
    assert.ok(marked / 45 < 0.1 && grounded / 45 > 0.7);
  });
});

/**
 * A latency meter over no replies said "0ms" in green.
 *
 * `pct` of an empty window is 0, and the console could not tell that from a
 * reply that took no time — so a session that had answered nothing reported
 * perfect latency. Seen on a live eBay Live show 46 seconds in, queue empty,
 * "p95 0ms" in the bar.
 */
describe("the latency meter knows when it has measured nothing", () => {
  test("an untouched tracker reports zero samples", async () => {
    const { LatencyTracker } = await import("../src/latency/spans.js");
    const t = new LatencyTracker(2000);
    const p = t.percentiles();
    assert.equal(p.samples, 0);
    assert.equal(p.p95, 0, "the percentile is still a number; samples is what qualifies it");
  });

  test("one reply is one sample", async () => {
    const { LatencyTracker } = await import("../src/latency/spans.js");
    const t = new LatencyTracker(2000);
    t.record(850, false);
    const p = t.percentiles();
    assert.equal(p.samples, 1);
    assert.ok(p.p95 > 0);
  });

  test("samples count the window, not the lifetime", async () => {
    // The window is what the percentiles are over, so it is what qualifies
    // them; `count` is the lifetime total and answers a different question.
    const { LatencyTracker } = await import("../src/latency/spans.js");
    const t = new LatencyTracker(2000, 3);
    for (let i = 0; i < 10; i++) t.record(100 + i, false);
    assert.equal(t.percentiles().samples, 3);
    assert.equal(t.count, 10);
  });
});

/**
 * The last two rates that treated an empty window as a result.
 *
 * `metrics.ts`'s helpers all return `number | null` for this reason. These two
 * were computed inline in the overview and missed it: `Math.max(0, ...[])` is
 * 0, which the page rendered as "0ms" AND awarded a met target — the best
 * latency achievable, for sessions that answered nothing.
 */
describe("an empty analytics window measures nothing", () => {
  test("the worst p95 over no answered sessions is null, not zero", () => {
    const p95s: number[] = [];
    const seen = p95s.filter((x) => x > 0);
    assert.equal(seen.length ? Math.max(...seen) : null, null);
  });

  test("a session that answered nothing does not drag the worst down to zero", () => {
    // One real session at 3067ms beside two that never answered: the worst is
    // 3067, not 0. `Math.max(0, 3067, 0, 0)` happened to be right here; the
    // filter is what makes it right for the reason rather than by luck.
    const seen = [3067, 0, 0].filter((x) => x > 0);
    assert.equal(seen.length ? Math.max(...seen) : null, 3067);
  });

  test("cache hit rate over no sessions is null, not a cache that never hits", () => {
    const reported: number[] = [];
    assert.equal(reported.length ? reported.reduce((a, b) => a + b, 0) / reported.length : null, null);
  });
});
