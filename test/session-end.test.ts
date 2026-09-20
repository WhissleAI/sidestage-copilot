// What a session leaves behind when part of it fails.
//
// Two writes on the end-of-session path used to swallow their own errors, and
// each one turned a failure into a confident false statement:
//
//   * `recordUtterance` ended in an empty catch. A transcript write that failed
//     made `hostSummary` return null, which made the report render its "no host
//     audio" empty state and made the agent's conclusion read "HOST SIGNALS:
//     none — host audio was not captured" about a show where the host talked
//     for two hours.
//   * `recordCost` was swallowed AND was the last statement of the report's
//     success path, so a report that threw took the money record with it. The
//     Cost page then showed fewer sessions and a smaller total with nothing
//     saying anything was missing.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { db, migrate, type Pool } from "../src/db/pg.js";
import { SessionSignals } from "../src/shows/signals.js";
import { buildReport } from "../src/shows/sessionRecord.js";
import { concludeShow, type ConclusionEvidence } from "../src/shows/conclusion.js";
import { ShowRuntime } from "../src/shows/runtime.js";
import { meter } from "../src/llm/meter.js";
import type { LlmPort } from "../src/llm/types.js";
import type { TranscriptSegment } from "../src/domain/types.js";

const SHOW = "show_session_end_test";

after(async () => {
  await db().query("DELETE FROM shows WHERE id = $1", [SHOW]).catch(() => {});
});

async function seedShow(): Promise<Pool> {
  const d = db();
  await migrate(d);
  await d.query("DELETE FROM shows WHERE id = $1", [SHOW]);
  await d.query(
    `INSERT INTO shows (id, title, seller_handle, started_at, source, status)
     VALUES ($1, 'A session that half worked', 'tester', $2, 'simulated', 'live')`,
    [SHOW, new Date(Date.now() - 40 * 60_000).toISOString()],
  );
  return d;
}

/** A pool whose every write refuses — a full disk, a pool timeout, a schema
 *  drift. The point is only that the INSERT does not land. */
const brokenPool = (): Pool =>
  ({ query: async () => { throw new Error("connection terminated"); } }) as unknown as Pool;

const segment = (text: string): TranscriptSegment =>
  ({
    showId: SHOW,
    at: new Date().toISOString(),
    text,
    emotion: null,
    intent: null,
    speechRate: null,
    levels: null,
  }) as TranscriptSegment;

describe("a transcript write that fails", () => {
  test("is counted and said out loud, not swallowed", async () => {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); };
    try {
      const signals = new SessionSignals(brokenPool());
      signals.recordUtterance(segment("this one is a hundred and ten"));
      signals.recordUtterance(segment("next lot, size nine"));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(signals.lost(SHOW), 2, "both failures must be counted");
      assert.ok(
        warnings.some((w) => w.includes("utterance") && w.includes(SHOW)),
        `the failure must reach the log; saw ${JSON.stringify(warnings)}`,
      );
    } finally {
      console.warn = realWarn;
    }
  });

  test("the report says signals were LOST, not that no audio was captured", async () => {
    const d = await seedShow();
    const signals = new SessionSignals(brokenPool());
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      signals.recordUtterance(segment("this one is a hundred and ten"));
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      console.warn = realWarn;
    }

    const report = await buildReport(d, SHOW, { auditChain: { ok: true, height: 0 }, signals });
    assert.equal(report.host, null, "nothing could be summarised, because nothing was stored");
    assert.equal(report.media.utterances, 0);
    assert.equal(
      report.media.lostUtterances, 1,
      "a lost signal is a different fact from an absent one, and the report must carry it",
    );
  });

  test("the agent is told the record was lost, not that the host was silent", async () => {
    let prompt = "";
    const llm = {
      utilityTurn: async (_system: string, text: string) => { prompt = text; return ""; },
    } as unknown as LlmPort;
    const evidence = {
      title: "A session that half worked",
      host: "tester",
      durationMin: 40,
      engagement: { commentsSeen: 10, questionsAsked: 5, answered: 4, sent: 2, p95LatencyMs: 900 },
      safety: { blocked: 0, revised: 0, abstained: 1, flaggedWrong: 0, byGuard: {} },
      actions: { proposed: 0, committed: 0, rolledBack: 0, failed: 0 },
      inventory: { lotsObserved: 3, lotsEnded: 1, priceChanges: 0, peakViewers: 12 },
      gaps: [],
      hostSignals: null,
      hostSignalsLost: 7,
      onScreen: [],
      said: [],
      gmv: null,
      platformSummary: null,
    } satisfies ConclusionEvidence;

    await concludeShow(llm, evidence);
    assert.match(prompt, /transcript write\(s\) FAILED/);
    assert.doesNotMatch(
      prompt, /host audio was not captured/,
      "the agent must not be handed a false claim about the show",
    );
  });
});

describe("a report that fails", () => {
  test("still ends the session AND still writes its cost row", async () => {
    const d = await seedShow();
    // The session spent money: 12 gateway calls this process counted itself.
    for (let i = 0; i < 12; i++) {
      meter.record({ door: "chat_turn", ms: 400, ok: i !== 3, showId: SHOW, contextChars: 100 });
    }
    // A proposal, so the cost row's `answered` has something to count without
    // borrowing it from the report that is about to fail.
    await d.query(
      `INSERT INTO reply_proposals (show_id, id, message_id, author, question, draft, status, verdict,
         confidence, repaired, abstained, latency_ms, cache_hit, guards, evidence, intent, at)
       VALUES ($1,'p1','m1','buyer','how much','a draft','ready','allow',0.9,FALSE,FALSE,900,FALSE,
               '[]'::jsonb,'[]'::jsonb,'price_question',$2)`,
      [SHOW, new Date().toISOString()],
    );

    const rt = new ShowRuntime({
      showId: SHOW,
      title: "A session that half worked",
      sellerHandle: "tester",
      source: "simulated",
      replay: true,
      events: { emit: () => {} },
    });
    // One real way a report fails: the audit chain cannot be read. It is the
    // first thing `finishSession` does inside its try, so everything after it
    // is on the failure path.
    (rt as unknown as { audit: { verify(): Promise<unknown> } }).audit = {
      verify: async () => { throw new Error("audit chain unreadable"); },
    };

    const realError = console.error;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
    let report;
    try {
      report = await rt.finishSession();
    } finally {
      console.error = realError;
      await rt.close().catch(() => {});
    }

    assert.equal(report, null, "the report genuinely failed");
    assert.ok(errors.some((e) => e.includes("REPORT FAILED")), "and said so");

    const show = (await d.query<{ status: string; ended_at: Date | null }>(
      "SELECT status, ended_at FROM shows WHERE id = $1", [SHOW],
    )).rows[0]!;
    assert.equal(show.status, "ended", "a session must not stay live because its report failed");
    assert.ok(show.ended_at, "and its end must be stamped");

    const cost = (await d.query<{ calls: number; failures: number; answered: number; duration_min: number }>(
      "SELECT calls, failures, answered, duration_min FROM show_costs WHERE show_id = $1", [SHOW],
    )).rows[0];
    assert.ok(cost, "the money record must not be lost with the report");
    assert.equal(cost.calls, 12);
    assert.equal(cost.failures, 1);
    assert.equal(cost.answered, 1, "counted from the session's own proposals");
    assert.ok(cost.duration_min >= 40, "measured from the session's own clock");
  });
});
