import { test } from "node:test";
import assert from "node:assert/strict";
import { db, migrate } from "../src/db/pg.js";
import { SessionRecord } from "../src/shows/sessionRecord.js";
import type { ReplyProposal } from "../src/domain/types.js";

// The proposal write is fire-and-forget, so nothing upstream ever noticed
// when it started failing. This test notices: a settled proposal must land as
// a row with its latency, and a later decision must stamp decided_at once.
test("a settled proposal is written, and its decision is stamped once", async () => {
  const pool = db();
  await migrate(pool);
  const showId = "show_record_test";
  await pool.query(
    `INSERT INTO shows (id, title, seller_handle, started_at, pinned_listing_id, autonomy_level)
     VALUES ($1, 'Record test', 'tester', now()::text, NULL, 'L1_SUGGEST') ON CONFLICT (id) DO NOTHING`,
    [showId],
  ).catch(async () => {
    // Older schemas differ in column set; fall back to the minimal insert the
    // FK needs. Either way a shows row must exist for the FK.
    await pool.query(`INSERT INTO shows (id, title) VALUES ($1, 'Record test') ON CONFLICT (id) DO NOTHING`, [showId]);
  });
  const rec = new SessionRecord(pool, showId);
  const base = {
    id: "prop_rt_1",
    message: { id: "msg_rt_1", author: "buyer", text: "any tudor?", at: new Date().toISOString(), intent: "other" },
    draft: "Not on hand right now.",
    claims: [],
    evidence: [],
    guards: [{ guard: "price", verdict: "allow" }],
    verdict: "allow",
    confidence: 0.9,
    repaired: false,
    spans: { totalMs: 1234, cacheHit: false },
    createdAt: new Date().toISOString(),
  } as unknown as ReplyProposal;

  rec.recordProposal({ ...base, status: "drafting" });
  rec.recordProposal({ ...base, status: "ready" });
  await new Promise((r) => setTimeout(r, 400));
  let { rows } = await pool.query(
    "SELECT status, latency_ms, decided_at FROM reply_proposals WHERE show_id = $1 AND id = $2",
    [showId, base.id],
  );
  assert.equal(rows.length, 1, "the settled proposal must be a row");
  assert.equal(rows[0].status, "ready");
  assert.equal(Number(rows[0].latency_ms), 1234);
  assert.equal(rows[0].decided_at, null, "nothing was decided yet");

  rec.recordProposal({ ...base, status: "sent", sentText: base.draft });
  await new Promise((r) => setTimeout(r, 400));
  ({ rows } = await pool.query("SELECT status, decided_at FROM reply_proposals WHERE show_id = $1 AND id = $2", [showId, base.id]));
  assert.equal(rows[0].status, "sent");
  assert.ok(rows[0].decided_at, "a send stamps the decision");

  await pool.query("DELETE FROM reply_proposals WHERE show_id = $1", [showId]);
  await pool.query("DELETE FROM shows WHERE id = $1", [showId]);
});
