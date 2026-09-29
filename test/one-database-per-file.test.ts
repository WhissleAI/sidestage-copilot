// The suite no longer races itself.
//
// Node's runner gives each test file its own process and runs the files in
// parallel; every one of them used the same `sidestage_test`. Measured
// 2026-09-28: three DIFFERENT tests failed on three consecutive parallel runs,
// while `--test-concurrency=1` passed 865/865 twice. One of those three was a
// genuine bug hiding in the noise (an unawaited ledger write), and a tenancy bug
// worth $342 of misattributed revenue was found by chasing another. A suite that
// lies a third of the time is worth less than a smaller one that does not.
//
// Each file now gets its own database, named after itself. Five consecutive
// parallel runs: 869/869, every time. The cost is 6 seconds — 52s against 46s —
// where serialising cost 259s (305s against 46s).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseName, db, migrate } from "../src/db/pg.js";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("one database per test file", () => {
  test("this file is using a database named after itself", () => {
    const name = databaseName();
    assert.match(name, /^sidestage_test_one_database_per_file_\d+$/, `got ${name}`);
    // Named, not numbered: `\\l` and a failure message both have to be readable,
    // which `sidestage_test_41290` is not.
    assert.ok(name.includes("one_database_per_file"), "the file's own name must be in it");
  });

  test("and it is not the shared one every file used to share", () => {
    assert.notEqual(databaseName(), "sidestage_test");
  });

  test("the database exists, because migrate created it", async () => {
    const p = db();
    await migrate(p);
    const r = await p.query<{ current: string }>("SELECT current_database() AS current");
    assert.equal(r.rows[0]!.current, databaseName());
    // And it is migrated, not merely created.
    const t = await p.query<{ n: string }>(
      "SELECT count(*) n FROM information_schema.tables WHERE table_schema = 'public'",
    );
    assert.ok(Number(t.rows[0]!.n) > 20, `only ${t.rows[0]!.n} tables — was it migrated?`);
  });

  test("only a derived test name is ever created", () => {
    // The guard that keeps this from papering over a typo in DATABASE_URL: a
    // misconfigured production URL must fail loudly, not quietly stand up an
    // empty database and migrate it.
    const src = read("src/db/pg.ts");
    assert.match(src, /if \(!name\.startsWith\("sidestage_test_"\)\) return;/);
    assert.match(src, /process\.env\["NODE_ENV"\] !== "test"/);
  });

  test("two creates racing in one process cannot happen, and across processes are tolerated", () => {
    const src = read("src/db/pg.ts");
    // `retrieval.eval.ts` calls migrate twice. Without memoisation both reached
    // CREATE DATABASE and Postgres raised 23505 on pg_database_datname_index —
    // NOT the 42P04 the obvious guess expects, because both got past the
    // existence check before either inserted.
    assert.match(src, /creating \?\?= /, "the create must be memoised per process");
    assert.match(src, /"42P04"/);
    assert.match(src, /"23505"/, "the concurrent-create code must be tolerated too");
  });

  test("the last run's databases are dropped at the START of the next one", () => {
    const sh = read("scripts/ensure-test-db.mjs");
    // At the start, not the end: a crash cannot skip it, and the database that
    // failed is still there to open and look at — which was impossible when every
    // file shared one.
    assert.match(sh, /LIKE 'sidestage_test_%'/);
  });

  test("and a database in use is left alone, so two runs cannot sabotage each other", () => {
    const sh = read("scripts/ensure-test-db.mjs");
    // The first version of this cleanup used `WITH (FORCE)`, which evicts whatever
    // is connected — so two overlapping suite runs dropped each other's live
    // databases mid-test. That is a worse failure than the flakiness the per-file
    // split fixed. The filter is on `pg_stat_activity`, not on age: no connection
    // means no owning process is left, and a connection means a run is still going.
    assert.match(sh, /pg_stat_activity/, "the cleanup must skip databases in use");
    // Comments blanked: the script EXPLAINS why FORCE was removed, and a scanner
    // that trips on its own rationale is a scanner somebody deletes. Third time
    // today I have made this mistake, so it is written down here.
    const code = sh
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, (c) => " ".repeat(c.length));
    assert.ok(
      !/WITH \(FORCE\)/.test(code),
      "FORCE evicts a live run's connection — it must not come back",
    );
  });
});
