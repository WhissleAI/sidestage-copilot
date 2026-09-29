// Nine audit writes were awaited. Three were dropped. Guess which three.
//
// Every action write (`actions/executor.ts`, five of them) and the autonomy
// change awaited `audit.append`. The three that did not were the reply path:
// `reply_blocked`, the auto-send, and the seller's own send — the entries that
// record what was said to a buyer. `append` is async and the promise was
// discarded, not even `void`-ed. Three separate costs:
//
//  a crash        there was no `unhandledRejection` handler, so Node's default
//                 since v15 applied: throw. A failed INSERT on this path — Postgres
//                 restarting, a lock timeout, the container stopping mid-write —
//                 took the whole backend down, on a 2 GB box that has been
//                 OOM-killed before.
//  a silent loss  if it did not crash: proposal marked sent, counter
//                 incremented, seller told it went, no ledger entry. The ledger
//                 exists to answer what this copilot and this seller actually
//                 did.
//  a flaky test   `room-rules.test.ts` slept 100 ms hoping the write landed. It
//                 failed about one run in three under parallel load, and the
//                 sleep is gone now: 198 ms → 33 ms, and deterministic.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const walk = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );

describe("every ledger write is awaited", () => {
  test("no call to audit.append discards its promise", () => {
    const dropped: string[] = [];
    let seen = 0;
    for (const rel of walk("src")) {
      const src = read(rel);
      for (const m of src.matchAll(/^[^\n]*\baudit\.append\(/gm)) {
        seen++;
        const stmt = m[0];
        // Awaited, or returned, or handed to something that handles it.
        if (!/\b(await|return)\b|\.then\(|\.catch\(/.test(stmt)) {
          dropped.push(`${rel}:${src.slice(0, m.index!).split("\n").length} — ${stmt.trim().slice(0, 70)}`);
        }
      }
    }
    // If this is 0 the scanner broke, not the writes went away.
    assert.ok(seen >= 10, `only found ${seen} audit.append call sites`);
    assert.deepEqual(
      dropped,
      [],
      "an unawaited audit.append is an unhandled rejection with no handler installed — it crashes " +
        "the process, and when it does not, it loses the entry. Await it, or route it through " +
        "`Pipeline.record` which decides whether the failure is fatal",
    );
  });

  test("the reply path decides, per entry, whether a lost ledger write is fatal", () => {
    const src = read("src/pipeline/pipeline.ts");
    // `reply_sent` both ways is required: an auto-send has no human in the loop,
    // and a seller must not be told a reply went if the ledger does not say so.
    for (const m of src.matchAll(/this\.record\(\s*\n?\s*"(reply_sent|reply_blocked)"[\s\S]{0,700}?\n\s*(true|false),\s*\n?\s*\)/g)) {
      const [, kind, required] = m;
      assert.equal(
        required,
        kind === "reply_sent" ? "true" : "false",
        `${kind} is marked required=${required}; a lost reply_sent must fail, a lost reply_blocked must not`,
      );
    }
    // And the shape above must actually have matched something.
    assert.ok(
      [...src.matchAll(/this\.record\(/g)].length === 3,
      "expected exactly three reply-path ledger writes",
    );
  });

  test("a failed write is reported, not swallowed into nothing", () => {
    const src = read("src/pipeline/pipeline.ts");
    const rec = src.slice(src.indexOf("private async record("));
    const body = rec.slice(0, rec.indexOf("\n  }"));
    // Both channels: the log an operator greps, and the session_events row the
    // report reads. A `catch {}` here would turn a lost ledger entry into
    // nothing at all, which is the failure this whole file is about.
    assert.match(body, /logWarn\("audit\.append_failed"/);
    assert.match(body, /kind: "audit\.append_failed"/);
    assert.match(body, /if \(required\) throw e;/);
  });

  test("and no test papers over it with a sleep", () => {
    // The sleep was the tell. It was in the suite for as long as the bug was.
    const offenders: string[] = [];
    for (const f of readdirSync(join(root, "test"))) {
      // Comments are blanked and this file excludes itself: both describe the
      // pattern, and a scanner that flags its own prose gets deleted.
      if (!f.endsWith(".ts") || f === "the-ledger-is-not-optional.test.ts") continue;
      const src = read(join("test", f))
        .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
        .replace(/\/\/[^\n]*/g, (c) => " ".repeat(c.length));
      for (const m of src.matchAll(/^[^\n]*setTimeout[^\n]*\n(?:[^\n]*\n){0,3}?[^\n]*audit[^\n]*$/gm)) {
        offenders.push(`test/${f} — ${m[0].split("\n")[0]!.trim().slice(0, 60)}`);
      }
    }
    assert.deepEqual(offenders, [], "a sleep before reading the audit log means the write is not awaited");
  });
});

// ── and the class, not just the three instances ──────────────────────────────
//
// Awaiting those three closes the bugs I found. It does not close the shape of
// them: Node throws on an unhandled rejection by default (v15+), so the NEXT
// dropped promise anywhere in this process ends it. That default is right for a
// script and wrong here — one container serves the whole site, a show is on air
// inside it, and `restart: unless-stopped` brings it back in seconds having lost
// the watcher, the proposals held in memory and the host audio session.

describe("a dropped promise does not end the show", () => {
  const index = read("src/index.ts");

  test("the process installs a handler, before anything else runs", () => {
    assert.match(index, /process\.on\("unhandledRejection"/);
    // Before the port opens and before a migration runs: a rejection during
    // startup is exactly when there is no handler yet.
    const call = index.indexOf("keepServingThroughDroppedPromises();");
    const mainAt = index.indexOf("async function main(): Promise<void> {");
    assert.ok(call > mainAt, "it must be called inside main");
    assert.ok(
      call < index.indexOf("const problems = checkConfig()"),
      "it must be installed before the first work main does",
    );
  });

  test("it reports on both channels rather than swallowing", () => {
    const fn = index.slice(index.indexOf("function keepServingThroughDroppedPromises"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.match(body, /logError\("process\.unhandled_rejection"/);
    assert.match(body, /kind: "process\.unhandled_rejection"/);
    assert.match(body, /level: "error"/, "it belongs in the report, not only the log");
    // The stack is the whole value of the line — without it, "something
    // rejected somewhere" is not actionable.
    assert.match(body, /stack/);
  });

  test("it does not also catch uncaughtException", () => {
    // Different failure: an uncaught exception means the process state is
    // unknown, and continuing is worse than restarting.
    //
    // Comments blanked, because index.ts explains this distinction in prose and
    // a scanner that flags its own rationale is a scanner somebody deletes.
    const code = index
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, (c) => " ".repeat(c.length));
    assert.ok(!/uncaughtException/.test(code), "an uncaught exception must still end the process");
  });
});
