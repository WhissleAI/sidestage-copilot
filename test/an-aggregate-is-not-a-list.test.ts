// A seller's dashboard was reporting another seller's revenue.
//
// Found by restoring the production dump and asking each account for its own
// analytics. Five ended shows in production are OWNERLESS — rows written before
// `owner_account_id` existed — and `analyticsOverview` admitted them into every
// account's aggregate:
//
//                        BEFORE                      AFTER
//   seller A (owns 14)   18 shows with GMV, $9,133   14 shows, $8,791
//   seller B (owns  2)    6 shows with GMV, $435.74   2 shows, $93.74
//   unscoped             20 shows,          $9,226    unchanged
//
// 18 + 6 = 24 against 20 shows that exist, because the ownerless rows were
// counted into both. Seller B, which owns two sessions, was shown **$435.74 of
// gross and 11 lots sold** — 4.6× its actual revenue.
//
// The ownerless allowance is documented and correct where it came from: a LIST of
// a seller's past shows (`/api/reports`, the home page) includes rows from before
// ownership because they are probably that seller's own history and hiding them
// would lose it (migration 024). That argument does not survive aggregation — the
// same rows go into everybody's totals at once — and it does not survive an inbox
// either, which is why the asynchronous drafts inbox lost it too: those rows are
// a buyer's handle and a buyer's question.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";
import { migrate } from "../src/db/pg.js";
import { analyticsOverview } from "../src/shows/analytics.js";

// Its OWN database, not the shared test one.
//
// The claim is about exact totals — "seller B sees two shows and $10, not six and
// $999" — and every other file in this suite is writing shows into the shared
// database at the same time. A scratch database is the only way the numbers in
// these assertions can be the numbers, rather than "at least".
const BASE = process.env["TEST_DATABASE_URL"] || "postgres://localhost:5432/sidestage_test";
const SCRATCH = BASE.replace(/\/[^/]+$/, "/sidestage_agg_probe");
const ADMIN = BASE.replace(/\/[^/]+$/, "/postgres");

const A = "acc_agg_a";
const B = "acc_agg_b";
const SHOWS = { a: "show_agg_a", b: "show_agg_b", none: "show_agg_none" };
const GROSS = { a: 500_00, b: 10_00, none: 999_00 };
let p: pg.Pool;

/** A finished show with a report carrying one sold lot at a known price. */
async function endedShow(id: string, owner: string | null, grossCents: number): Promise<void> {
  await p.query(
    `INSERT INTO shows (id, owner_account_id, title, seller_handle, source, started_at, status,
                        autonomy_level, undo_window_s, ended_at)
     VALUES ($1, $2, $3, 'agg', 'ebaylive', now()::text, 'ended', 'L1_SUGGEST', 90, now())`,
    [id, owner, `aggregate probe ${id}`],
  );
  await p.query(
    `INSERT INTO show_reports (show_id, generated_at, report) VALUES ($1, now(), $2::jsonb)`,
    [
      id,
      JSON.stringify({
        title: `aggregate probe ${id}`,
        durationMin: 6,
        engagement: { commentsSeen: 1, questionsAsked: 1, answered: 0, sent: 0, answeredRate: 0 },
        safety: { blocked: 0, byGuard: {}, flaggedWrong: 0, auditChain: { ok: true, height: 0 } },
        // The headline GMV is read from `prd.gmv`, not a top-level `gmv`.
        prd: { gmv: { grossCents, lotsSold: 1, hours: 0.1 } },
      }),
    ],
  );
}

before(async () => {
  execFileSync("psql", [ADMIN, "-c", "DROP DATABASE IF EXISTS sidestage_agg_probe"], { stdio: "ignore" });
  execFileSync("psql", [ADMIN, "-c", "CREATE DATABASE sidestage_agg_probe"], { stdio: "ignore" });
  p = new pg.Pool({ connectionString: SCRATCH });
  await migrate(p);
  for (const a of [A, B]) {
    await p.query(
      `INSERT INTO accounts (id, kind, handle, display_name) VALUES ($1,'seller',$2,'agg probe')`,
      [a, a],
    );
  }
  await endedShow(SHOWS.a, A, GROSS.a);
  await endedShow(SHOWS.b, B, GROSS.b);
  // The row that belongs to nobody, and must therefore count for nobody.
  await endedShow(SHOWS.none, null, GROSS.none);
});

after(async () => {
  await p.end().catch(() => {});
  execFileSync("psql", [ADMIN, "-c", "DROP DATABASE IF EXISTS sidestage_agg_probe"], { stdio: "ignore" });
});

describe("an aggregate is not a list", () => {
  test("each seller counts one show — their own", async () => {
    const a = await analyticsOverview(p, 3650, A);
    assert.equal(a.shows.finished, 1, "seller A must count exactly its own show");
    assert.equal(a.gmv.grossCents, GROSS.a);

    const b = await analyticsOverview(p, 3650, B);
    assert.equal(
      b.shows.finished,
      1,
      "seller B must count exactly its own show — the bug counted the ownerless one too",
    );
    assert.equal(
      b.gmv.grossCents,
      GROSS.b,
      `seller B's gross must be its own $${(GROSS.b / 100).toFixed(2)}, not that plus the ` +
        `ownerless $${(GROSS.none / 100).toFixed(2)}`,
    );
  });

  test("the ownerless show is in nobody's revenue, and not in both", async () => {
    const a = await analyticsOverview(p, 3650, A);
    const b = await analyticsOverview(p, 3650, B);
    // The shape of the original bug: the parts summed to more than the whole.
    assert.equal(
      a.shows.finished + b.shows.finished,
      2,
      "two owned shows between two sellers — anything more is a row counted twice",
    );
    assert.equal(a.gmv.grossCents + b.gmv.grossCents, GROSS.a + GROSS.b);
  });

  test("the unscoped view still sees everything, because that is what unscoped means", async () => {
    // A null owner is the box-wide question, used where no account is asking. If
    // this broke, the fix would have taken the ownerless rows out of every view
    // rather than out of the per-seller ones.
    const all = await analyticsOverview(p, 3650, null);
    assert.equal(all.shows.finished, 3);
    assert.equal(all.gmv.grossCents, GROSS.a + GROSS.b + GROSS.none);
  });

  test("the per-intent aggregate is scoped the same way as the headline", async () => {
    // Two queries in one function, and only one of them was fixed once.
    const src = readFileSync(new URL("../src/shows/analytics.ts", import.meta.url), "utf8");
    const loose = [...src.matchAll(/s\.owner_account_id IS NULL/g)];
    assert.deepEqual(
      loose.map((m) => src.slice(0, m.index!).split("\n").length),
      [],
      "an aggregate query still admits ownerless shows",
    );
    // And both queries do scope by owner.
    assert.equal([...src.matchAll(/\$2::text IS NULL OR s\.owner_account_id = \$2/g)].length, 2);
  });
});
