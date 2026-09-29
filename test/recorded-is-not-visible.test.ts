// `session_events` had five writers and no reader.
//
// Migration 030 created it so that "it stopped answering mid-show" would have an
// answer other than asking the seller what they saw. Five things write to it:
//
//   watcher.gave_up              twenty reloads spent, the show permanently mute
//   listen.*                     an audio session cut, and its stall count
//   audit.append_failed          a ledger write that did not land
//   process.unhandled_rejection  a dropped promise that no longer ends the process
//   client.panel / client.route  a console panel that stopped drawing
//
// `showEvents()` was called only from `test/observability.test.ts`. No route, no
// report, no screen. Two indexes were built for readers that did not exist:
// `idx_session_events_show` for "what happened to this show, in order" and
// `idx_session_events_kind` for "has any watcher given up today".
//
// Three of those five writers are mine, added within a day of each other, and I
// checked the wrong thing each time: that the failure was recorded. Recorded is
// not visible.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db, migrate, closeDb, type Pool } from "../src/db/pg.js";
import { buildApp } from "../src/api/server.js";
import { Accounts } from "../src/auth/accounts.js";
import { recordEvent, useEventStore } from "../src/obs/events.js";

let app: Awaited<ReturnType<typeof buildApp>>["app"];
let p: Pool;
let mine: Record<string, string>;
let theirs: Record<string, string>;
const MY_SHOW = "show_events_mine";
const THEIR_SHOW = "show_events_theirs";

const get = (url: string, headers: Record<string, string>) =>
  app.inject({ method: "GET", url, headers }) as unknown as Promise<{
    statusCode: number;
    json: () => Record<string, unknown>;
  }>;

async function showFor(id: string, owner: string): Promise<void> {
  await p.query(
    `INSERT INTO shows (id, owner_account_id, title, seller_handle, source, started_at, status,
                        autonomy_level, undo_window_s)
     VALUES ($1, $2, 'events probe', 'probe', 'ebaylive', now()::text, 'ended', 'L1_SUGGEST', 90)`,
    [id, owner],
  );
}

before(async () => {
  p = db();
  await migrate(p);
  useEventStore(p);
  ({ app } = await buildApp());
  const a = new Accounts(p);
  const s1 = await a.register(`ev-mine-${process.pid}@invalid.test`, "a-long-enough-password", "mine");
  const s2 = await a.register(`ev-theirs-${process.pid}@invalid.test`, "a-long-enough-password", "theirs");
  mine = { authorization: `Bearer ${s1.token}` };
  theirs = { authorization: `Bearer ${s2.token}` };
  await showFor(MY_SHOW, s1.account.id);
  await showFor(THEIR_SHOW, s2.account.id);

  await recordEvent({ showId: MY_SHOW, kind: "watcher.gave_up", level: "error", detail: { reloads: 20 } });
  await recordEvent({ showId: MY_SHOW, kind: "client.panel", level: "error", detail: { where: "Buyer chat" } });
  await recordEvent({ showId: THEIR_SHOW, kind: "watcher.gave_up", level: "error", detail: { reloads: 20 } });
  // No show at all: a boot, or an attach that failed before a show row existed.
  await recordEvent({ kind: "process.unhandled_rejection", level: "error", detail: { err: "boom" } });
});

after(async () => {
  await app?.close().catch(() => {});
  await closeDb();
});

describe("what the system did during a session is readable", () => {
  test("the per-show timeline answers 'why did it stop answering'", async () => {
    const r = await get(`/api/shows/${MY_SHOW}/events`, mine);
    assert.equal(r.statusCode, 200);
    const kinds = (r.json()["events"] as { kind: string }[]).map((e) => e.kind);
    assert.ok(kinds.includes("watcher.gave_up"), "the sharpest failure in the product must be readable");
    assert.ok(kinds.includes("client.panel"), "and so must a panel the seller watched stop drawing");
  });

  test("a stranger is told there is no such show, not shown its failures", async () => {
    const r = await get(`/api/shows/${MY_SHOW}/events`, theirs);
    assert.equal(r.statusCode, 404, "ownership is the :showId preHandler, and it must cover this route too");
  });

  test("diagnostics answers the cross-show question, for this seller only", async () => {
    const r = await get("/api/diagnostics", mine);
    assert.equal(r.statusCode, 200);
    const rows = r.json()["recentFailures"] as { show_id: string; kind: string }[];
    assert.ok(Array.isArray(rows), "recentFailures must be there at all");
    const shows = new Set(rows.map((x) => x.show_id));
    assert.ok(shows.has(MY_SHOW), "my own failing show is missing");
    assert.ok(!shows.has(THEIR_SHOW), "another seller's failures are in my diagnostics");
  });

  test("an event that belongs to no show belongs to no seller", async () => {
    // A boot, an attach that failed before a show existed, an unhandled rejection.
    // Showing them here would put one account's operational failures in another's
    // diagnostics — the same mistake as folding ownerless shows into everybody's
    // revenue. They live in the process's own log, where a box-wide question
    // belongs.
    for (const who of [mine, theirs]) {
      const rows = (await get("/api/diagnostics", who)).json()["recentFailures"] as { kind: string }[];
      assert.ok(
        !rows.some((x) => x.kind === "process.unhandled_rejection"),
        "a null-show event reached a seller's diagnostics",
      );
    }
  });

  test("only errors, because a diagnostics panel is for what went wrong", async () => {
    await recordEvent({ showId: MY_SHOW, kind: "listen.started", level: "info", detail: {} });
    const rows = (await get("/api/diagnostics", mine)).json()["recentFailures"] as { kind: string }[];
    assert.ok(!rows.some((x) => x.kind === "listen.started"), "an info event is not a failure");
  });

  test("and the table is no longer written to by five things and read by none", () => {
    // The assertion that would have caught this a day earlier.
    const src = readFileSync(join(process.cwd(), "src/api/routes.ts"), "utf8");
    assert.match(src, /showEvents\(pgPool\(\)/, "no route reads the per-show timeline");
    assert.match(src, /FROM session_events e JOIN shows s/, "no route reads it across shows");
  });
});
