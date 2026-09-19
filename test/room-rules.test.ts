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

/** What the model says. Set per test; breaks rule 3 by default. */
let reply = JSON.stringify({
  answer: "Happy to help — we do vendor self promotion on our store page, link in bio.",
  claims: [],
});
/** Every URL the process asked for, so "no network" is an assertion. */
const asked: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-remaining": "540", "x-ratelimit-reset": "480", "x-ratelimit-used": "60",
    },
  });

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  asked.push(url);
  if (url.includes("/api/v1/access_token")) return json({ access_token: "tok", expires_in: 3600 });
  if (url.includes("/about/rules")) return json(RULES);
  // The streaming door is absent on this "gateway", which the client handles by
  // taking the JSON door — the same degradation an older gateway gets.
  if (url.includes("/chat/turn/stream")) return new Response("no such route", { status: 404 });
  if (url.includes("/chat/turn")) return json({ reply });
  throw new Error(`the suite asked for ${url}`);
}) as typeof fetch;

const { ShowRuntime } = await import("../src/shows/runtime.js");
const { redditAdapter, constraintsFrom } = await import("../src/surfaces/reddit/adapter.js");
const { CommunityRules } = await import("../src/surfaces/reddit/rules.js");
const { RedditClient } = await import("../src/surfaces/reddit/api.js");
const { register } = await import("../src/surfaces/registry.js");
const { draftsFromSession } = await import("../src/api/drafts.js");
const { db, migrate, closeDb } = await import("../src/db/pg.js");

type Runtime = InstanceType<typeof ShowRuntime>;

/** The real rules store, over Reddit's own recorded `/about/rules` body. */
const store = new CommunityRules(
  new RedditClient({
    clientId: "cid", clientSecret: "secret", username: "sidestage_bot", password: "pw",
    userAgent: "macos:ai.whissle.sidestage:v1.0 (by /u/kicksbyrae)",
  }),
);

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
