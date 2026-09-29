// Things that must be true of the rows, whatever wrote them.
//
// These ran for the first time on 2026-09-28 against a restored production dump
// — the first copy of that data that has ever existed — as a pile of ad-hoc SQL.
// Most of it came back clean, and two things did not:
//
//   every `sent` proposal had `sent_at` NULL      3 of 3, historical: the current
//                                                code persists it, which now has
//                                                a test of its own
//   `shows.started_at` is TEXT, `ended_at` is     `ended_at < started_at` is a
//   `timestamptz`, in the same table              type error, not a comparison
//
// A pile of ad-hoc SQL is worth running once. These are the same checks as
// assertions, so they run on every suite — and `AUDIT_DATABASE_URL` points them
// at a restored dump, which is the whole point of having one:
//
//   scripts/backup.sh dump ~/backups
//   createdb sidestage_audit && scripts/backup.sh restore ~/backups/<f> …/sidestage_audit
//   AUDIT_DATABASE_URL=postgres://localhost/sidestage_audit npm test

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { db, migrate, closeDb } from "../src/db/pg.js";

const AUDITING = process.env["AUDIT_DATABASE_URL"];
let q: (sql: string) => Promise<Record<string, unknown>[]>;
let external: pg.Pool | null = null;

before(async () => {
  if (AUDITING) {
    external = new pg.Pool({ connectionString: AUDITING });
    q = async (sql) => (await external!.query(sql)).rows as Record<string, unknown>[];
  } else {
    const p = db();
    await migrate(p);
    q = async (sql) => (await p.query(sql)).rows as Record<string, unknown>[];
  }
});

after(async () => {
  if (external) await external.end();
  else await closeDb();
});

/** Every row this returns is a violation, and the test prints them. */
async function violations(label: string, sql: string): Promise<void> {
  const rows = await q(sql);
  assert.deepEqual(rows, [], `${label} — ${rows.length} row(s): ${JSON.stringify(rows.slice(0, 5))}`);
}

describe("what must be true of the rows", () => {
  test("nothing costs a negative amount or holds a negative quantity", async () => {
    await violations("listings with qty < 0", "SELECT show_id, id, qty FROM listings WHERE qty < 0");
    await violations("listings priced at or below zero", "SELECT show_id, id, price_cents FROM listings WHERE price_cents <= 0");
    await violations("sales at a negative price", "SELECT show_id, listing_id, price_cents FROM sales WHERE price_cents < 0");
    await violations("shows with negative viewers", "SELECT id, viewers FROM shows WHERE viewers < 0");
  });

  test("a show did not end before it started", async () => {
    // The cast is the finding. `started_at` is TEXT and `ended_at` is
    // `timestamptz`, in the same table, so this comparison is a type error
    // without it — which is how the check went unwritten.
    await violations(
      "shows that ended before they started",
      "SELECT id, started_at, ended_at FROM shows WHERE ended_at IS NOT NULL AND ended_at < started_at::timestamptz",
    );
  });

  test("a report describes a finished session", async () => {
    await violations(
      "reports for shows that are not ended",
      "SELECT r.show_id, s.status FROM show_reports r JOIN shows s ON s.id = r.show_id WHERE s.status <> 'ended'",
    );
  });

  test("a sent reply has the moment it went", async () => {
    // Three production rows fail this, from before the persistence path worked.
    // They are named rather than excluded: the value is gone and cannot be
    // recovered, and an exclusion would hide the next one.
    const rows = await q("SELECT show_id, id FROM reply_proposals WHERE status = 'sent' AND sent_at IS NULL");
    const KNOWN = new Set([
      "prop_27ca51cd-bed3-4abd-b956-3e9c2f3a53a7",
      "prop_d366b002-b347-4dd3-93ba-5165127e5bd9",
      "prop_352dc1e2-ce6e-4b73-bad7-a165224d7dde",
    ]);
    const unexpected = rows.filter((r) => !KNOWN.has(String(r["id"])));
    assert.deepEqual(
      unexpected,
      [],
      `sent proposals with no sent_at beyond the three known historical rows: ${JSON.stringify(unexpected)}`,
    );
  });

  test("nothing references a show that is gone", async () => {
    for (const t of ["chat_messages", "reply_proposals", "audit", "listings", "show_reports", "sales"]) {
      await violations(
        `${t} rows whose show does not exist`,
        `SELECT x.show_id FROM ${t} x LEFT JOIN shows s ON s.id = x.show_id WHERE s.id IS NULL LIMIT 5`,
      );
    }
    // `session_events` deliberately has no FK — an event about a session stays
    // true after the session is gone — so it is NOT in the list above. Asserted
    // here so the exclusion is a decision rather than an oversight.
    const orphans = await q(
      "SELECT count(*)::int AS n FROM session_events e LEFT JOIN shows s ON s.id = e.show_id WHERE e.show_id IS NOT NULL AND s.id IS NULL",
    );
    assert.ok(Number(orphans[0]!["n"]) >= 0, "session_events is allowed to outlive its show");
  });

  test("the audit chain is a chain, on every show that has one", async () => {
    // Sequence numbers dense from 1, and every prev_hash equal to the previous
    // row's hash. `AuditLog.verify()` does this per show; this is the same
    // question asked of every show at once, which is the form that is worth
    // running against a dump.
    await violations(
      "audit sequences with a gap or a duplicate",
      `SELECT show_id, count(*) AS entries, max(seq) AS top FROM audit GROUP BY show_id HAVING count(*) <> max(seq) OR min(seq) <> 1`,
    );
    await violations(
      "audit rows whose prev_hash is not the previous row's hash",
      `SELECT show_id, seq FROM (
         SELECT show_id, seq, prev_hash, lag(hash) OVER (PARTITION BY show_id ORDER BY seq) AS before
           FROM audit
       ) t WHERE seq > 1 AND prev_hash <> before`,
    );
  });

  test("a report's headline figures match the rows it was built from", async () => {
    // The bug this is for: the same named figure read 20% on a report and 90% in
    // Analytics. Checked against production on 2026-09-28 — all 20 reports agreed.
    await violations(
      "reports whose questionsAsked or sent disagree with the rows",
      `SELECT r.show_id,
              (r.report->'engagement'->>'questionsAsked')::int AS reported_asked,
              (SELECT count(*) FROM chat_messages c WHERE c.show_id = r.show_id AND c.admitted) AS actual_asked,
              (r.report->'engagement'->>'sent')::int AS reported_sent,
              (SELECT count(*) FROM reply_proposals p WHERE p.show_id = r.show_id AND p.status = 'sent') AS actual_sent
         FROM show_reports r
        WHERE (r.report->'engagement'->>'questionsAsked')::int
              <> (SELECT count(*) FROM chat_messages c WHERE c.show_id = r.show_id AND c.admitted)
           OR (r.report->'engagement'->>'sent')::int
              <> (SELECT count(*) FROM reply_proposals p WHERE p.show_id = r.show_id AND p.status = 'sent')`,
    );
  });
});
