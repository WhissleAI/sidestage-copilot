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
