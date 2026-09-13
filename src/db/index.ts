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

/** Open an isolated in-memory database. Tests and the bench use this so they
 *  never touch the developer's real show data. */
export function memoryDb(): DB {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  migrate(d);
  return d;
}

function migrate(d: DB): void {
  const dir = join(here, "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    d.exec(readFileSync(join(dir, file), "utf8"));
  }
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}
