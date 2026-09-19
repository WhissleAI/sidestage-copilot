/**
 * One queue, whatever surface wrote it.
 *
 * A draft-only surface has no console, so its whole interface is a queue and
 * the home page's NOW band is a count of that queue. Before this there was no
 * such queue: the Drafts page read `/api/followups`, which is ONE async
 * surface's inbox, and a Reddit draft was a proposal inside a live runtime that
 * no page outside the console could reach. The count on home was therefore
 * counting things its own destination could not show.
 *
 * The rules asserted here, in the order they matter:
 *
 *   1. the count and the list are the same fact — `GET /api/drafts` → `waiting`
 *      is deep-equal to `GET /api/home` → `now.drafts`, ordering included;
 *   2. one operator never sees another's drafts;
 *   3. a draft says where it came from in the operator's words — `r/mechmarket`
 *      for a room, the SESSION'S TITLE for a follow-up, never a show id;
 *   4. the two effects a room's rule can have are `applied` and `blocked`.
 *      There is no `would_block`: see src/api/drafts.ts.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import {
  draftFromFollowUp, draftQueue, draftsFromSession, isWaiting, originOfSession, rulesOf,
  type SurfaceDraft,
} from "../src/api/drafts.js";
import { nowBand } from "../src/api/home.js";
import type { ShowSummary } from "../src/shows/registry.js";
import type { Evidence, ProposalStatus, ReplyProposal } from "../src/domain/types.js";
import type { FollowUpRow } from "../src/surfaces/dm/drafts.js";
import { FollowUpInbox } from "../src/surfaces/dm/drafts.js";
import { db as pgPool } from "../src/db/pg.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const session = (over: Partial<ShowSummary> = {}): ShowSummary => ({
  showId: "sess_1", ownerAccountId: null, agentId: "agent", catalogId: null,
  title: "A session", sellerHandle: "@host", source: "ebaylive", externalId: null,
  readOnly: true, writeTarget: "mock", status: "live", startedAt: "2026-09-18T20:00:00.000Z",
  viewers: 0, listings: 0, proposals: 0, awaiting: 0, blocked: 0,
  ...over,
});

const rule = (n: number, text: string): Evidence => ({
  factId: `community:mechmarket#rule${n}`,
  source: "policy", corpus: "community",
  label: `r/mechmarket rule ${n}`, text, score: 0.9,
});

const proposal = (over: Partial<ReplyProposal> = {}): ReplyProposal => ({
  id: "prop_1",
  message: {
    id: "t1_abc", author: "u/someone", text: "does the 65% ship to the UK?",
    at: "2026-09-19T09:00:00.000Z", intent: "shipping", speechAct: null, admitted: true,
  },
  status: "ready",
  draft: "Yes — UK shipping is $18 and goes out the next working day.",
  claims: [], evidence: [], guards: [], verdict: "allow", confidence: 0.82, repaired: false,
  spans: {
    admitMs: 1, classifyMs: 1, retrieveMs: 1, composeMs: 1, guardMs: 1, repairMs: 0,
    totalMs: 5, cacheHit: false, budgetMs: 1200, overBudget: false,
  },
  createdAt: "2026-09-19T09:00:03.000Z",
  ...over,
});

const followUp = (over: Partial<FollowUpRow> = {}): FollowUpRow => ({
  id: "fu_1", showId: "ebay_47tK1SX0VsiHEXN1", accountId: "acct_1",
  buyer: "jccjlrr", question: "Burberry Her Elixir?", messageId: "msg_1",
  draft: "Still have it — $84 and I can ship today.",
  status: "draft", createdAt: "2026-09-19T08:00:00.000Z", sentAt: null, dismissedAt: null,
  ...over,
});

// ── the shape ───────────────────────────────────────────────────────────────

describe("what one draft says", () => {
  test("a room's draft carries the room, the question and what it stood on", () => {
    const rd = session({
      showId: "reddit_r/mechmarket", source: "reddit", externalId: "r/mechmarket",
      sellerHandle: "r/mechmarket", title: "Reddit r/mechmarket",
    });
    const [d] = draftsFromSession(rd, [proposal({ evidence: [rule(3, "No vendor self-promotion.")] })]);
    assert.ok(d);
    assert.equal(d.surface, "reddit");
    assert.deepEqual(d.origin, { kind: "room", id: "r/mechmarket", label: "r/mechmarket" });
    assert.equal(d.room, "r/mechmarket", "the flat field the card prints");
    assert.equal(d.sessionId, "reddit_r/mechmarket");
    assert.equal(d.status, "open");
    assert.deepEqual(d.question, {
      author: "u/someone", text: "does the 65% ship to the UK?",
      at: "2026-09-19T09:00:00.000Z",
      // The poller reads the permalink and the runtime drops it on the way into
      // the pipeline. Null is the honest answer; a guessed link opens the wrong
      // comment.
      url: null,
    });
    assert.equal(d.confidence, 0.82);
    assert.deepEqual(d.rules, [{
      factId: "community:mechmarket#rule3", label: "r/mechmarket rule 3",
      text: "No vendor self-promotion.", effect: "applied", reason: null,
    }]);
  });

  test("a thread with no subreddit in the link is named, not left as a placeholder", () => {
    // `ShowRegistry.attach` falls back to "eBay Live seller" when a target
    // carries no handle. That is not the name of a room.
    const o = originOfSession(session({
      showId: "reddit_t3_1abc2d", source: "reddit", externalId: "t3_1abc2d",
      sellerHandle: "eBay Live seller", title: "Reddit t3_1abc2d",
    }));
    assert.deepEqual(o, { kind: "room", id: "t3_1abc2d", label: "Reddit t3_1abc2d" });
  });

  test("a follow-up says which session it came out of, BY TITLE", () => {
    const d = draftFromFollowUp(followUp(), "Friday Night Grails — Ep. 42");
    assert.equal(d.surface, "dm");
    assert.deepEqual(d.origin, {
      kind: "session", id: "ebay_47tK1SX0VsiHEXN1", label: "Friday Night Grails — Ep. 42",
    });
    // The bug this closes: a `dm` draft used to print `ebay_47tK1SX0VsiHEXN1`
    // in the same slot a Reddit draft prints `r/mechmarket`.
    assert.notEqual(d.room, d.origin.id);
    assert.equal(d.status, "open");
    // A follow-up is a draft the guards already cleared and the table keeps
    // nothing else. Absent, never a zero nobody measured.
    assert.equal(d.confidence, undefined);
    assert.equal(d.evidence, undefined);
    assert.equal(d.rules, undefined);
  });

  test("a follow-up whose session was deleted falls back to the id, not to nothing", () => {
    const d = draftFromFollowUp(followUp(), null);
    assert.equal(d.origin.label, "ebay_47tK1SX0VsiHEXN1");
    assert.equal(d.room, "ebay_47tK1SX0VsiHEXN1");
  });

  test("every proposal status lands somewhere an operator understands", () => {
    const rd = session({ source: "reddit", externalId: "r/mechmarket", sellerHandle: "r/mechmarket" });
    const statuses: ProposalStatus[] =
      ["drafting", "ready", "needs_review", "blocked", "sent", "auto_sent", "dismissed"];
    const drafts = draftsFromSession(
      rd,
      statuses.map((s, i) => proposal({ id: `prop_${i}`, status: s })),
    );
    assert.deepEqual(
      drafts.map((d) => d.status),
      ["open", "open", "blocked", "sent", "sent", "dismissed"],
      "a proposal still being written is not yet a draft",
    );
  });

  test("the sent text is what was sent, not the draft it was edited from", () => {
    const rd = session({ source: "reddit", sellerHandle: "r/mechmarket" });
    const [d] = draftsFromSession(rd, [proposal({ status: "sent", sentText: "posted this instead" })]);
    assert.equal(d!.draft, "posted this instead");
  });
});

describe("the rules of the room, and the effect that does not exist", () => {
  test("the rule that held a draft is blocked; the rest are in force", () => {
    const p = proposal({
      status: "blocked",
      evidence: [rule(3, "No vendor self-promotion."), rule(5, "Be civil.")],
      guards: [{
        guard: "community_rule", verdict: "block",
        reason: "r/mechmarket rule 3: No vendor self-promotion. — the draft is about \"vendor self promotion\".",
        detail: { expected: "community:mechmarket#rule3", found: "vendor self promotion" },
      }],
    });
    const rules = rulesOf(p);
    assert.deepEqual(rules.map((r) => [r.factId, r.effect]), [
      ["community:mechmarket#rule3", "blocked"],
      ["community:mechmarket#rule5", "applied"],
    ]);
    assert.match(rules[0]!.reason!, /rule 3/);
    assert.equal(rules[1]!.reason, null);
  });

  test("there is no would_block, on any draft, ever", () => {
    // `runChain` never returns `revise` — it says so in a comment and in code
    // — so the pipeline's single repair pass is unreachable and there is never
    // an earlier draft for a rule to have tripped. The UI reads three effects;
    // the server honestly has two, and this is the assertion that says which.
    const rd = session({ source: "reddit", sellerHandle: "r/mechmarket" });
    const drafts = draftsFromSession(rd, [
      proposal({ id: "a", evidence: [rule(1, "No price talk outside the weekly thread.")] }),
      proposal({
        id: "b", status: "blocked", repaired: true,
        evidence: [rule(1, "No price talk outside the weekly thread.")],
        guards: [{
          guard: "community_rule", verdict: "block", reason: "held",
          detail: { expected: "community:mechmarket#rule1" },
        }],
      }),
    ]);
    const effects = new Set(drafts.flatMap((d) => (d.rules ?? []).map((r) => r.effect)));
    assert.deepEqual([...effects].sort(), ["applied", "blocked"]);
  });

  test("a blocking fact we cannot match is left unmatched rather than invented", () => {
    const rules = rulesOf(proposal({
      status: "blocked",
      evidence: [rule(5, "Be civil.")],
      guards: [{
        guard: "community_rule", verdict: "block", reason: "held",
        detail: { expected: "community:somewhereelse#rule9" },
      }],
    }));
    assert.deepEqual(rules.map((r) => r.effect), ["applied"]);
  });
});

// ── the count and the list are one fact ─────────────────────────────────────

describe("the queue, and the number home prints above it", () => {
  const redditSession = (over: Partial<ShowSummary> = {}) =>
    session({ source: "reddit", externalId: "r/mechmarket", sellerHandle: "r/mechmarket", ...over });

  /** The queue and the band, built from the same fabricated world. */
  const both = (
    sessions: { summary: ShowSummary; proposals: ReplyProposal[] }[],
    followups: { row: FollowUpRow; sessionTitle: string | null }[],
  ) => {
    const queue = draftQueue({ sessions, followups });
    // `nowBand` reads the registry's OWN counts — the ones `ShowRegistry.list`
    // computes with `isWaiting` — so the fixture computes them the same way
    // rather than restating the two statuses a third time.
    const band = nowBand(
      sessions.map((s) => ({ ...s.summary, awaiting: s.proposals.filter(isWaiting).length })),
      followups.filter((f) => f.row.status === "draft").length,
    );
    return { queue, band };
  };

  test("the waiting count IS the list, deep-equal and in the same order", () => {
    const { queue, band } = both(
      [
        // A live console's queue is not a draft queue: somebody is sitting in
        // front of it, and NOW already names that session.
        { summary: session({ showId: "eb", source: "ebaylive" }), proposals: [proposal({ id: "e1" }), proposal({ id: "e2" })] },
        { summary: redditSession({ showId: "rd1" }), proposals: [
          proposal({ id: "r1" }),
          proposal({ id: "r2", status: "needs_review" }),
          proposal({ id: "r3", status: "blocked" }),
          proposal({ id: "r4", status: "sent" }),
        ] },
        { summary: redditSession({ showId: "rd2" }), proposals: [proposal({ id: "r5" })] },
      ],
      [
        { row: followUp({ id: "f1" }), sessionTitle: "Friday Night Grails — Ep. 42" },
        { row: followUp({ id: "f2", status: "sent" }), sessionTitle: "Friday Night Grails — Ep. 42" },
      ],
    );

    assert.deepEqual(queue.waiting, band.drafts, "home and the queue are one fact");
    assert.deepEqual(queue.waiting, {
      total: 4,
      bySurface: [{ surface: "reddit", count: 3 }, { surface: "dm", count: 1 }],
    });
    // And the list underneath it holds exactly that many open drafts.
    assert.equal(queue.drafts.filter((d) => d.status === "open").length, queue.waiting.total);
    for (const s of queue.waiting.bySurface) {
      assert.equal(
        queue.drafts.filter((d) => d.status === "open" && d.surface === s.surface).length,
        s.count,
        `${s.surface} disagrees`,
      );
    }
    // A blocked draft is shown and is NOT waiting: there is nothing to send.
    assert.equal(queue.drafts.filter((d) => d.status === "blocked").length, 1);
    assert.ok(!queue.drafts.some((d) => d.surface === "ebaylive"), "a live console is not a draft queue");
  });

  test("an empty world is an empty queue and an empty count, not a row of zeroes", () => {
    const { queue, band } = both([], []);
    assert.deepEqual(queue.waiting, band.drafts);
    assert.deepEqual(queue.waiting, { total: 0, bySurface: [] });
    assert.deepEqual(queue.drafts, []);
  });

  test("a session that ended contributes nothing to either", () => {
    const { queue, band } = both(
      [{ summary: redditSession({ showId: "rd", status: "ended" }), proposals: [proposal()] }],
      [],
    );
    assert.deepEqual(queue.waiting, band.drafts);
    assert.deepEqual(queue.drafts, []);
  });

  test("newest first, across both sources", () => {
    const { queue } = both(
      [{ summary: redditSession({ showId: "rd" }), proposals: [proposal({ id: "old", createdAt: "2026-09-19T07:00:00.000Z" })] }],
      [{ row: followUp({ id: "new", createdAt: "2026-09-19T10:00:00.000Z" }), sessionTitle: "A show" }],
    );
    assert.deepEqual(queue.drafts.map((d) => d.id), ["new", "old"]);
  });
});

// ── the endpoint ────────────────────────────────────────────────────────────

const { buildApp } = await import("../src/api/server.js");
type AppContext = Awaited<ReturnType<typeof buildApp>>["ctx"];

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

interface QueueBody {
  surface: string | null;
  status: string | null;
  waiting: { total: number; bySurface: { surface: string; count: number }[] };
  drafts: SurfaceDraft[];
}

describe("GET /api/drafts", () => {
  let A: { headers: Record<string, string>; id: string };
  let B: { headers: Record<string, string>; id: string };
  const run = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
  const showA = `drafts_${run}_a`;
  const showB = `drafts_${run}_b`;
  const TITLE_A = "Friday Night Grails — Ep. 42";

  before(async () => {
    ({ app, ctx } = await buildApp());
    A = await register("drafts-owner");
    B = await register("drafts-stranger");
    const p = pgPool();
    const inbox = new FollowUpInbox(p);
    for (const [id, owner, title] of [[showA, A.id, TITLE_A], [showB, B.id, "Someone else's show"]] as const) {
      await p.query(
        `INSERT INTO shows (id, owner_account_id, title, seller_handle, source, surface, started_at, status, autonomy_level, undo_window_s)
         VALUES ($1, $2, $3, 'seller', 'ebaylive', 'ebaylive', now(), 'ended', 'L1_SUGGEST', 90)`,
        [id, owner, title],
      );
    }
    await inbox.save({
      id: `fu_${run}_1`, showId: showA, accountId: A.id, buyer: "jccjlrr",
      question: "Burberry Her Elixir?", messageId: null,
      draft: "Still have it — $84 and I can ship today.",
    });
    await inbox.save({
      id: `fu_${run}_2`, showId: showA, accountId: A.id, buyer: "m_dexter",
      question: "is it 100ml?", messageId: null, draft: "It is — 100ml, sealed.",
    });
    // The stranger's own queue, so "A cannot see B" is a claim about real rows
    // rather than about an empty database.
    await inbox.save({
      id: `fu_${run}_3`, showId: showB, accountId: B.id, buyer: "someone",
      question: "still available?", messageId: null, draft: "Yes.",
    });
  });

  after(async () => {
    const p = pgPool();
    for (const id of [showA, showB]) await p.query("DELETE FROM shows WHERE id = $1", [id]).catch(() => {});
    await app.close();
    await ctx.stop();
  });

  const queue = async (who: { headers: Record<string, string> }, qs = "") => {
    const r = await app.inject({ method: "GET", url: `/api/drafts${qs}`, headers: who.headers });
    assert.equal(r.statusCode, 200, r.body);
    return r.json() as QueueBody;
  };

  test("signed out, it refuses rather than answering with an empty queue", async () => {
    const r = await app.inject({ method: "GET", url: "/api/drafts" });
    assert.equal(r.statusCode, 401);
  });

  test("every async surface's drafts, in one shape", async () => {
    const body = await queue(A);
    const mine = body.drafts.filter((d) => d.id.startsWith(`fu_${run}`));
    assert.equal(mine.length, 2);
    for (const d of mine) {
      assert.equal(d.surface, "dm");
      assert.equal(d.origin.kind, "session");
      // Gap 2: the session's title, in the same slot a Reddit draft puts
      // `r/mechmarket`.
      assert.equal(d.origin.label, TITLE_A);
      assert.equal(d.room, TITLE_A);
      assert.equal(d.sessionId, showA);
      assert.equal(d.status, "open");
      assert.ok(d.question.author && d.question.text && d.draft);
    }
  });

  test("one operator never sees another's drafts", async () => {
    const mine = await queue(A);
    const theirs = await queue(B);
    assert.ok(mine.drafts.some((d) => d.id === `fu_${run}_1`));
    assert.ok(!theirs.drafts.some((d) => d.id.startsWith(`fu_${run}_1`)), "B cannot see A's");
    assert.ok(theirs.drafts.some((d) => d.id === `fu_${run}_3`));
    assert.ok(!mine.drafts.some((d) => d.id === `fu_${run}_3`), "A cannot see B's");
    // And the counts are each their own, not a shared total.
    assert.ok(mine.waiting.total >= 2);
    assert.ok(theirs.waiting.total >= 1);
  });

  test("the count on home is the list this endpoint returns — for each account", async () => {
    for (const who of [A, B]) {
      const [h, q] = await Promise.all([
        app.inject({ method: "GET", url: "/api/home", headers: who.headers }),
        queue(who),
      ]);
      assert.equal(h.statusCode, 200);
      const home = h.json() as { now: { drafts: QueueBody["waiting"] } };
      // Deep-equal, ordering included: one function builds both.
      assert.deepEqual(q.waiting, home.now.drafts);
      assert.equal(q.drafts.filter((d) => d.status === "open").length, home.now.drafts.total);
      for (const s of home.now.drafts.bySurface) {
        assert.equal(
          q.drafts.filter((d) => d.status === "open" && d.surface === s.surface).length,
          s.count,
          `${s.surface} count disagrees with the list it links to`,
        );
      }
    }
  });

  test("the filters shape the list and never the count above it", async () => {
    const all = await queue(A);
    const dm = await queue(A, "?surface=dm");
    assert.deepEqual(dm.waiting, all.waiting, "a tab must not change the heading");
    assert.ok(dm.drafts.every((d) => d.surface === "dm"));
    assert.equal(dm.surface, "dm");

    const open = await queue(A, "?status=open");
    assert.ok(open.drafts.every((d) => d.status === "open"));
    assert.equal(open.drafts.length, all.waiting.total);

    const badStatus = await app.inject({ method: "GET", url: "/api/drafts?status=posted", headers: A.headers });
    assert.equal(badStatus.statusCode, 400);
    const badSurface = await app.inject({ method: "GET", url: "/api/drafts?surface=twitchh", headers: A.headers });
    assert.equal(badSurface.statusCode, 404);
  });

  test("marking one sent takes it out of the count, and home agrees again", async () => {
    const before = await queue(A);
    const target = before.drafts.find((d) => d.status === "open")!;
    const r = await app.inject({
      method: "POST", url: `/api/drafts/${target.id}/sent`, headers: A.headers,
    });
    assert.equal(r.statusCode, 200, r.body);
    const { draft } = r.json() as { draft: SurfaceDraft };
    assert.equal(draft.status, "sent");
    assert.ok(draft.sentAt);
    // The origin survives the round trip: this is the row the page re-renders.
    assert.equal(draft.room, TITLE_A);

    const after = await queue(A);
    assert.equal(after.waiting.total, before.waiting.total - 1);
    const home = (await app.inject({ method: "GET", url: "/api/home", headers: A.headers })).json() as {
      now: { drafts: QueueBody["waiting"] };
    };
    assert.deepEqual(after.waiting, home.now.drafts);
    assert.equal(after.drafts.find((d) => d.id === target.id)?.status, "sent");
  });

  test("a stranger cannot mark or dismiss a draft that is not theirs", async () => {
    const mine = (await queue(A)).drafts.find((d) => d.status === "open")!;
    for (const verb of ["sent", "dismiss"]) {
      const r = await app.inject({
        method: "POST", url: `/api/drafts/${mine.id}/${verb}`, headers: B.headers,
      });
      assert.equal(r.statusCode, 404, `${verb} leaked`);
    }
    assert.equal((await queue(A)).drafts.find((d) => d.id === mine.id)?.status, "open");
  });

  test("the inbox's own endpoint is untouched — this was additive", async () => {
    const r = await app.inject({ method: "GET", url: "/api/followups", headers: A.headers });
    assert.equal(r.statusCode, 200);
    const body = r.json() as { status: string | null; followups: { id: string; showId: string }[] };
    assert.equal(body.status, null);
    assert.ok(body.followups.some((f) => f.id === `fu_${run}_1`));
    // Unchanged down to the field that gap 2 is about: `/api/followups` still
    // speaks in show ids, because a tab open on the old bundle still reads it.
    assert.equal(body.followups.find((f) => f.id === `fu_${run}_1`)?.showId, showA);
  });
});
