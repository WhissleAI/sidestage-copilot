/**
 * The queue after a restart.
 *
 * `GET /api/drafts` read the async half of the queue out of live in-memory
 * runtimes — `shows.list()` → `shows.get(id).pipeline.list()` — so a deploy, a
 * detach, or a subreddit going private silently emptied the Drafts page of
 * every reply written for that room. The drafts were durable the whole time:
 * `SessionRecord.recordProposal` writes each one to `reply_proposals`. Nothing
 * read them back, and the session appeared in neither "now" (no runtime) nor
 * "behind you" (no report), so nothing said it had happened either.
 *
 * Every row here is written the way the recorder writes one, with no runtime
 * anywhere in the process — which is exactly the state a restart leaves.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

process.env.CATALOGS_DIR = ".tmp/test-catalogs-stored";

import { db as pgPool } from "../src/db/pg.js";
import type { SurfaceDraft } from "../src/api/drafts.js";

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

const run = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
const showA = `reddit_stored_${run}_a`;
const showB = `reddit_stored_${run}_b`;
let A: { headers: Record<string, string>; id: string };
let B: { headers: Record<string, string>; id: string };

/** A row exactly as `SessionRecord.recordProposal` writes one. */
const storeDraft = async (
  showId: string,
  id: string,
  over: { status?: string; question?: string; draft?: string; url?: string; room?: string } = {},
) => {
  await pgPool().query(
    `INSERT INTO reply_proposals (show_id, id, message_id, author, question, draft, status, verdict,
       confidence, guards, evidence, rules, thread, at, url, room)
     VALUES ($1,$2,$3,'kbd_curious',$4,$5,$6,'allow',0.8,'[]'::jsonb,'[]'::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11)`,
    [
      showId, id, `msg_${id}`,
      over.question ?? "which lube for budget linears?",
      over.draft ?? "Krytox 205g0 is the usual pick.",
      over.status ?? "ready",
      JSON.stringify([{
        factId: "community:mechmarket#3", source: "policy", corpus: "community",
        label: "r/mechmarket rule 3 — No vendor self-promotion",
        text: "No vendor self-promotion.", score: 0,
      }]),
      JSON.stringify({
        threadId: "t3_1n4k2qp", room: "r/mechmarket", summary: null, rules: [],
        ancestors: [{ author: "kbd_curious", text: "Are lubed linears worth it?", at: "2026-09-18T10:00:00.000Z" }],
      }),
      "2026-09-19T09:00:00.000Z",
      over.url ?? "https://www.reddit.com/r/mechmarket/comments/1n4k2qp/x/m9c3c3c/",
      over.room ?? "r/mechmarket",
    ],
  );
};

before(async () => {
  ({ app, ctx } = await buildApp());
  A = await register("stored-owner");
  B = await register("stored-stranger");
  const p = pgPool();
  for (const [id, owner] of [[showA, A.id], [showB, B.id]] as const) {
    await p.query(
      `INSERT INTO shows (id, owner_account_id, title, seller_handle, source, surface, external_id,
         started_at, status, autonomy_level, undo_window_s)
       VALUES ($1, $2, 'r/mechmarket', 'r/mechmarket', 'reddit', 'reddit', 'r/mechmarket',
         now(), 'ended', 'L1_SUGGEST', 90)`,
      [id, owner],
    );
  }
  await storeDraft(showA, `prop_${run}_1`);
  await storeDraft(showA, `prop_${run}_2`, { question: "205g0 or 3204?", status: "blocked" });
  await storeDraft(showB, `prop_${run}_3`, { question: "someone else's room" });
});

after(async () => {
  const p = pgPool();
  for (const id of [showA, showB]) await p.query("DELETE FROM shows WHERE id = $1", [id]).catch(() => {});
  await app.close();
  await ctx.stop();
});

interface QueueBody {
  waiting: { total: number; bySurface: { surface: string; count: number }[] };
  drafts: SurfaceDraft[];
}

const queue = async (who: { headers: Record<string, string> }, qs = "") => {
  const r = await app.inject({ method: "GET", url: `/api/drafts${qs}`, headers: who.headers });
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as QueueBody;
};

describe("a draft outlives the process that wrote it", () => {
  test("a room with no runtime still has its drafts in the queue", async () => {
    const body = await queue(A);
    const mine = body.drafts.filter((d) => d.id.startsWith(`prop_${run}`));
    assert.equal(mine.length, 2, "the whole room's queue, not an empty page");
    const open = mine.find((d) => d.status === "open")!;
    assert.equal(open.surface, "reddit");
    assert.equal(open.room, "r/mechmarket");
    assert.equal(open.sessionId, showA);
    assert.equal(open.question.url, "https://www.reddit.com/r/mechmarket/comments/1n4k2qp/x/m9c3c3c/");
    // What the card renders: the branch above the comment, and the rules that
    // were in force when it was written — kept, not recomputed.
    assert.equal(open.thread?.ancestors.length, 1);
    assert.equal(open.rules?.[0]?.factId, "community:mechmarket#3");
    // A guard held the other one, and the queue says so rather than hiding it.
    assert.equal(mine.find((d) => d.id.endsWith("_2"))!.status, "blocked");
  });

  test("home counts them, and the count is still the list", async () => {
    const home = (await app.inject({ method: "GET", url: "/api/home", headers: A.headers })).json() as {
      now: { drafts: QueueBody["waiting"] };
    };
    const body = await queue(A);
    assert.deepEqual(home.now.drafts, body.waiting, "home and the queue are one fact");
    assert.equal(body.waiting.bySurface.some((s) => s.surface === "reddit" && s.count >= 1), true);
  });

  test("a stranger's restored drafts are not in anyone else's queue", async () => {
    const body = await queue(B);
    assert.equal(body.drafts.some((d) => d.id === `prop_${run}_1`), false);
    assert.equal(body.drafts.some((d) => d.id === `prop_${run}_3`), true);
    // And acting on one you cannot see is a 404, not a confirmation it exists.
    const r = await app.inject({
      method: "POST", url: `/api/drafts/prop_${run}_1/sent`, headers: B.headers,
    });
    assert.equal(r.statusCode, 404);
  });

  test("marking a restored draft sent works, and works once", async () => {
    const id = `prop_${run}_1`;
    const first = await app.inject({ method: "POST", url: `/api/drafts/${id}/sent`, headers: A.headers });
    assert.equal(first.statusCode, 200, first.body);
    const sent = (first.json() as { draft: SurfaceDraft }).draft;
    assert.equal(sent.status, "sent");
    assert.ok(sent.sentAt, "the Sent list has a time to show");

    const again = await app.inject({ method: "POST", url: `/api/drafts/${id}/sent`, headers: A.headers });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal((again.json() as { draft: SurfaceDraft }).draft.sentAt, sent.sentAt, "the moment does not move");

    // One thing happened, so the ledger has one entry for it.
    const entries = await pgPool().query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM audit WHERE show_id = $1 AND kind = 'reply_sent'", [showA],
    );
    assert.equal(entries.rows[0]?.c, 1);
  });

  test("a blocked draft cannot be marked sent, restored or not", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/drafts/prop_${run}_2/sent`, headers: A.headers,
    });
    assert.equal(r.statusCode, 409);
    assert.match((r.json() as { error: string }).error, /blocked/);
  });

  test("dismissing a restored draft takes it out of the waiting count", async () => {
    const before = (await queue(A)).waiting.total;
    const r = await app.inject({
      method: "POST", url: `/api/drafts/prop_${run}_2/dismiss`, headers: A.headers,
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((r.json() as { draft: SurfaceDraft }).draft.status, "dismissed");
    assert.equal((await queue(A)).waiting.total, before, "it was blocked, so it was never waiting");
  });
});
