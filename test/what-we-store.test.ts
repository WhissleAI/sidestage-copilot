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

// ── the one table that survives a deletion and is not a person's words ──────
//
// `session_events` has no foreign key to `shows` on purpose (migration 030): an
// event about a session stays true after the session row is gone, including the
// attach that failed before any show existed. So it OUTLIVES a deletion, which
// makes it the third item in the privacy page's "things that outlive the session
// they came from" — a list that said two until 2026-09-28.
//
// Its safety rests entirely on one sentence in that migration: "`detail` carries
// COUNTS AND IDENTIFIERS ONLY — never a buyer's message, a draft, a transcript
// segment or a token." Nothing enforced it. A `detail: { text }` added in good
// faith would put a stranger's words in the one table that deleting their
// session does not empty, and the privacy page would be wrong in the direction
// that matters.

describe("the operational log keeps no one's words", () => {
  /** Key names that mean free text somebody said, or a credential. */
  const FORBIDDEN =
    /\b(text|message|comment|draft|reply|body|transcript|utterance|content|token|password|secret|prompt|answer|question)\s*:/i;

  /** Every `recordEvent({...})` in the tree, with its `detail` object. */
  function eventDetails(): { file: string; line: number; detail: string }[] {
    const out: { file: string; line: number; detail: string }[] = [];
    const walk = (dir: string): string[] =>
      readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : e.name.endsWith(".ts")
            ? [join(dir, e.name)]
            : [],
      );
    for (const rel of walk("src")) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      for (const m of src.matchAll(/recordEvent\(\s*\{/g)) {
        const obj = balanced(src, src.indexOf("{", m.index!));
        const at = obj.indexOf("detail:");
        if (at === -1) continue;
        out.push({
          file: rel,
          line: src.slice(0, m.index!).split("\n").length,
          detail: balanced(obj, obj.indexOf("{", at)),
        });
      }
    }
    return out;
  }

  /** The `{...}` beginning at `from`, brace-matched. */
  function balanced(src: string, from: number): string {
    let depth = 0;
    for (let i = from; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(from, i + 1);
    }
    return src.slice(from);
  }

  test("no event carries a field whose name means somebody's words", () => {
    const calls = eventDetails();
    // If this is 0 the scanner broke, not the risk went away.
    assert.ok(calls.length >= 5, `only found ${calls.length} recordEvent details to check`);
    const offenders = calls
      .filter((c) => FORBIDDEN.test(c.detail))
      .map((c) => `${c.file}:${c.line} — ${c.detail.replace(/\s+/g, " ").slice(0, 100)}`);
    assert.deepEqual(
      offenders,
      [],
      "session_events survives the deletion of the session it describes, so a person's words must " +
        "never reach it — see migration 030 and the privacy page's third 'outlives' item",
    );
  });

  test("and it is declared as outliving a session, in both places", () => {
    const sql = readFileSync(join(MIGRATIONS, "030_session_events.sql"), "utf8");
    assert.match(sql, /Deliberately NO foreign key/i, "the migration must say why it survives");
    assert.match(sql, /COUNTS AND IDENTIFIERS ONLY/i, "and state the rule the test above enforces");
  });
});
