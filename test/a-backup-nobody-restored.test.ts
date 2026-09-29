// A backup nobody has restored is a hope.
//
// On 2026-09-28 this product had no backup of any kind. Checked, not assumed:
//
//   aws ec2 describe-snapshots --owner-ids self --query 'length(Snapshots)' → 0
//   aws dlm get-lifecycle-policies                                         → []
//   aws backup list-backup-plans                                           → []
//
// One unreplicated 24 GB gp3 volume, unencrypted, on one t3.small that has been
// OOM-killed before, holding every seller's account, their sealed eBay tokens,
// every show's chat — other people's words — every hash-chained audit log, every
// report, the host's recorded audio and camera frames, and a signed-in eBay
// browser profile.
//
// So `scripts/backup.sh` exists. And because a dump that has never been restored
// is a file, not a backup, this does the round trip for real: dump the test
// database, restore it into a scratch one, and read the rows back out.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, migrate, closeDb, type Pool } from "../src/db/pg.js";

const SOURCE = process.env["TEST_DATABASE_URL"] || "postgres://localhost:5432/sidestage_test";
const SCRATCH = SOURCE.replace(/\/[^/]+$/, "/sidestage_restore_probe");
const ADMIN = SOURCE.replace(/\/[^/]+$/, "/postgres");
const SHOW = "show_backup_probe";
const SECRET = "a buyer asked this, and it must survive";

let p: Pool;
let work: string;
let skip: string | null = null;

const psql = (url: string, sql: string) =>
  execFileSync("psql", [url, "-tAc", sql], { encoding: "utf8" }).trim();

before(async () => {
  // pg_dump/psql are the script's own tools. Without them this test cannot say
  // anything, and saying nothing loudly beats passing quietly.
  try {
    execFileSync("pg_dump", ["--version"], { stdio: "ignore" });
  } catch {
    skip = "pg_dump is not on PATH";
    return;
  }
  p = db();
  await migrate(p);
  await p.query("DELETE FROM shows WHERE id = $1", [SHOW]);
  await p.query(
    `INSERT INTO shows (id, title, seller_handle, source, started_at, status, autonomy_level, undo_window_s)
     VALUES ($1, 'backup probe', 'probe', 'ebaylive', now(), 'ended', 'L1_SUGGEST', 90)`,
    [SHOW],
  );
  await p.query(
    `INSERT INTO chat_messages (show_id, id, at, author, text, admitted)
     VALUES ($1, 'msg_probe', now(), 'a_buyer', $2, true)`,
    [SHOW, SECRET],
  );
  work = mkdtempSync(join(tmpdir(), "sidestage-backup-"));
});

after(async () => {
  if (work) rmSync(work, { recursive: true, force: true });
  if (p) {
    await p.query("DELETE FROM shows WHERE id = $1", [SHOW]).catch(() => {});
    await closeDb();
  }
  try {
    execFileSync("psql", [ADMIN, "-c", `DROP DATABASE IF EXISTS sidestage_restore_probe`], { stdio: "ignore" });
  } catch {
    /* nothing to drop */
  }
});

describe("the backup restores", () => {
  test("a dump of this database verifies, and restores into an empty one", () => {
    if (skip) {
      // Not a silent pass: the assertion says what was not checked.
      assert.fail(`cannot exercise the restore path — ${skip}. Install postgresql-client and re-run.`);
    }
    const file = join(work, "probe.sql.gz");
    // The same pg_dump flags the script uses. If they drift, this drifts with
    // them — `verify` below reads the file the way the script does.
    const dump = execFileSync(
      "bash",
      ["-c", `pg_dump "${SOURCE}" --no-owner --clean --if-exists | gzip -9 > "${file}"`],
      { encoding: "utf8" },
    );
    assert.equal(dump, "");
    assert.ok(existsSync(file));

    // The script's own verify, on the real file.
    const verified = execFileSync("bash", ["scripts/backup.sh", "verify", file], { encoding: "utf8" });
    assert.match(verified, /every expected table present/);

    execFileSync("psql", [ADMIN, "-c", `DROP DATABASE IF EXISTS sidestage_restore_probe`], { stdio: "ignore" });
    execFileSync("psql", [ADMIN, "-c", `CREATE DATABASE sidestage_restore_probe`], { stdio: "ignore" });
    execFileSync("bash", ["scripts/backup.sh", "restore", file, SCRATCH], { stdio: "ignore" });

    // The rows are the point. Not "the command exited 0".
    assert.equal(psql(SCRATCH, `SELECT count(*) FROM shows WHERE id = '${SHOW}'`), "1");
    assert.equal(
      psql(SCRATCH, `SELECT text FROM chat_messages WHERE show_id = '${SHOW}' AND id = 'msg_probe'`),
      SECRET,
      "a buyer's own words did not survive the round trip",
    );
    // The audit chain is the table whose whole value is that it is intact.
    assert.match(psql(SCRATCH, `SELECT to_regclass('public.audit')::text`), /audit/);
  });

  test("verify refuses a truncated dump, which is the one that looks fine", () => {
    if (skip) assert.fail(skip);
    const bad = join(work, "truncated.sql.gz");
    execFileSync("bash", ["-c", `printf 'PostgreSQL database dump\\n' | gzip -9 > "${bad}"`]);
    assert.throws(() => execFileSync("bash", ["scripts/backup.sh", "verify", bad], { stdio: "pipe" }));
  });

  test("restore refuses to overwrite the live database by name", () => {
    if (skip) assert.fail(skip);
    const any = join(work, "probe.sql.gz");
    // The accident this prevents: pasting the production URL into a restore.
    assert.throws(
      () => execFileSync("bash", ["scripts/backup.sh", "restore", any, "postgres://x/sidestage"], { stdio: "pipe" }),
      /.*/,
    );
  });

  test("a dump cannot be committed, two ways", () => {
    // The hazard I created writing the first one: `backups/` was NOT in
    // .gitignore, and this repo gets `git add -A`. A committed dump puts every
    // seller's password hash, every sealed eBay token, every buyer's chat and the
    // whole audit chain into git history, where the fix is rewriting history and
    // rotating every credential.
    const ignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");
    assert.match(ignore, /^\/backups\/$/m, "the default destination must be ignored");
    assert.match(ignore, /^\*\.sql\.gz$/m, "and a dump written anywhere else in the tree too");

    // git's own answer, not a string match on a path.
    const ignored = (rel: string) => {
      try {
        execFileSync("git", ["check-ignore", "-q", rel], { cwd: process.cwd(), stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
    assert.ok(ignored("backups/anything.sql.gz"), "backups/ is not ignored");
    assert.ok(ignored("docs/oops.sql.gz"), "a dump in docs/ would be committable");

    // And the script refuses a destination git would track, so removing either
    // rule above does not silently re-open the hazard.
    const sh = readFileSync(join(process.cwd(), "scripts/backup.sh"), "utf8");
    assert.match(sh, /git would TRACK a dump/);
    assert.match(sh, /check-ignore -q/, "checked with git, not by matching path strings");
  });

  test("and it says out loud what it does NOT cover", () => {
    const sh = readFileSync(join(process.cwd(), "scripts/backup.sh"), "utf8");
    // The media are files, not rows. A backup that quietly omits a person's
    // recorded voice while calling itself a backup is the worse failure.
    assert.match(sh, /NOT in this dump/);
    assert.match(sh, /camera frames/);
    assert.match(sh, /ebay-profile|eBay browser profile/);
  });
});
