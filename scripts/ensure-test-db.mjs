// The suite gets its own database, and creates it if it is not there.
//
// It used to run against DATABASE_URL — which on a developer's machine is the
// database the dev server is serving. Every run wrote chat messages, proposals
// and follow rows into the live demo show, and after chat rehydration landed
// those rows started appearing in the console's firehose as if a buyer had
// typed them. A test that leaves evidence in the product is not isolated.
//
// Set TEST_DATABASE_URL to point the suite somewhere else.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const url =
  process.env.TEST_DATABASE_URL || "postgres://localhost:5432/sidestage_test";
const name = new URL(url).pathname.replace(/^\//, "");
const admin = new URL(url);
admin.pathname = "/postgres";

try {
  execFileSync("psql", [admin.toString(), "-tAc", `SELECT 1 FROM pg_database WHERE datname = '${name}'`], {
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim() === "1" ||
    execFileSync("psql", [admin.toString(), "-c", `CREATE DATABASE "${name}"`], { stdio: "ignore" });
} catch (e) {
  // No psql, or no permission to create. Say so plainly rather than letting the
  // suite fall back to the developer's own database without telling them.
  console.error(
    `[pretest] could not prepare ${name}: ${e.message}\n` +
      `          create it by hand (createdb ${name}) or set TEST_DATABASE_URL.`,
  );
  process.exit(1);
}

// Drop the per-file databases a previous run left behind — and only those.
//
// Each test FILE gets its own database (`src/db/pg.ts`), which is what stopped the
// suite racing itself. Nothing reliably drops them: an interrupted file, or one
// that never calls `closeDb`, leaves its database behind. So they are cleaned up at
// the START of a run, where a crash cannot skip it, and the last run's databases
// stay around until then — after a failure you can still open the one that failed
// and look, which was impossible when every file shared one.
//
// IN USE MEANS LEAVE ALONE. The first version of this used `WITH (FORCE)`, which
// evicts whatever is connected — so two overlapping suite runs dropped each
// other's live databases mid-test. That is a worse failure than the flakiness the
// per-file split fixed, and it is why the filter below is on `pg_stat_activity`
// rather than on age: a database with no connection has no owning process left, and
// one with a connection belongs to a run that is still going.
try {
  const idle = execFileSync(
    "psql",
    [
      admin.toString(),
      "-tAc",
      `SELECT d.datname FROM pg_database d
         WHERE d.datname LIKE 'sidestage_test_%'
           AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  )
    .toString()
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const d of idle) {
    // No FORCE: it was checked idle a moment ago, and if something connected in
    // between, the right answer is to leave it.
    execFileSync("psql", [admin.toString(), "-c", `DROP DATABASE IF EXISTS "${d}"`], { stdio: "ignore" });
  }
  if (idle.length) console.log(`[pretest] dropped ${idle.length} idle per-file database(s)`);
} catch (e) {
  // Not fatal. A run with leftovers is slower to read, not wrong.
  console.error(`[pretest] could not clean per-file databases: ${e.message}`);
}

// The catalogs are files, and one route writes to them. Without a copy, a test
// that closes a gap edits the fixture a reviewer is about to read.
const catalogs = process.env.TEST_CATALOGS_DIR || ".tmp/test-catalogs";
for (const dir of [catalogs, `${catalogs}-attach`]) {
  // The second copy is not redundancy. Test files run concurrently and several
  // of them boot an app that WRITES catalogs; a suite that only reads one was
  // failing with a 404 for a catalog that plainly exists. A writer that wants
  // its own directory says so with CATALOGS_DIR and finds it seeded here.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync("fixtures/catalogs", dir, { recursive: true });
}
