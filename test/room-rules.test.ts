/**
 * A community rule reaching a draft, on a watch that is actually running.
 *
 * `communityRuleGuard` was written, tested and correct, and it had never once
 * fired on a real session — because `GuardInput.community` was
 * `retrieved.facts.filter(corpus === "community")` and the retriever's index is
 * the seller's listings and policies. A subreddit's rules had no route into it.
 * Both producers of a community fact in this codebase (`reddit/rules.ts` and
 * `twitch/corpus.ts`) were handed to nothing, so the guard hit
 * `if (!rules.length) return na(...)` every time, and every draft written for a
 * subreddit went to the operator unchecked against the one set of rules whose
 * penalty is a ban.
 *
 * The rules are a per-room input of their own now (`SurfaceAdapter.
 * constraintsFor` → `PipelineDeps.constraints` → `GuardInput.community`), and
 * this drives the whole of it: a real `ShowRuntime`, the real Reddit adapter,
 * the real `CommunityRules` over Reddit's recorded `/about/rules` payload, the
 * real composer and the real guard chain.
 *
 * Nothing leaves the process. `globalThis.fetch` is replaced before anything is
 * imported, so both the Reddit client and the Whissle gateway client — each of
 * which reaches for the global — are answered from fixtures, and a request to
 * anywhere else fails the test rather than going out.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Before any import that reads them. No REDDIT_* here: `config.ts` blanks
// those under test on purpose, so that a suite cannot reach Reddit and get an
// account rate-limited, and this file does not argue with that — it drives the
// real `CommunityRules` over Reddit's recorded payload with its own client.
process.env.CATALOGS_DIR = ".tmp/test-catalogs-room-rules";
process.env.WHISSLE_API_KEY = "test-key";
process.env.WHISSLE_AGENT_ID = "agent_test";
process.env.WHISSLE_BASE = "https://gateway.invalid/bot";

const RULES = JSON.parse(readFileSync(new URL("../fixtures/reddit/rules.json", import.meta.url), "utf8"));
const COMMENT_TREE = JSON.parse(
  readFileSync(new URL("../fixtures/reddit/comment-tree.json", import.meta.url), "utf8"),
);

/** What the model says. Set per test; breaks rule 3 by default. */
let reply = JSON.stringify({
  answer: "Happy to help — we do vendor self promotion on our store page, link in bio.",
  claims: [],
});
/** Every request the process made, so "no network" and "nothing is ever
 *  posted to Reddit" are both assertions rather than beliefs. */
const asked: string[] = [];
const requests: { url: string; method: string }[] = [];
/** The last context block the composer sent the gateway — the prompt the
 *  thread has to actually reach. */
let lastContext = "";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-remaining": "540", "x-ratelimit-reset": "480", "x-ratelimit-used": "60",
    },
  });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  asked.push(url);
  requests.push({ url, method: String(init?.method ?? "GET").toUpperCase() });
  if (url.includes("/chat/turn")) {
    lastContext = String((JSON.parse(String(init?.body ?? "{}")) as { context?: string }).context ?? "");
  }
  if (url.includes("/api/v1/access_token")) return json({ access_token: "tok", expires_in: 3600 });
  if (url.includes("/about/rules")) return json(RULES);
  if (url.includes("/comments/")) return json(COMMENT_TREE);
  // The streaming door is absent on this "gateway", which the client handles by
  // taking the JSON door — the same degradation an older gateway gets.
  if (url.includes("/chat/turn/stream")) return new Response("no such route", { status: 404 });
  if (url.includes("/chat/turn")) return json({ reply });
  throw new Error(`the suite asked for ${url}`);
}) as typeof fetch;

const { ShowRuntime } = await import("../src/shows/runtime.js");
const { redditAdapter, constraintsFrom, threadFrom } = await import("../src/surfaces/reddit/adapter.js");
const { CommunityRules } = await import("../src/surfaces/reddit/rules.js");
const { RedditClient } = await import("../src/surfaces/reddit/api.js");
const { register } = await import("../src/surfaces/registry.js");
const { draftsFromSession } = await import("../src/api/drafts.js");
const { db, migrate, closeDb } = await import("../src/db/pg.js");

type Runtime = InstanceType<typeof ShowRuntime>;

/** A Reddit client with a key, answered by the stub above. The process-wide
 *  one has no credentials under test, on purpose. */
const client = new RedditClient({
  clientId: "cid", clientSecret: "secret", username: "sidestage_bot", password: "pw",
  userAgent: "macos:ai.whissle.sidestage:v1.0 (by /u/kicksbyrae)",
});

/** The real rules store, over Reddit's own recorded `/about/rules` body. */
const store = new CommunityRules(client);

/**
 * Reddit, with its `open()` replaced and nothing else.
 *
 * The credential check inside the real `open()` is the one thing this file
 * cannot drive (see above), and it is not what is under test. `constraintsFor`
 * is the production function — the adapter's own method is a one-line
 * delegation to it — reading a store this file filled the way an attach does.
 */
register({
  ...redditAdapter,
  open: async () => ({ stop: async () => {} }),
  constraintsFor: (t, room) => constraintsFrom(store, t, room),
  threadFor: (t, m, ruleFacts) => threadFrom(client, t, m, ruleFacts),
});

const showId = `reddit_rules_${process.pid.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
let rt: Runtime;

before(async () => {
  await migrate(db());
  // What `redditAdapter.open` does at attach: read the room's rules once, into
  // the cache the draft path then answers from.
  await store.forSubreddit("r/mechmarket");
  rt = new ShowRuntime({
    showId,
    title: "r/mechmarket",
    sellerHandle: "r/mechmarket",
    source: "reddit",
    externalId: "r/mechmarket",
    target: redditAdapter.parseTarget("r/mechmarket"),
    events: { emit: () => {} },
  });
  // `init()` creates the row, on the reddit surface — which is what makes
  // `capabilitiesOf(show.source).communityRules` true and the guard applicable
  // at all. A seeded live-commerce show would answer n/a for a different and
  // entirely correct reason.
  await rt.init();
  await rt.start();
});

after(async () => {
  await rt.close().catch(() => {});
  await db().query("DELETE FROM shows WHERE id = $1", [showId]).catch(() => {});
  await closeDb();
});

/** Ingest one comment and wait for the proposal it becomes. The reply path is
 *  bounded fan-out behind the `ingest` call, so the proposal does not exist yet
 *  when it returns. */
const draftFor = async (text: string) => {
  const id = `t1_${Math.random().toString(36).slice(2, 8)}`;
  await rt.pipeline.ingest({
    author: "kbd_curious", text, externalId: id,
    threadId: "t3_1n4k2qp", room: "r/mechmarket",
  });
  const settled = () =>
    rt.pipeline.list().find((p) => p.message.id === id && p.status !== "drafting");
  for (let i = 0; i < 100 && !settled(); i++) await new Promise((r) => setTimeout(r, 25));
  const p = settled();
  assert.ok(p, `no proposal for "${text}"`);
  return p;
};

describe("the rules of the room reach the guard chain", () => {
  test("attaching a subreddit reads its rules, and the adapter can hand them over", () => {
    const facts = constraintsFrom(store, redditAdapter.parseTarget("r/mechmarket")!, null);
    assert.equal(facts.length, RULES.rules.length, "the room's rules, in hand at draft time");
    assert.equal(facts.every((f) => f.corpus === "community"), true, "constraints, never grounding");
    assert.equal(facts[2]!.factId, "community:mechmarket#3");
    // From the cache the attach filled — not a read on the reply path.
    assert.equal(asked.filter((u) => u.includes("/about/rules")).length, 1);
  });

  test("a draft that breaks rule 3 is BLOCKED, and the block cites the rule", async () => {
    const p = await draftFor("anyone know where to get budget linears?");
    const community = p.guards.find((g) => g.guard === "community_rule")!;
    assert.notEqual(community.verdict, "n/a", "this is the verdict it gave on every real watch");
    assert.equal(community.verdict, "block");
    assert.match(community.reason!, /r\/mechmarket rule 3 — No vendor self-promotion/);
    assert.match(community.reason!, /community:mechmarket#3/, '"says who" is answerable from the card');
    assert.equal(p.status, "blocked");
  });

  test("the card names every rule that was in force and the one that held it", async () => {
    const p = rt.pipeline.list().find((x) => x.status === "blocked")!;
    const summary = {
      showId, source: "reddit" as const, sellerHandle: "r/mechmarket",
      title: "r/mechmarket", externalId: "r/mechmarket",
    };
    const draft = draftsFromSession(
      summary as unknown as Parameters<typeof draftsFromSession>[0],
      [p],
    )[0]!;
    assert.equal(draft.rules?.length, RULES.rules.length);
    const held = draft.rules!.find((r) => r.effect === "blocked")!;
    assert.equal(held.factId, "community:mechmarket#3");
    assert.ok(held.reason, "the guard's own words, on the rule that held it");
    // The rules are NOT citations: an answer with no grounding still abstained.
    assert.equal(draft.evidence?.some((e) => e.corpus === "community"), false);
  });

  test("a reply that keeps to the rules is allowed by the same guard", async () => {
    reply = JSON.stringify({
      answer: "Krytox 205g0 is what most people use on budget linears.",
      claims: [],
    });
    const p = await draftFor("which lube for budget linears?");
    assert.equal(p.guards.find((g) => g.guard === "community_rule")!.verdict, "allow");
    // It is still held, by `claim_grounding` — there is no catalog behind a
    // subreddit and this answer cites nothing. A different guard, doing its own
    // job: what matters here is that the room's rules did not hold it.
    assert.equal(p.guards.some((g) => g.guard === "community_rule" && g.verdict === "block"), false);
  });
});

/**
 * The branch above the comment, on the way to the model.
 *
 * `threadContextFor` and `fetchThread` were complete, tested and had no
 * production caller: `ShowRuntime.onMessage` dropped the ids a branch is built
 * from, so `Pipeline.draft` had nothing to build one with and `threadBlock` in
 * the compose prompt was unreachable. The Drafts page rendered a thread section
 * it could never be sent, under a heading that said "It reads the thread".
 */
describe("a draft answers the conversation, not the comment", () => {
  test("the opening post and the branch above the comment reach the prompt", async () => {
    reply = JSON.stringify({ answer: "Krytox 205g0 is the usual pick.", claims: [] });
    const id = "t1_m9c3c3c";
    await rt.pipeline.ingest({
      author: "kbd_curious",
      text: "would 205g0 be overkill on a budget board?",
      externalId: id,
      threadId: "t3_1n4k2qp",
      parentId: "t1_m9b2b2b",
      room: "r/mechmarket",
    });
    const settled = () => rt.pipeline.list().find((p) => p.message.id === id && p.status !== "drafting");
    for (let i = 0; i < 100 && !settled(); i++) await new Promise((r) => setTimeout(r, 25));
    const p = settled()!;

    // The branch, oldest first, with the opening post as its root — and
    // WITHOUT the sibling subthread, which is the room's activity rather than
    // this conversation.
    assert.deepEqual(
      p.thread?.ancestors.map((a) => a.author),
      ["kbd_curious", "switch_nerd", "kbd_curious"],
    );
    assert.match(p.thread!.ancestors[0]!.text, /Are lubed linears worth it/);
    assert.equal(p.thread?.threadId, "t3_1n4k2qp");
    assert.equal(p.thread?.room, "r/mechmarket");

    // In the prompt, as data, with the rules of the room under it as
    // constraints rather than as things to answer from.
    assert.match(lastContext, /=== THE THREAD ===/);
    assert.match(lastContext, /Are lubed linears worth it/);
    assert.match(lastContext, /Rules in force in this room/);
    assert.match(lastContext, /No vendor self-promotion/);

    // And on the card the operator reads.
    const summary = {
      showId, source: "reddit" as const, sellerHandle: "r/mechmarket",
      title: "r/mechmarket", externalId: "r/mechmarket",
    };
    const draft = draftsFromSession(
      summary as unknown as Parameters<typeof draftsFromSession>[0],
      [p],
    )[0]!;
    assert.equal(draft.thread?.ancestors.length, 3);
    assert.equal(draft.thread?.rules.every((r) => r.corpus === "community"), true);
  });

  test("a POST opens its own thread, and we do not spend a request to discover it", async () => {
    const before = asked.filter((u) => u.includes("/comments/")).length;
    const ctx = await threadFrom(
      client,
      redditAdapter.parseTarget("r/mechmarket")!,
      { id: "t3_1n4k2qp", threadId: "t3_1n4k2qp", room: "r/mechmarket" },
      [],
    );
    assert.equal(ctx, null);
    assert.equal(asked.filter((u) => u.includes("/comments/")).length, before);
  });
});

/**
 * Marking a draft sent, twice.
 *
 * `FollowUpInbox.markSent` has been idempotent since it was written — one
 * statement, `sent_at = COALESCE(sent_at, now())`. `Pipeline.send` had no such
 * guard: a second call on an already-sent proposal re-wrote the row, counted
 * another send on the live metrics, and appended a SECOND `reply_sent` entry to
 * the hash-chained audit log — the ledger that exists to answer "what did this
 * copilot and this seller actually do". `POST /api/drafts/:id/sent` routes
 * straight to it with no prior-state check, so a double click was enough.
 */
describe("marking a session draft sent", () => {
  test("a retry hands back what was sent and writes nothing twice", async () => {
    // A deferral cites nothing and is allowed to: see `claimGroundingGuard`.
    reply = JSON.stringify({ answer: "Let me check on that and come back to you.", claims: [] });
    const p = await draftFor("do you ship to canada?");
    assert.notEqual(p.status, "blocked", JSON.stringify(p.guards));

    const first = await rt.pipeline.send(p.id, undefined, "seller");
    assert.equal(first.status, "sent");
    assert.ok(first.sentAt, "the Sent list has a time to show");

    const again = await rt.pipeline.send(p.id, undefined, "seller");
    assert.equal(again.sentAt, first.sentAt, "the moment it went does not move");
    assert.equal(again.sentText, first.sentText);

    // No sleep. `send` awaits its own ledger write now — see `Pipeline.record`.
    // This used to be `await new Promise((r) => setTimeout(r, 100))` against a
    // fire-and-forget append, and under parallel load 100 ms was sometimes not
    // enough: the test failed roughly one run in three with `sent.length === 0`.
    const sent = (await rt.audit.list(200)).filter(
      (e) => e.kind === "reply_sent" && e.detail?.proposalId === p.id,
    );
    assert.equal(sent.length, 1, "one thing happened, so there is one entry for it");
    // And the chain is still a chain.
    assert.equal((await rt.audit.verify()).ok, true);
  });
});

/**
 * The product rule, over everything this file just did.
 *
 * Reddit is monitor-and-draft: posting is off in CODE, not in configuration.
 * Reading a room's rules and rebuilding a thread are two new reasons for this
 * process to talk to Reddit, and the only correct number of non-GET requests
 * either of them may make is zero. The token mint is the one POST the module
 * has, and it is a POST because OAuth says so.
 */
describe("nothing was posted to reddit", () => {
  test("every reddit request was a GET, except the token mint", () => {
    const toReddit = requests.filter((r) => /reddit\.com/.test(r.url));
    assert.ok(toReddit.length > 0, "this file did talk to reddit");
    for (const r of toReddit) {
      if (r.url.includes("/api/v1/access_token")) {
        assert.equal(r.method, "POST", "the mint, and only the mint");
        continue;
      }
      assert.equal(r.method, "GET", r.url);
    }
    // And what it read: the rules of a room, and a comment tree.
    assert.ok(toReddit.some((r) => r.url.includes("/about/rules")));
    assert.ok(toReddit.some((r) => r.url.includes("/comments/")));
  });
});
