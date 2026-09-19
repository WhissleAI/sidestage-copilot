// Which id the next session of an event takes.
//
// The rule used to be "reuse any row with no report", which made report
// generation load-bearing for session IDENTITY: a session whose report failed
// to build handed its id to the next attach of the same event, and everything
// keyed on `show_id` — chat, proposals, the audit chain, the signals, the sales
// — merged into one row belonging to two sessions.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { db, migrate } from "../src/db/pg.js";
import { nextSessionId, sessionIdFor } from "../src/shows/registry.js";

describe("the rule", () => {
  test("an event nobody has attached takes the base id", () => {
    assert.equal(sessionIdFor("ebay_E1", []), "ebay_E1");
  });

  test("a row still LIVE is a resume, and keeps its id", () => {
    assert.equal(
      sessionIdFor("ebay_E1", [{ id: "ebay_E1", status: "live" }]),
      "ebay_E1",
    );
  });

  test("a session that ENDED without a report does NOT give up its id", () => {
    // The whole finding. Before: this returned `ebay_E1` because the row had no
    // report, and the dead session's chat, proposals and audit became the next
    // session's.
    assert.equal(
      sessionIdFor("ebay_E1", [{ id: "ebay_E1", status: "ended" }]),
      "ebay_E1-2",
    );
  });

  test("ids keep counting past every session the event has had", () => {
    assert.equal(
      sessionIdFor("ebay_E1", [
        { id: "ebay_E1-2", status: "ended" },
        { id: "ebay_E1", status: "ended" },
      ]),
      "ebay_E1-3",
    );
  });

  test("a live row wins over an ended one, whatever order they arrive in", () => {
    assert.equal(
      sessionIdFor("ebay_E1", [
        { id: "ebay_E1", status: "ended" },
        { id: "ebay_E1-2", status: "live" },
      ]),
      "ebay_E1-2",
    );
  });
});

describe("over the rows an event actually has", () => {
  const EVENT = "EVT_identity_test";
  const A = `ebay_${EVENT}`;

  after(async () => {
    await db().query("DELETE FROM shows WHERE external_id = $1", [EVENT]).catch(() => {});
  });

  test("a failed report does not hand the dead session's row to the next attach", async () => {
    const d = db();
    await migrate(d);
    await d.query("DELETE FROM shows WHERE external_id = $1", [EVENT]);
    // A session that ran, ended, and whose report never generated: exactly the
    // row the home page tells an operator to go and look at.
    await d.query(
      `INSERT INTO shows (id, title, seller_handle, started_at, source, external_id, status, ended_at)
       VALUES ($1, 'Last night', 'tester', $2, 'ebaylive', $3, 'ended', now())`,
      [A, new Date(Date.now() - 3 * 3_600_000).toISOString(), EVENT],
    );
    const reportless = await d.query("SELECT 1 FROM show_reports WHERE show_id = $1", [A]);
    assert.equal(reportless.rowCount, 0, "the fixture must have no report");

    const next = await nextSessionId(d, A, EVENT);
    assert.notEqual(next, A, "the ended session keeps its own id and its own record");
    assert.equal(next, `${A}-2`);
  });

  test("a row still live is resumed rather than duplicated", async () => {
    const d = db();
    await d.query("UPDATE shows SET status = 'live', ended_at = NULL WHERE id = $1", [A]);
    assert.equal(await nextSessionId(d, A, EVENT), A);
  });
});
