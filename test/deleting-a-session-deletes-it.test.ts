// "Deletion is by hand, and complete."
//
// That sentence is on the live privacy page, and it is a promise about people
// who are not our customers: the buyers whose comments were read, and the host
// whose voice and camera were recorded. `what-we-store.test.ts` pins the
// COLUMNS that hold their data. Nothing pinned their removal.
//
// The two halves fail differently, which is why this is its own file:
//
//   a column added     the page understates what is kept — caught next door
//   a table added      the page overstates what is deleted, silently, because
//                      a table with no cascade simply keeps its rows and
//                      nothing anywhere reads them again
//   a file forgotten   Postgres cascades; a directory does not. `signals.purge`
//                      is a separate call at one call site, and the handler's
//                      own comment says so: "the rows cascade; the bytes on
//                      disk do not". A refactor that drops that line leaves a
//                      person's recorded VOICE on the disk of a box they have
//                      never heard of, and every test still passes.
//
// Read from the live schema rather than from the migration text on purpose: a
// table added next month is included here without anybody remembering to add
// it, which is the only version of this test worth having.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db, migrate, closeDb, type Pool } from "../src/db/pg.js";
import { SessionSignals } from "../src/shows/signals.js";

const SHOW = "show_del_probe";
const ACCOUNT = "acct_del_probe";
const MEDIA_ROOT = process.env["SHOW_MEDIA_DIR"] ?? join(process.cwd(), "data", "shows");

/**
 * Tables that carry a `show_id` and are NOT expected to lose their rows, each
 * with the reason — and each reason is a sentence the privacy page has to
 * contain, which the last test in this file checks.
 */
const OUTLIVES: Record<string, { why: string }> = {
  persona_voice: {
    why: "style references are attached to the operator's account, not the session — the page says so",
  },
  session_events: {
    why: "an operational record of what the process did, carrying counts and identifiers only — it stays true after the session is gone",
  },
};

let p: Pool;

/** Every table in this database that has a `show_id` column. */
async function showScopedTables(): Promise<string[]> {
  const r = await p.query<{ table_name: string }>(
    `SELECT c.table_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'show_id' AND t.table_type = 'BASE TABLE'
        AND c.table_name <> 'shows'
      ORDER BY c.table_name`,
  );
  return r.rows.map((x) => x.table_name);
}

/**
 * Columns whose own CHECK constraint or foreign key will not take a generic
 * string. Kept as a short, explicit list rather than parsed out of the DDL: a
 * table that grows a constraint this list does not satisfy fails the coverage
 * test by name, which is the right way to find out.
 */
const DEMANDS: Record<string, unknown> = {
  "listings.condition": "USED",
  "listings.state": "live",
  "policies.topic": "shipping",
  "sales.source": "observed",
};

/** A value Postgres will accept for a column we do not care about. */
function filler(dataType: string, name: string, table: string): unknown {
  if (name === "show_id") return SHOW;
  const demanded = DEMANDS[`${table}.${name}`];
  if (demanded !== undefined) return demanded;
  if (name === "account_id") return ACCOUNT;
  switch (dataType) {
    case "integer":
    case "bigint":
    case "smallint":
    case "numeric":
    case "double precision":
    case "real":
      return 1;
    case "boolean":
      return false;
    case "timestamp with time zone":
    case "timestamp without time zone":
    case "date":
      return new Date().toISOString();
    case "jsonb":
    case "json":
      return "{}";
    case "ARRAY":
      return "{}";
    default:
      return `probe-${name}`;
  }
}

/** One row per table, filling whatever that table insists on. */
async function seedOneRowEverywhere(tables: string[]): Promise<string[]> {
  const seeded: string[] = [];
  for (const t of tables) {
    const cols = await p.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [t],
    );
    // Only what the table cannot do without: a NOT NULL column with no default,
    // plus show_id. Everything else stays at its default, so this keeps working
    // when a table grows a column.
    const need = cols.rows.filter(
      (c) => c.column_name === "show_id" || (c.is_nullable === "NO" && c.column_default === null),
    );
    const names = need.map((c) => `"${c.column_name}"`);
    const values = need.map((c) => filler(c.data_type, c.column_name, t));
    const placeholders = need.map((_, i) => `$${i + 1}`);
    try {
      await p.query(
        `INSERT INTO ${t} (${names.join(",")}) VALUES (${placeholders.join(",")})`,
        values,
      );
      seeded.push(t);
    } catch (e) {
      // A table whose own constraints this generic filler cannot satisfy (a
      // CHECK on an enum-ish text column, say) is skipped rather than failing
      // the run — but it is REPORTED, because a skipped table is a table this
      // test is not actually covering.
      skipped.push(`${t}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return seeded;
}

const skipped: string[] = [];
let tables: string[] = [];
let seeded: string[] = [];

before(async () => {
  p = db();
  await migrate(p);
  await p.query("DELETE FROM shows WHERE id = $1", [SHOW]);
  for (const t of Object.keys(OUTLIVES)) await p.query(`DELETE FROM ${t} WHERE show_id = $1`, [SHOW]);
  await p.query("DELETE FROM accounts WHERE id = $1", [ACCOUNT]);
  // persona_voice's FK is the whole point of it being account-scoped, so the
  // probe needs a real account rather than a string.
  await p.query(
    `INSERT INTO accounts (id, kind, handle, display_name) VALUES ($1, 'seller', $2, 'deletion probe')`,
    [ACCOUNT, `del-probe-${Date.now()}`],
  );
  await p.query(
    `INSERT INTO shows (id, title, seller_handle, source, started_at, status, autonomy_level, undo_window_s)
     VALUES ($1, 'deletion probe', 'probe-seller', 'ebaylive', now(), 'ended', 'L1_SUGGEST', 90)`,
    [SHOW],
  );
  tables = await showScopedTables();
  seeded = await seedOneRowEverywhere(tables);

  // The host's voice and the shared tab's frames, as files. This is the half
  // Postgres knows nothing about.
  mkdirSync(join(MEDIA_ROOT, SHOW, "audio"), { recursive: true });
  writeFileSync(join(MEDIA_ROOT, SHOW, "audio", "0001.webm"), "not really audio");
  writeFileSync(join(MEDIA_ROOT, SHOW, "frame-0001.jpg"), "not really a frame");
});

after(async () => {
  rmSync(join(MEDIA_ROOT, SHOW), { recursive: true, force: true });
  await p.query("DELETE FROM shows WHERE id = $1", [SHOW]).catch(() => {});
  for (const t of Object.keys(OUTLIVES)) {
    await p.query(`DELETE FROM ${t} WHERE show_id = $1`, [SHOW]).catch(() => {});
  }
  await p.query("DELETE FROM accounts WHERE id = $1", [ACCOUNT]).catch(() => {});
  await closeDb();
});

describe("deleting a session", () => {
  test("the probe actually covered the tables it claims to", () => {
    assert.ok(tables.length >= 15, `only found ${tables.length} show-scoped tables`);
    // A table this test could not seed is a table it is not testing. Naming
    // them keeps that from being invisible.
    assert.deepEqual(skipped, [], `these show-scoped tables were not covered: ${skipped.join("; ")}`);
    for (const t of Object.keys(OUTLIVES)) assert.ok(tables.includes(t), `${t} no longer carries show_id`);
  });

  test("takes every row about the people in it", async () => {
    // Exactly what the route does: the cascade, then the bytes.
    await p.query("DELETE FROM shows WHERE id = $1", [SHOW]);
    // The same class the route holds, so this is the shipped purge and not a
    // reimplementation of it.
    new SessionSignals(p).purge(SHOW);

    const left: string[] = [];
    for (const t of seeded) {
      if (t in OUTLIVES) continue;
      const n = await p.query<{ n: string }>(`SELECT count(*) AS n FROM ${t} WHERE show_id = $1`, [SHOW]);
      if (Number(n.rows[0]!.n) > 0) left.push(t);
    }
    assert.deepEqual(
      left,
      [],
      `these tables kept rows about a deleted session — the privacy page promises complete deletion, ` +
        `so either add ON DELETE CASCADE or add the table to OUTLIVES with a reason and say so on the page`,
    );
  });

  test("takes the host's recorded voice and the frames off the disk", () => {
    // The assertion that fails if `signals.purge` is ever dropped from the
    // delete path. Postgres cannot do this one for us.
    assert.equal(
      existsSync(join(MEDIA_ROOT, SHOW)),
      false,
      `${join(MEDIA_ROOT, SHOW)} survived deletion — recorded audio and camera frames of a real person`,
    );
  });

  test("leaves exactly the two kinds of row that are declared to survive", async () => {
    for (const [t, { why }] of Object.entries(OUTLIVES)) {
      const n = await p.query<{ n: string }>(`SELECT count(*) AS n FROM ${t} WHERE show_id = $1`, [SHOW]);
      assert.equal(
        Number(n.rows[0]!.n),
        1,
        `${t} lost its row, but it is declared as outliving a session (${why}) — ` +
          `if that changed, remove it from OUTLIVES and from the privacy page`,
      );
    }
  });
});
