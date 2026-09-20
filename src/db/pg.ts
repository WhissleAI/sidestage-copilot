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

export function db(): Pool {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: config.databaseUrl,
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
export async function migrate(p: Pool): Promise<void> {
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
