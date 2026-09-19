// The people who asked and did not buy.
//
// The show these cases are modelled on is real: `ebay_47tK1SX0VsiHEXN1`, a
// fragrance auction that saw 190 comments, drafted 60 answerable replies from
// 29 distinct buyers, and sent none of them. 126 of the 190 were hype. Every
// number in the fabricated record below is that shape at a size a test can
// read.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import type { AppContext } from "../src/api/context.js";
import { db as pgPool } from "../src/db/pg.js";
import type { RecordedAction, RecordedProposal, ShowRecord } from "../src/shows/record.js";
import { selectFollowUps } from "../src/surfaces/dm/followups.js";
import { dmAdapter } from "../src/surfaces/dm/adapter.js";
import { SurfaceUnavailable } from "../src/surfaces/types.js";
import {
  FollowUpInbox, buildFollowUps, followUpId, type Drafter, type DryRunResult,
} from "../src/surfaces/dm/drafts.js";
import { rig, judge, cleanup, PINNED, type Rig } from "./helpers.js";

// ── fabricating a show record ───────────────────────────────────────────────

let seq = 0;
function prop(p: Partial<RecordedProposal> & { author: string; question: string }): RecordedProposal {
  seq++;
  return {
    id: `prop_${seq}`,
    messageId: `msg_${seq}`,
    at: `2026-09-18T20:${String(seq).padStart(2, "0")}:00.000Z`,
    decidedAt: null,
    intent: null,
    draft: "a draft",
    sentText: null,
    status: "ready",
    verdict: "allow",
    confidence: 0.8,
    abstained: false,
    repaired: false,
    edited: false,
    latencyMs: 900,
    cacheHit: false,
    guards: [],
    evidence: [],
    flaggedWrong: false,
    flagReason: null,
    ...p,
  };
}

const record = (proposals: RecordedProposal[], actions: RecordedAction[] = []): ShowRecord => ({
  showId: "show_fake",
  chat: [],
  proposals,
  actions,
  audit: [],
});

function action(p: Partial<RecordedAction> & { listingId: string; createdAt: string }): RecordedAction {
  return {
    id: `act_${p.listingId}`,
    kind: "markdown_price",
    status: "committed",
    listingTitle: null,
    summary: "marked it down",
    rationale: null,
    preflight: null,
    error: null,
    idempotencyKey: `idem_${p.listingId}`,
    ...p,
  };
}

// ── selection ───────────────────────────────────────────────────────────────

describe("who is worth a follow-up", () => {
  test("the buyers who asked something answerable and never got an answer", () => {
    const out = selectFollowUps(
      record([
        // Three of the real questions from that show, verbatim.
        prop({ author: "jccjlrr", question: "Burberry Her Elixir?", intent: "availability" }),
        prop({ author: "valerob_6443", question: "Can you run YSL Libre Berry Crush?", intent: "other" }),
        prop({ author: "bredil46", question: "is it 100ml?", intent: "other" }),
        // Got their answer during the show. Sending it again is a second copy.
        prop({ author: "adans2106", question: "Any set available", intent: "availability", status: "sent", sentText: "yes" }),
        prop({ author: "trancosz", question: "Can you run sets?", status: "auto_sent", sentText: "on it" }),
        // The seller looked at it and said no. That decision stands.
        prop({ author: "chava-94", question: "Que paso con el perfume D&G?", status: "dismissed" }),
        // The catalog had nothing. This is a gap in the report, not a lead:
        // drafting it later from the same catalog produces the same nothing.
        prop({ author: "joze_7503", question: "do you have Burberry cologne?", abstained: true }),
        // A guard refused it, and will refuse it again three hours later.
        prop({ author: "manutdfan8", question: "is this a rep?", status: "blocked", verdict: "block" }),
        // Never settled — there is no draft to follow up with.
        prop({ author: "505eagles", question: "Shower gels?", status: "drafting" }),
      ]),
    );
    assert.deepEqual(
      out.map((f) => f.buyer).sort(),
      ["bredil46", "jccjlrr", "valerob_6443"],
    );
  });

  test("hype is dropped, whether the row says so or the classifier does", () => {
    const out = selectFollowUps(
      record([
        prop({ author: "hypeguy", question: "LETS GOOO", intent: "hype" }),
        // Written before the intent column carried one: the same classifier the
        // live admission gate runs is asked instead.
        prop({ author: "hypegal", question: "🔥🔥", intent: null }),
        prop({ author: "realbuyer", question: "how much for the elixir", intent: "price_question" }),
      ]),
    );
    assert.deepEqual(out.map((f) => f.buyer), ["realbuyer"]);
  });

  test("a buyer who asked four times is one follow-up, on their best question", () => {
    const out = selectFollowUps(
      record([
        prop({ author: "619slowcrx", question: "Coach men's?", intent: "other" }),
        prop({ author: "619slowcrx", question: "Coach sets?", intent: "other" }),
        prop({ author: "619slowcrx", question: "whats the lowest on the Burberry", intent: "discount_request" }),
        prop({ author: "619slowcrx", question: "you there", intent: "other" }),
      ]),
    );
    assert.equal(out.length, 1, "one person, one message");
    assert.equal(out[0]!.buyer, "619slowcrx");
    assert.equal(out[0]!.question, "whats the lowest on the Burberry", "purchase intent wins");
    assert.equal(out[0]!.asked, 4, "how hard they were trying is kept");
  });

  test("a committed write on the lot they asked about is the answer", () => {
    const asked = prop({
      author: "adans2106",
      question: "any chance on the price of the 517",
      intent: "price_question",
      evidence: [{ factId: `listing:${PINNED}#price` }],
    });
    const other = prop({
      author: "bredil46",
      question: "is it 100ml?",
      evidence: [{ factId: "listing:lst_other#size" }],
    });

    const after = selectFollowUps(record([asked, other], [action({ listingId: PINNED, createdAt: "2026-09-18T23:00:00.000Z" })]));
    assert.deepEqual(after.map((f) => f.buyer), ["bredil46"], "the markdown answered adans2106");

    // A markdown that landed BEFORE they asked is the state they were asking
    // about, not a reply to it.
    const before = selectFollowUps(record([asked, other], [action({ listingId: PINNED, createdAt: "2026-01-01T00:00:00.000Z" })]));
    assert.equal(before.length, 2);

    // Proposed and never approved is the seller NOT acting — the same state as
    // not replying, so the lead survives.
    const proposed = selectFollowUps(
      record([asked, other], [action({ listingId: PINNED, createdAt: "2026-09-18T23:00:00.000Z", status: "proposed" })]),
    );
    assert.equal(proposed.length, 2);
  });

  test("a show where everyone was answered produces an empty set, not an error", () => {
    const out = selectFollowUps(
      record([
        prop({ author: "a", question: "how much", status: "sent", sentText: "$412" }),
        prop({ author: "b", question: "ship to canada?", status: "auto_sent", sentText: "yes" }),
      ]),
    );
    assert.deepEqual(out, []);
    assert.deepEqual(selectFollowUps(record([])), [], "and so does a show nobody spoke in");
  });
});

// ── the adapter ─────────────────────────────────────────────────────────────

describe("the follow-up inbox as a surface", () => {
  test("it draft-only, async, and blind — in the capability table, not in a setting", () => {
    assert.equal(dmAdapter.capabilities.delivery, "draft-only");
    assert.equal(dmAdapter.capabilities.tempo, "async");
    assert.deepEqual(dmAdapter.capabilities.perception, { audio: false, video: false });
    assert.deepEqual([...dmAdapter.capabilities.actions], ["send_dm", "flag_for_human"]);
    assert.equal(dmAdapter.capabilities.communityRules, false);
  });

  test("parseTarget reads a finished show or a manual inbox, and nothing else", () => {
    assert.equal(dmAdapter.parseTarget("show:ebay_47tK1SX0VsiHEXN1")?.externalId, "ebay_47tK1SX0VsiHEXN1");
    assert.equal(dmAdapter.parseTarget("show:ebay_47tK1SX0VsiHEXN1-2")?.externalId, "ebay_47tK1SX0VsiHEXN1-2");
    assert.equal(dmAdapter.parseTarget("inbox:@kicksbyrae")?.handle, "@kicksbyrae");
    assert.equal(dmAdapter.parseTarget("inbox:kicksbyrae")?.handle, "@kicksbyrae");
    // An eBay Live link belongs to eBay Live. Nothing here may claim it.
    assert.equal(dmAdapter.parseTarget("https://www.ebay.com/live/47tK1SX0VsiHEXN1"), null);
    assert.equal(dmAdapter.parseTarget("47tK1SX0VsiHEXN1"), null);
    assert.equal(dmAdapter.parseTarget(""), null);
  });

  test("open() refuses, and names the call that works", async () => {
    const t = dmAdapter.parseTarget("show:ebay_47tK1SX0VsiHEXN1")!;
    await assert.rejects(
      () => dmAdapter.open(t, {}),
      (e: Error) => e instanceof SurfaceUnavailable && /POST \/api\/shows\/ebay_47tK1SX0VsiHEXN1\/followups/.test(e.message),
    );
  });
});

// ── drafting, through the real guard chain ──────────────────────────────────

/**
 * A drafter that stubs the MODEL and nothing else.
 *
 * `judge()` is the production guard chain over the production retrieval against
 * the rig's real catalog (test/helpers.ts) — the same line the rest of this
 * suite draws. What a follow-up has to prove is that a stale question cannot
 * carry a stale price out of the show it was asked in, and that is the chain's
 * job, not the composer's.
 */
const stubbedModel = (r: Rig, answers: Record<string, string>): Drafter => ({
  async dryRun(question: string): Promise<DryRunResult> {
    const answer = answers[question] ?? "";
    const chain = await judge(r, question, answer, [{ text: answer, factId: `listing:${PINNED}#price` }]);
    return {
      question, answer,
      evidence: [], guards: chain.guards, verdict: chain.verdict,
      confidence: chain.confidence, abstained: !answer, latencyMs: 12,
    };
  },
});

describe("drafting a follow-up", () => {
  let r: Rig;
  const account = "acct_followups_test";
  before(async () => {
    r = await rig();
  });
  after(async () => {
    await pgPool().query("DELETE FROM followups WHERE account_id = $1", [account]).catch(() => {});
  });

  test("a draft the guards block is never stored, and the reason is kept", async () => {
    const out = await buildFollowUps(r.d, {
      showId: r.showId,
      accountId: account,
      record: record([
        prop({ author: "grounded", question: "how much for the chicagos", intent: "price_question" }),
        prop({ author: "invented", question: "can you do 300", intent: "discount_request" }),
      ]),
      drafter: stubbedModel(r, {
        // The listed price, as the catalog has it.
        "how much for the chicagos": "The Chicago Reimagined in a size 10 is $412.00 right now.",
        // A number nothing supports — the exact failure a three-hour-old
        // question invites, and the reason this runs the live chain.
        "can you do 300": "Yes, $300.00 works, they're yours.",
      }),
    });

    assert.equal(out.selected, 2);
    assert.deepEqual(out.followups.map((f) => f.buyer), ["grounded"]);
    assert.equal(out.guardedOut.length, 1, JSON.stringify(out.guardedOut));
    assert.equal(out.guardedOut[0]!.buyer, "invented");
    assert.equal(out.guardedOut[0]!.guard, "price", "the guard that fired is named");
    assert.ok(out.guardedOut[0]!.reason, "with its own reason, not ours");

    const stored = out.followups[0]!;
    assert.equal(stored.status, "draft");
    assert.equal(stored.question, "how much for the chicagos");
    assert.match(stored.draft, /\$412\.00/);
    assert.equal(stored.id, followUpId(r.showId, "grounded"));
  });

  test("an answer the catalog can no longer support is not a message", async () => {
    const out = await buildFollowUps(r.d, {
      showId: r.showId,
      accountId: `${account}_abstain`,
      record: record([prop({ author: "nobody", question: "do you have the elixir" })]),
      drafter: stubbedModel(r, {}),
    });
    assert.equal(out.selected, 1);
    assert.deepEqual(out.followups, []);
    assert.deepEqual(out.abstained.map((a) => a.buyer), ["nobody"]);
    await pgPool().query("DELETE FROM followups WHERE account_id = $1", [`${account}_abstain`]);
  });

  test("rebuilding does not duplicate a buyer, or reopen a decision", async () => {
    const inbox = new FollowUpInbox(r.d);
    const build = () =>
      buildFollowUps(r.d, {
        showId: r.showId,
        accountId: account,
        record: record([prop({ author: "grounded", question: "how much for the chicagos", intent: "price_question" })]),
        drafter: stubbedModel(r, { "how much for the chicagos": "The Chicago Reimagined in a size 10 is $412.00 right now." }),
      });

    await build();
    const sent = await inbox.markSent(account, followUpId(r.showId, "grounded"));
    assert.equal(sent?.status, "sent");

    const again = await build();
    const rows = again.followups.filter((f) => f.buyer === "grounded");
    assert.equal(rows.length, 1, "one row per buyer per show");
    assert.equal(rows[0]!.status, "sent", "a rebuild is not a vote to reopen what the seller decided");
  });
});

// ── the routes ──────────────────────────────────────────────────────────────

let app: FastifyInstance;
let ctx: AppContext;
const json = { "content-type": "application/json" };
const register = async (tag: string) => {
  const res = (await app.inject({
    method: "POST", url: "/api/auth/register", headers: json,
    payload: {
      email: `${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`,
      password: "password-123", displayName: tag,
    },
  })).json() as { token: string; account: { id: string } };
  return { headers: { authorization: `Bearer ${res.token}`, ...json }, id: res.account.id };
};

describe("the follow-up routes", () => {
  let A: { headers: Record<string, string>; id: string };
  let B: { headers: Record<string, string>; id: string };
  const ENDED = "show_followups_ended";
  const LIVE = "show_followups_live";
  let mine: string;

  before(async () => {
    ({ app, ctx } = await buildApp());
    A = await register("fu-owner");
    B = await register("fu-stranger");
    const p = pgPool();
    for (const [id, status] of [[ENDED, "ended"], [LIVE, "live"]] as const) {
      await p.query("DELETE FROM shows WHERE id = $1", [id]);
      await p.query(
        `INSERT INTO shows (id, owner_account_id, title, seller_handle, source, started_at, status, autonomy_level, undo_window_s)
         VALUES ($1, $2, 'A''s show', 'seller-a', 'ebaylive', $3, $4, 'L1_SUGGEST', 90)`,
        [id, A.id, new Date().toISOString(), status],
      );
    }
    const row = await new FollowUpInbox(p).save({
      id: followUpId(ENDED, "jccjlrr"),
      showId: ENDED, accountId: A.id, buyer: "jccjlrr",
      question: "Burberry Her Elixir?", messageId: "msg_1",
      draft: "Still have it — $84 and I can ship today.",
    });
    mine = row.id;
  });
  after(async () => {
    const p = pgPool();
    for (const id of [ENDED, LIVE]) await p.query("DELETE FROM shows WHERE id = $1", [id]).catch(() => {});
    await app.close();
    await ctx.stop();
  });

  test("a stranger cannot see, build, send or dismiss another seller's follow-ups", async () => {
    const theirs = (await app.inject({ method: "GET", url: "/api/followups", headers: B.headers })).json() as {
      followups: { id: string }[];
    };
    assert.ok(!theirs.followups.some((f) => f.id === mine), "not in a stranger's inbox");

    const build = await app.inject({ method: "POST", url: `/api/shows/${ENDED}/followups`, headers: B.headers });
    assert.equal(build.statusCode, 404, `build → ${build.statusCode}: ${build.body}`);

    for (const verb of ["sent", "dismiss"]) {
      const r = await app.inject({ method: "POST", url: `/api/followups/${mine}/${verb}`, headers: B.headers });
      assert.equal(r.statusCode, 404, `${verb} → ${r.statusCode}`);
    }

    // And the row is untouched — a 404 that still performed the write would be
    // the worst of both.
    const still = await app.inject({ method: "GET", url: "/api/followups?status=draft", headers: A.headers });
    assert.ok((still.json() as { followups: { id: string }[] }).followups.some((f) => f.id === mine));
  });

  test("marking sent is idempotent, and the timestamp does not move", async () => {
    const first = await app.inject({ method: "POST", url: `/api/followups/${mine}/sent`, headers: A.headers });
    assert.equal(first.statusCode, 200);
    const one = (first.json() as { followup: { status: string; sentAt: string } }).followup;
    assert.equal(one.status, "sent");
    assert.ok(one.sentAt);

    const again = await app.inject({ method: "POST", url: `/api/followups/${mine}/sent`, headers: A.headers });
    assert.equal(again.statusCode, 200);
    const two = (again.json() as { followup: { status: string; sentAt: string } }).followup;
    assert.equal(two.status, "sent");
    assert.equal(two.sentAt, one.sentAt, "sent_at is evidence, and a retry is not a second send");
  });

  test("the status filter is the inbox's whole navigation", async () => {
    const drafts = (await app.inject({ method: "GET", url: "/api/followups?status=draft", headers: A.headers })).json() as {
      followups: { id: string }[];
    };
    assert.ok(!drafts.followups.some((f) => f.id === mine), "a sent follow-up is out of the draft list");
    const sent = (await app.inject({ method: "GET", url: "/api/followups?status=sent", headers: A.headers })).json() as {
      followups: { id: string }[];
    };
    assert.ok(sent.followups.some((f) => f.id === mine));
    const bad = await app.inject({ method: "GET", url: "/api/followups?status=posted", headers: A.headers });
    assert.equal(bad.statusCode, 400);
  });

  test("dismissing is final enough that sending is refused afterwards", async () => {
    const inbox = new FollowUpInbox(pgPool());
    const row = await inbox.save({
      id: followUpId(ENDED, "valerob_6443"),
      showId: ENDED, accountId: A.id, buyer: "valerob_6443",
      question: "Can you run YSL Libre Berry Crush?", messageId: "msg_2",
      draft: "Sold that one on air, sorry.",
    });
    const dismissed = await app.inject({ method: "POST", url: `/api/followups/${row.id}/dismiss`, headers: A.headers });
    assert.equal(dismissed.statusCode, 200);
    assert.equal((dismissed.json() as { followup: { status: string } }).followup.status, "dismissed");

    const sent = await app.inject({ method: "POST", url: `/api/followups/${row.id}/sent`, headers: A.headers });
    assert.equal(sent.statusCode, 409);
  });

  test("a show still on air has nobody who has left the room yet", async () => {
    const r = await app.inject({ method: "POST", url: `/api/shows/${LIVE}/followups`, headers: A.headers });
    assert.equal(r.statusCode, 409);
    assert.equal((r.json() as { code: string }).code, "still-live");
  });

  test("a finished show with nothing unanswered builds an empty set, not an error", async () => {
    // No proposals at all: the whole path runs — ownership, the replay runtime
    // rebuilt over the ended show, the selection — and the answer is zero.
    const r = await app.inject({ method: "POST", url: `/api/shows/${ENDED}/followups`, headers: A.headers });
    assert.equal(r.statusCode, 200, r.body.slice(0, 400));
    const body = r.json() as { selected: number; guardedOut: unknown[]; followups: { buyer: string }[] };
    assert.equal(body.selected, 0);
    assert.deepEqual(body.guardedOut, []);
    // The two rows saved by hand above are still the show's inbox: a build that
    // found nobody new does not delete what is already there.
    assert.deepEqual(body.followups.map((f) => f.buyer).sort(), ["jccjlrr", "valerob_6443"]);

    // And the show is still ended. A replay that put it back on air would have
    // restarted its clock and lied on every list that says "0 on air".
    const status = await pgPool().query<{ status: string }>("SELECT status FROM shows WHERE id = $1", [ENDED]);
    assert.equal(status.rows[0]!.status, "ended");
  });
});

after(cleanup);
