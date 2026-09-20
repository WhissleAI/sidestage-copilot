// Every surface's session is reconciled after a restart, not just eBay's.
//
// The sweep read `WHERE status = 'live' AND source = 'ebaylive'`, so it
// reconciled one surface out of seven. A Whatnot, TikTok, Twitch, Reddit or
// simulated session interrupted by a deploy stayed `live` for ever: not in the
// Now band (built from live runtimes, not rows), not in the Behind band (which
// requires `ended` or a report), no report, no cost row, no follow-ups, never
// counted by Analytics — and holding its agent against the cap the collector
// exists to keep.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { db, migrate } from "../src/db/pg.js";
import { finishStranded, planResume, RECENT_ROW_MS, RESUME_WINDOW_MS } from "../src/shows/resume.js";

const old = () => new Date(Date.now() - 2 * RECENT_ROW_MS).toISOString();

describe("what to do with a row that still says live", () => {
  test("an eBay Live session inside the window is reopened", () => {
    const plan = planResume({
      id: "ebay_47tK1SX0VsiHEXN1", source: "ebaylive",
      external_id: "47tK1SX0VsiHEXN1",
      started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      created_at: old(),
    });
    assert.equal(plan.action, "resume");
  });

  test("a session on a surface that cannot be reopened is FINISHED, not left live", () => {
    // The whole finding: before, this row was not even looked at.
    for (const source of ["whatnot", "tiktoklive", "reddit", "simulated"]) {
      const plan = planResume({
        id: `${source}_x`, source, external_id: "some-room",
        started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        created_at: old(),
      });
      assert.equal(plan.action, "finish", `${source} must be reconciled`);
    }
  });

  test("a row is never reopened on a surface other than its own", () => {
    // Resolution is first-match over every adapter and one of them accepts a
    // bare word, so a Whatnot slug resolves to Twitch. Reattaching the wrong
    // surface to somebody's session is worse than not reattaching at all.
    const plan = planResume({
      id: "whatnot_kicksbyrae", source: "whatnot", external_id: "kicksbyrae",
      started_at: new Date().toISOString(), created_at: old(),
    });
    assert.equal(plan.action, "finish");
    assert.match((plan as { why: string }).why, /nothing on whatnot/);
  });

  test("a session older than the window is finished rather than reopened", () => {
    const plan = planResume({
      id: "ebay_old", source: "ebaylive", external_id: "47tK1SX0VsiHEXN1",
      started_at: new Date(Date.now() - RESUME_WINDOW_MS - 60_000).toISOString(),
      created_at: old(),
    });
    assert.equal(plan.action, "finish");
    assert.match((plan as { why: string }).why, /^started \d+h ago$/);
  });

  test("a row written moments ago is left alone", () => {
    const plan = planResume({
      id: "simulated_fresh", source: "simulated", external_id: null,
      started_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });
    assert.equal(plan.action, "leave", "it may belong to a process that is still starting");
  });
});

describe("finishing a session nothing is watching", () => {
  const SHOW = "show_resume_sweep_test";
  after(async () => {
    await db().query("DELETE FROM shows WHERE id = $1", [SHOW]).catch(() => {});
  });

  test("leaves an end time, a report and a cost row, on a non-eBay surface", async () => {
    const d = db();
    await migrate(d);
    await d.query("DELETE FROM shows WHERE id = $1", [SHOW]);
    await d.query(
      `INSERT INTO shows (id, title, seller_handle, started_at, source, status)
       VALUES ($1, 'A Whatnot session a deploy interrupted', 'tester', $2, 'whatnot', 'live')`,
      [SHOW, new Date(Date.now() - 45 * 60_000).toISOString()],
    );
    await d.query(
      `INSERT INTO chat_messages (show_id, id, author, text, at, intent, admitted)
       VALUES ($1,'m1','buyer','is it 100ml',$2,'sizing',TRUE)`,
      [SHOW, new Date().toISOString()],
    );

    const built = await finishStranded(d, SHOW, "nothing on whatnot can be reopened");
    assert.equal(built, true, "the report is generated, not skipped");

    const row = (
      await d.query<{ status: string; ended_at: Date | null }>(
        "SELECT status, ended_at FROM shows WHERE id = $1", [SHOW],
      )
    ).rows[0]!;
    assert.equal(row.status, "ended", "it must stop claiming to be on air");
    assert.ok(row.ended_at, "and carry the moment it stopped");

    const report = (
      await d.query<{ report: { engagement: { questionsAsked: number } } }>(
        "SELECT report FROM show_reports WHERE show_id = $1", [SHOW],
      )
    ).rows[0];
    assert.ok(report, "a session that vanished used to leave nothing behind");
    assert.equal(report.report.engagement.questionsAsked, 1);
  });

  test("a show that cannot even be reopened still stops saying live", async () => {
    const d = db();
    const ok = await finishStranded(d, "show_that_does_not_exist", "no such row");
    assert.equal(ok, false, "there was nothing to report on");
  });
});

// The sweep itself, through the real boot path. Before the fix its query was
// `status = 'live' AND source = 'ebaylive'`, so this row was never looked at.
describe("the boot sweep", () => {
  const SHOW = "show_resume_boot_test";
  after(async () => {
    await db().query("DELETE FROM shows WHERE id = $1", [SHOW]).catch(() => {});
  });

  test("reconciles a stranded session on a surface that is not eBay Live", async () => {
    const d = db();
    await migrate(d);
    await d.query("DELETE FROM shows WHERE id = $1", [SHOW]);
    await d.query(
      `INSERT INTO shows (id, title, seller_handle, started_at, source, status, created_at)
       VALUES ($1, 'A TikTok session a deploy interrupted', 'tester', $2, 'tiktoklive', 'live', $3)`,
      [
        SHOW,
        new Date(Date.now() - 50 * 60_000).toISOString(),
        new Date(Date.now() - 2 * RECENT_ROW_MS).toISOString(),
      ],
    );

    const { buildApp } = await import("../src/api/server.js");
    const { app, ctx } = await buildApp();
    try {
      await ctx.start();
    } finally {
      await app.close();
      await ctx.stop();
    }

    const row = (
      await db().query<{ status: string; ended_at: Date | null }>(
        "SELECT status, ended_at FROM shows WHERE id = $1", [SHOW],
      )
    ).rows[0]!;
    assert.equal(row.status, "ended", "a boot must not leave it claiming to be on air");
    assert.ok(row.ended_at);
    const report = await db().query("SELECT 1 FROM show_reports WHERE show_id = $1", [SHOW]);
    assert.equal(report.rowCount, 1, "and it must leave its report behind");
  });
});
