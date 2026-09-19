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
    const stopped = new Date(Date.now() - 30 * 60_000).toISOString();
    await d.query("UPDATE shows SET ended_at = $2 WHERE id = $1", [SHOW, stopped]);

    const report = await buildReport(d, SHOW, { auditChain: { ok: true, height: 0 } });
    assert.equal(report.durationMin, 60, "60 minutes on air, not 90 to report-generation time");
    assert.equal(report.endedAt, stopped, "the report's end is the session's end");
    assert.equal(report.prd.gmv.hours, 1, "the PRD's per-hour denominator is the same span");
  });

  test("a session with no report is listed with nulls, not with a row of zeroes", async () => {
    const d = db();
    await d.query("DELETE FROM show_reports WHERE show_id = $1", [SHOW]);
    const a = await analyticsOverview(d, 7, ACCOUNT);
    const row = a.perShow.find((p) => p.showId === SHOW);
    assert.ok(row);
    assert.equal(row.hasReport, false, "the row must say it has no report");
    assert.equal(row.answeredRate, null, "nobody measured this session's answered rate");
    assert.equal(row.blocked, null);
    assert.equal(row.durationMin, null, "report presence is not a rounded duration");
  });
});
