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

/** Apply pending migrations, tracked in `schema_migrations`. */
export async function migrate(p: Pool): Promise<void> {
  await p.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const dir = join(here, "pg_migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set(
    (await p.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    // Each migration is its own transaction: a half-applied schema change is
    // worse than a failed boot, because the next boot cannot tell the difference.
    await tx(p, async (c) => {
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
    });
    console.log(`  migrated ${f}`);
  }
}
