// SQLite handle + migration runner. Synchronous by design: better-sqlite3 is
// faster than the async drivers for this workload and, more importantly, lets
// the action executor wrap "mutate the listing" and "record the idempotency
// key" in ONE transaction — which is what makes a retried commit safe.

import Database from "better-sqlite3";
import { readFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const here = dirname(fileURLToPath(import.meta.url));

export type DB = Database.Database;

let handle: DB | null = null;

export function db(): DB {
  if (handle) return handle;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  handle = new Database(config.dbPath);
  handle.pragma("journal_mode = WAL");
  handle.pragma("foreign_keys = ON");
  migrate(handle);
  return handle;
}

/**
 * Open (and migrate) a database at an explicit path. Each watched live show gets
 * its own file under data/shows/, so a show is a real tenant boundary rather than
 * a column everything has to remember to filter on.
 */
export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const d = new Database(path);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  migrate(d);
  return d;
}

/** Open an isolated in-memory database. Tests and the bench use this so they
 *  never touch the developer's real show data. */
export function memoryDb(): DB {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  migrate(d);
  return d;
}

/**
 * Apply pending migrations, tracked in `schema_migrations`.
 *
 * The tracking table is not decoration: migration 001 is written with
 * `CREATE TABLE IF NOT EXISTS` and is safe to re-run, but 002 uses
 * `ALTER TABLE ADD COLUMN`, which SQLite has no `IF NOT EXISTS` form for. Re-running
 * the folder blindly throws "duplicate column name" on the second boot.
 */
function migrate(d: DB): void {
  d.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    (d.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const dir = join(here, "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    const record = () =>
      d.prepare("INSERT OR REPLACE INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(file, new Date().toISOString());
    try {
      d.transaction(() => {
        d.exec(sql);
        record();
      })();
    } catch (e) {
      // A database created before this tracking table existed already has these
      // columns. Treat "already there" as applied and record it, rather than
      // making every developer delete their data directory.
      if (/duplicate column name|already exists/i.test((e as Error).message)) {
        record();
        continue;
      }
      throw e;
    }
  }
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}
