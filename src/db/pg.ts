// Postgres handle, migration runner, and the transaction helper the write path
// depends on.
//
// The SQLite era is over, and the reason is not fashion. A show-per-file store
// gave tenancy for free and cost nothing while one process owned everything —
// but accounts, settings and cross-show analytics all want shared, queryable,
// multi-process state, and porting them twice is waste (docs/ROADMAP.md §2.1).
//
// What had to be preserved through the move:
//
//   * ONE transaction around "mutate the listing" and "record the idempotency
//     key". That pairing is what makes a retried commit a no-op instead of a
//     double-apply, and it is the whole of the two-phase-commit claim.
//   * Tenancy that cannot be forgotten. A file boundary enforced itself; a
//     `show_id` column does not. `Repo` is constructed with a show id and binds
//     it into every statement, so no call site is ever trusted to remember it.

import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const here = dirname(fileURLToPath(import.meta.url));

export type Pool = pg.Pool;
/** Either the pool or a dedicated client inside a transaction. Every repo
 *  method takes this, so the same code runs inside and outside a transaction. */
export type Queryable = Pick<pg.Pool, "query"> | pg.PoolClient;

// Integer columns come back as JS numbers, not strings. node-postgres returns
// int8/numeric as strings to avoid precision loss, which is right in general and
// wrong here: every money column is integer CENTS and every comparison in the
// guards is numeric. A price that arrives as "41200" silently fails `===`.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

let pool: Pool | null = null;

/**
 * One database per test FILE, so the suite cannot race itself.
 *
 * Node's runner gives each test file its own process and runs the files in
 * parallel; every one of them used the same `sidestage_test`. Measured
 * 2026-09-28: three different tests failed on three consecutive parallel runs
 * while `--test-concurrency=1` passed 865/865 twice. One of those three was a
 * genuine bug hiding in the noise, and finding it took an hour of "is this my
 * change?" — a suite that lies a third of the time is worth less than a smaller
 * suite that does not.
 *
 * The file's own path is in `process.argv` under `--test`, so the database is
 * named after the file that owns it: `sidestage_test_decision_test` is readable
 * in `\l` and in an error, which `..._pid_41290` would not be. The pid is
 * appended because two runs can overlap.
 *
 * Costs 151 ms per file to create and migrate — measured, and the reason this is
 * a database rather than a schema or a template: `CREATE DATABASE ... TEMPLATE`
 * measured the same 153 ms AND fails while anything is connected to the
 * template, which is machinery bought for nothing.
 *
 * Outside NODE_ENV=test this returns `config.databaseUrl` untouched.
 */
function connectionString(): string {
  if (process.env["NODE_ENV"] !== "test") return config.databaseUrl;
  const owner = process.argv.find((a) => /\.(test|eval)\.ts$/.test(a));
  if (!owner) return config.databaseUrl;
  const slug = owner
    .split("/")
    .pop()!
    .replace(/\.(test|eval)\.ts$/, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase()
    // Postgres truncates an identifier at 63 bytes, and the suffix must survive.
    .slice(0, 40);
  return config.databaseUrl.replace(/\/[^/]+$/, `/sidestage_test_${slug}_${process.pid}`);
}

/** The database this process is using — named so a failure can say which. */
export const databaseName = (): string => connectionString().split("/").pop()!;

export function db(): Pool {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: connectionString(),
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  // A pool error with no listener is an uncaught exception that takes the
  // process down — and the common cause is Postgres restarting underneath us,
  // which the pool recovers from on its own.
  pool.on("error", (e) => console.warn(`  postgres pool: ${e.message}`));
  return pool;
}

export async function closeDb(): Promise<void> {
  const p = pool;
  pool = null;
  await p?.end().catch(() => {});
}

/**
 * Run `fn` inside a single transaction on a single client.
 *
 * Callers pass the client down to every repo method they touch, which is what
 * keeps the listing mutation and the idempotency insert in one atomic unit.
 */
export async function tx<T>(p: Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await p.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/**
 * One migrator at a time, whoever is asking.
 *
 * An arbitrary constant, and it only has to be stable: `pg_advisory_lock` is a
 * lock on a NUMBER, held for the session, released explicitly.
 */
const MIGRATION_LOCK = 0x51d3_57a6;

/**
 * Apply pending migrations, tracked in `schema_migrations`.
 *
 * Serialised across every connection to this database, because the read of
 * `schema_migrations` and the writes that follow it are not atomic together.
 * Two processes that call this at the same moment both read the same `done`
 * set, both decide the same file is pending, and both try to apply it: one
 * wins, and the other's transaction dies on the primary key of the ledger
 * insert — taking its whole boot, or its whole test file, with it. Concurrent
 * `ALTER TABLE` on one table can also simply deadlock.
 *
 * That is a rare, timing-dependent, unreproducible failure, which is exactly
 * what it was reported as: two separate runs of the suite each saw one flake
 * that nobody could reproduce. Every test FILE is its own child process, the
 * runner starts as many as there are cores, and each one calls `migrate()`
 * against the shared test database. In production it is the same hazard one
 * size up — two containers booting together, which is one `docker compose up`
 * away from being real.
 *
 * Each file still runs in its own transaction with its ledger insert inside
 * it, so a half-applied schema change remains impossible. This only makes sure
 * one process is doing it.
 */
/** Once per process, however many callers ask. */
let creating: Promise<void> | null = null;

/**
 * `CREATE DATABASE` for this process's own test database.
 *
 * Only under NODE_ENV=test, and only for a name this module derived — it will not
 * create `config.databaseUrl`, so a typo in DATABASE_URL still fails loudly
 * instead of quietly standing up an empty database and migrating it.
 *
 * MEMOISED, because a file can call `migrate()` twice — `retrieval.eval.ts` does,
 * through two `rig()`s — and two concurrent creates of the same name do not fail
 * the way the obvious guess says. `42P04` is "database already exists" and is what
 * a SEQUENTIAL second attempt gets; a CONCURRENT one surfaces as `23505`, a unique
 * violation on `pg_database_datname_index`, because both statements got past the
 * existence check before either inserted. The promise makes that impossible within
 * a process; both codes are tolerated for the case across processes.
 */
async function createTestDatabaseIfMissing(): Promise<void> {
  if (process.env["NODE_ENV"] !== "test") return;
  const url = connectionString();
  const name = url.split("/").pop()!;
  if (!name.startsWith("sidestage_test_")) return;
  creating ??= (async () => {
    const admin = new pg.Pool({ connectionString: url.replace(/\/[^/]+$/, "/postgres"), max: 1 });
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      // 42P04 already exists · 23505 two creates raced and this one lost.
      if (code !== "42P04" && code !== "23505") throw e;
    } finally {
      await admin.end().catch(() => {});
    }
  })();
  await creating;
}

export async function migrate(p: Pool): Promise<void> {
  // Create the database first, if this is a test process that owns its own.
  //
  // Every test file that touches Postgres already awaits `migrate()` — directly
  // or through `rig()` — so this is the one place that covers all of them, and
  // no test file had to change.
  await createTestDatabaseIfMissing();
  const c = await p.connect();
  try {
    // Blocks rather than failing: a second booter should wait a moment and
    // then find there is nothing to do, not refuse to start.
    await c.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const dir = join(here, "pg_migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const done = new Set(
      (await c.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(dir, f), "utf8");
      // Each migration is its own transaction: a half-applied schema change is
      // worse than a failed boot, because the next boot cannot tell the difference.
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      }
      console.log(`  migrated ${f}`);
    }
  } finally {
    // Released explicitly AND by the connection going back to the pool being
    // insufficient — an advisory lock is held for the session, and a pooled
    // client's session outlives the release.
    await c.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    c.release();
  }
}
