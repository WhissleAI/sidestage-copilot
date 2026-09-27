import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// What the product writes down about a person, pinned.
//
// The privacy page (live-commerce-copilot, LegalPage.tsx) describes this in
// English, per surface, and it drifted: it said Twitch's timestamp and message
// id were dropped and that Reddit's permalink and posting time were "read and
// not stored". All four are persisted — `chat_messages.at`, `chat_messages.id`
// and `reply_proposals.url`. A privacy page that UNDER-states what is kept is
// the wrong direction to be wrong in, and nothing was watching.
//
// English cannot be checked by a test. A schema can. So this pins the columns
// that hold anything a person said or is identified by; adding one fails here,
// and the failure names the page that has to be updated with it.

const MIGRATIONS = "src/db/pg_migrations";

function columnsOf(table: string): Set<string> {
  const cols = new Set<string>();
  for (const f of readdirSync(MIGRATIONS).sort()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    const create = sql.match(
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i"),
    );
    if (create) {
      for (const line of create[1]!.split("\n")) {
        const m = line.trim().match(/^([a-z_]+)\s+[A-Z]/);
        if (m && !/^(PRIMARY|UNIQUE|FOREIGN|CONSTRAINT|CHECK)$/i.test(m[1]!)) cols.add(m[1]!);
      }
    }
    for (const m of sql.matchAll(
      new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS\\s+([a-z_]+)`, "gi"),
    )) {
      cols.add(m[1]!);
    }
  }
  return cols;
}

describe("what we store about a person is declared, not discovered", () => {
  test("chat_messages holds exactly these columns", () => {
    assert.deepEqual(
      [...columnsOf("chat_messages")].sort(),
      // `author` and `text` are the person. `at` and `id` are the PLATFORM's
      // own send time and message id — both kept, and the privacy page now
      // says so. `thread_id` / `parent_id` are the platform's fullnames.
      ["admitted", "at", "author", "drop_reason", "id", "intent", "parent_id", "show_id", "speech_act", "text", "thread_id"],
      "a new column here changes what the privacy page must say — update LegalPage.tsx with it",
    );
  });

  test("reply_proposals keeps the permalink, and the page says so", () => {
    const cols = columnsOf("reply_proposals");
    assert.ok(cols.has("url"), "the permalink column");
    assert.ok(cols.has("room"), "which room bound the answer");
  });

  test("a session's chat goes when the session goes", () => {
    const sql = readFileSync(join(MIGRATIONS, "004_session_record.sql"), "utf8");
    // The privacy page promises deletion is complete. This is the mechanism.
    assert.match(sql, /chat_messages[\s\S]*?REFERENCES shows\(id\) ON DELETE CASCADE/);
  });
});
