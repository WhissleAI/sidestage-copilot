// Follow-ups are built when the session ends.
//
// `buildFollowUps` had exactly one caller — `POST /api/shows/:showId/followups`
// — and nothing invoked that route: not the detach path, not the console, not
// the frontend. So `followups.total` was permanently zero for every real user.
// The selection rule, the drafting, the guard re-run and the inbox were all
// correct and all unreachable, while the home page said one line above the card
// that "the follow-ups are the people who asked and did not buy".

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { db, migrate } from "../src/db/pg.js";
import { EventHub } from "../src/api/hub.js";
import { ShowRegistry } from "../src/shows/registry.js";
import { openReplayRuntime } from "../src/shows/replay.js";
import { generateSessionFollowUps } from "../src/shows/sessionFollowups.js";
import { FollowUpInbox, MAX_PER_BUILD, type DryRunResult } from "../src/surfaces/dm/drafts.js";

const ACCOUNT = "acct_session_followups";
const SHOW = "show_session_followups";

/** A drafter that answers every question the same way, without a gateway. The
 *  selection, the paging, the inbox and the detach wiring are what is on test
 *  here; the guard chain has its own suite. */
const stubDrafter = {
  dryRun: async (question: string): Promise<DryRunResult> => ({
    question,
    answer: `Still here — ${question.slice(0, 40)}`,
    evidence: [],
    guards: [],
    verdict: "allow",
    confidence: 0.9,
    abstained: false,
    latencyMs: 10,
  }),
};
const openStub = async () => ({ drafter: stubDrafter, close: async () => {} });

async function seedSession(showId: string, buyers: number): Promise<void> {
  const d = db();
  await migrate(d);
  await d.query("DELETE FROM shows WHERE id = $1", [showId]);
  await d.query(
    `INSERT INTO accounts (id, kind, handle, display_name, email, password_hash)
     VALUES ($1, 'seller', 'followups', 'followups', $2, 'x') ON CONFLICT (id) DO NOTHING`,
    [ACCOUNT, `${ACCOUNT}@test.local`],
  );
  await d.query(
    `INSERT INTO shows (id, owner_account_id, title, seller_handle, started_at, source, status, ended_at)
     VALUES ($1, $2, 'Friday night', 'tester', $3, 'simulated', 'ended', now())`,
    [showId, ACCOUNT, new Date(Date.now() - 2 * 3_600_000).toISOString()],
  );
  // One answerable, never-sent proposal per buyer: exactly the shape of the
  // real show this rule was written against.
  for (let i = 0; i < buyers; i++) {
    await d.query(
      `INSERT INTO reply_proposals (show_id, id, message_id, author, question, draft, status, verdict,
         confidence, repaired, abstained, latency_ms, cache_hit, guards, evidence, intent, at)
       VALUES ($1,$2,$3,$4,$5,'a draft','ready','allow',0.9,FALSE,FALSE,900,FALSE,
               '[]'::jsonb,'[]'::jsonb,'price_question',$6)`,
      [showId, `p${i}`, `m${i}`, `buyer${String(i).padStart(3, "0")}`, `whats the lowest on lot ${i}`,
       new Date(Date.now() - (buyers - i) * 60_000).toISOString()],
    );
  }
}

after(async () => {
  const d = db();
  for (const id of [SHOW, `${SHOW}_big`, `${SHOW}_unowned`, `${SHOW}_detach`]) {
    await d.query("DELETE FROM followups WHERE show_id = $1", [id]).catch(() => {});
    await d.query("DELETE FROM shows WHERE id = $1", [id]).catch(() => {});
  }
  await d.query("DELETE FROM accounts WHERE id = $1", [ACCOUNT]).catch(() => {});
});

describe("building a finished session's follow-ups", () => {
  test("one row per buyer who asked something answerable and never got it", async () => {
    await seedSession(SHOW, 3);
    const out = await generateSessionFollowUps(db(), SHOW, { open: openStub });
    assert.ok(out);
    assert.equal(out.selected, 3);
    assert.equal(out.drafted, 3);
    assert.equal(out.unreached, 0);

    const inbox = await new FollowUpInbox(db()).forShow(ACCOUNT, SHOW);
    assert.equal(inbox.length, 3);
    assert.ok(inbox.every((f) => f.draft.length > 0), "every row is something the seller can send");
    assert.ok(inbox.every((f) => f.accountId === ACCOUNT), "and it is filed to the session's owner");
  });

  test("nobody past the cap is stranded — the job pages through the selection", async () => {
    const big = `${SHOW}_big`;
    await seedSession(big, MAX_PER_BUILD + 7);
    const out = await generateSessionFollowUps(db(), big, { open: openStub });
    assert.ok(out);
    assert.equal(out.selected, MAX_PER_BUILD + 7);
    assert.equal(
      out.drafted, MAX_PER_BUILD + 7,
      "a single build drafts fifty; the buyers past it used to be stranded for ever",
    );
    assert.equal(out.unreached, 0, "and nothing is left unaccounted for");
  });

  test("a session with no owner has no inbox to file into, and says so", async () => {
    const unowned = `${SHOW}_unowned`;
    await seedSession(unowned, 2);
    await db().query("UPDATE shows SET owner_account_id = NULL WHERE id = $1", [unowned]);
    const out = await generateSessionFollowUps(db(), unowned, { open: openStub });
    assert.equal(out, null, "null, rather than an invented owner");
  });
});

describe("the detach path", () => {
  const ENDING = `${SHOW}_detach`;
  let registry: ShowRegistry;

  before(async () => {
    await seedSession(ENDING, 1);
    // A live session of our own rather than the scripted demo show: `show_ep42`
    // is a fixed id shared with every other suite in the run, and giving it an
    // owner mid-run would 404 somebody else's requests for it. The runtime is
    // put into the registry directly because `attach` resolves a real surface
    // and opens a real watcher, which is a browser, not a unit test.
    await db().query("UPDATE shows SET status = 'live', ended_at = NULL WHERE id = $1", [ENDING]);
    registry = new ShowRegistry(new EventHub());
    registry.drafterFor = openStub;
    const rt = await openReplayRuntime(ENDING);
    (registry as unknown as { runtimes: Map<string, unknown> }).runtimes.set(ENDING, rt);
  });

  after(async () => {
    await registry.stopAll();
    await db().query("DELETE FROM followups WHERE show_id = $1", [ENDING]).catch(() => {});
    await db().query("DELETE FROM shows WHERE id = $1", [ENDING]).catch(() => {});
  });

  test("ending a session builds the follow-ups it left behind", async () => {
    const before = await new FollowUpInbox(db()).forShow(ACCOUNT, ENDING);
    assert.equal(before.length, 0, "the inbox starts empty");

    const report = await registry.detach(ENDING);
    assert.ok(report, "the session still ends with its report");
    // Background, exactly like the frame descriptions: the detach does not wait
    // for it, so the test does.
    await registry.settle();

    const after = await new FollowUpInbox(db()).forShow(ACCOUNT, ENDING);
    assert.equal(after.length, 1, "the buyer who asked and did not buy is in the inbox");
    assert.equal(after[0]!.buyer, "buyer000");
    assert.equal(after[0]!.status, "draft");
  });
});
