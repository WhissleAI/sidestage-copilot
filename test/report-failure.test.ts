// A report that failed has a reason, and a way back.
//
// Before: the only record of a failed report was a line on the container's
// stdout. The home page rendered a warn badge — "The session ended but its
// report never generated" — with nothing to click, `/reports/<id>` answered
// "the report may never have generated", and there was no route that would try
// again from rows that are all still sitting in Postgres.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

process.env.CATALOGS_DIR = ".tmp/test-catalogs";

const { buildApp } = await import("../src/api/server.js");
const { db: pgPool, migrate } = await import("../src/db/pg.js");
const { behindBand } = await import("../src/api/home.js");
type AppContext = Awaited<ReturnType<typeof buildApp>>["ctx"];

let app: FastifyInstance;
let ctx: AppContext;
let auth: Record<string, string>;
let accountId: string;

const SHOW = "show_report_failure_test";

before(async () => {
  ({ app, ctx } = await buildApp());
  const seller = (
    await app.inject({
      method: "POST", url: "/api/auth/register",
      headers: { "content-type": "application/json" },
      payload: {
        email: `rf${Date.now()}${Math.random().toString(16).slice(2)}@test.local`,
        password: "password-123", displayName: "report-failure",
      },
    })
  ).json();
  auth = { authorization: `Bearer ${seller.token}` };
  accountId = seller.account.id;

  const d = pgPool();
  await migrate(d);
  await d.query("DELETE FROM shows WHERE id = $1", [SHOW]);
  await d.query(
    `INSERT INTO shows (id, owner_account_id, title, seller_handle, started_at, source, status,
                        ended_at, report_error, report_failed_at)
     VALUES ($1, $2, 'The night the report died', 'tester', $3, 'simulated', 'ended', now(),
             'gateway timed out reading the audit chain', now())`,
    [SHOW, accountId, new Date(Date.now() - 2 * 3_600_000).toISOString()],
  );
  // The session's own rows are all still here — which is the point.
  await d.query(
    `INSERT INTO chat_messages (show_id, id, author, text, at, intent, admitted)
     VALUES ($1,'m1','buyer','does it ship to canada',$2,'shipping',TRUE)`,
    [SHOW, new Date().toISOString()],
  );
  await d.query(
    `INSERT INTO reply_proposals (show_id, id, message_id, author, question, draft, status, verdict,
       confidence, repaired, abstained, latency_ms, cache_hit, guards, evidence, intent, at)
     VALUES ($1,'p1','m1','buyer','does it ship to canada','we do','sent','allow',0.9,FALSE,FALSE,
             800,FALSE,'[]'::jsonb,'[]'::jsonb,'shipping',$2)`,
    [SHOW, new Date().toISOString()],
  );
});

after(async () => {
  await pgPool().query("DELETE FROM shows WHERE id = $1", [SHOW]).catch(() => {});
  await app.close();
  await ctx.stop();
});

describe("a session whose report never generated", () => {
  test("the report route says WHY, and that asking again is possible", async () => {
    const r = await app.inject({ method: "GET", url: `/api/shows/${SHOW}/report`, headers: auth });
    assert.equal(r.statusCode, 404, "there is genuinely no report");
    const body = r.json();
    assert.equal(body.reportError, "gateway timed out reading the audit chain");
    assert.equal(body.canRegenerate, true);
    assert.equal(body.status, "ended");
  });

  test("the home band carries the cause onto the badge", () => {
    const band = behindBand(
      [{
        showId: SHOW, title: "The night the report died", surface: "simulated", source: "simulated",
        generatedAt: null, report: null, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
        reportError: "gateway timed out reading the audit chain",
      }],
      { total: 0, ready: 0 },
    );
    assert.equal(band.reports[0]!.hasReport, false);
    assert.equal(band.reports[0]!.reportError, "gateway timed out reading the audit chain");
    assert.equal(band.reports[0]!.answered, null, "and still no invented measurement");
  });

  test("asking again builds the report from the rows that are still here", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/shows/${SHOW}/report`,
      headers: { ...auth, "content-type": "application/json" },
    });
    assert.equal(r.statusCode, 200, JSON.stringify(r.json()));
    const body = r.json();
    assert.equal(body.regenerated, true);
    assert.equal(body.report.engagement.questionsAsked, 1);
    assert.equal(body.report.engagement.sent, 1);

    // Stored, and the failure it recovered from is no longer explained.
    const row = (
      await pgPool().query<{ report_error: string | null }>(
        "SELECT report_error FROM shows WHERE id = $1", [SHOW],
      )
    ).rows[0]!;
    assert.equal(row.report_error, null, "a recovered session must stop reporting an old error");
    const again = await app.inject({ method: "GET", url: `/api/shows/${SHOW}/report`, headers: auth });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().engagement.sent, 1);
  });

  test("a stranger cannot regenerate somebody else's report", async () => {
    const other = (
      await app.inject({
        method: "POST", url: "/api/auth/register",
        headers: { "content-type": "application/json" },
        payload: {
          email: `rf-other${Date.now()}${Math.random().toString(16).slice(2)}@test.local`,
          password: "password-123", displayName: "stranger",
        },
      })
    ).json();
    const r = await app.inject({
      method: "POST", url: `/api/shows/${SHOW}/report`,
      headers: { authorization: `Bearer ${other.token}`, "content-type": "application/json" },
    });
    assert.equal(r.statusCode, 404, "another seller's session is not confirmed to exist");
  });

  test("a session still on air is not given a frozen report", async () => {
    await pgPool().query("UPDATE shows SET status = 'live' WHERE id = $1", [SHOW]);
    const r = await app.inject({
      method: "POST", url: `/api/shows/${SHOW}/report`,
      headers: { ...auth, "content-type": "application/json" },
    });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, "still-live");
    await pgPool().query("UPDATE shows SET status = 'ended' WHERE id = $1", [SHOW]);
  });
});
