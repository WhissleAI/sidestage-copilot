// Reddit, without a network and without a key.
//
// Every payload here is a recorded shape — a `/new` listing, a profile's
// comments, a `/comments/<id>` tree, an `/about/rules` body — so what is being
// asserted is how we read Reddit, not how a mock we wrote answers us. The
// credentials are blank under test on purpose (see config.ts): a suite that can
// reach Reddit is a suite that can get an account rate-limited.
//
// The first test in the last block is the one that matters most. Reddit is
// monitor-and-draft, posting is off in CODE, and that decision should fail
// loudly the day somebody changes it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { redditAdapter, REDDIT_DELIVERY, watchFor } from "../src/surfaces/reddit/adapter.js";
import { RedditClient, RedditError, backoffMs, missingCredential, parseRateHeaders } from "../src/surfaces/reddit/api.js";
import { RedditPoller } from "../src/surfaces/reddit/poll.js";
import { CommunityRules, rulesToFacts } from "../src/surfaces/reddit/rules.js";
import {
  messagesFromListing, parseCommentTree, threadContextFor,
  type RedditListing,
} from "../src/surfaces/reddit/thread.js";
import { resolve as resolveSurface } from "../src/surfaces/registry.js";
import { capabilitiesOf, SurfaceUnavailable } from "../src/surfaces/types.js";
import { communityRuleGuard } from "../src/guardrails/guards.js";
import type { GuardInput } from "../src/guardrails/types.js";
import type { Fact } from "../src/retrieval/facts.js";
import { preflight, type PreflightContext } from "../src/actions/preflight.js";
import { admit, classify, classifyStance } from "../src/ingest/classify.js";
import type { SurfaceEvents } from "../src/surfaces/types.js";

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../fixtures/reddit/${name}`, import.meta.url), "utf8")) as T;

const NEW_LISTING = fixture<RedditListing>("new-listing.json");
const USER_COMMENTS = fixture<RedditListing>("user-comments.json");
const COMMENT_TREE = fixture<unknown>("comment-tree.json");
const RULES = fixture<{ rules: { short_name: string; description: string }[] }>("rules.json");

const CREDS = {
  clientId: "cid", clientSecret: "secret",
  username: "sidestage_bot", password: "pw",
  userAgent: "macos:ai.whissle.sidestage:v1.0 (by /u/kicksbyrae)",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const LIMIT_OK = { "x-ratelimit-remaining": "540", "x-ratelimit-reset": "480", "x-ratelimit-used": "60" };

/** A client whose every read answers with one payload, recording what was sent. */
function clientFor(payload: unknown | (() => unknown), headers = LIMIT_OK) {
  const sent: { url: string; init?: RequestInit }[] = [];
  const waits: number[] = [];
  const client = new RedditClient(
    CREDS,
    (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init });
      if (String(url).includes("/api/v1/access_token")) {
        return json({ access_token: "tok", expires_in: 3600 }, 200, headers);
      }
      return json(typeof payload === "function" ? (payload as () => unknown)() : payload, 200, headers);
    }) as typeof fetch,
    async (ms: number) => { waits.push(ms); },
  );
  return { client, sent, waits };
}

// ── what did the operator paste ──────────────────────────────────────────────

describe("reddit parseTarget", () => {
  const parse = (s: string) => redditAdapter.parseTarget(s);

  test("a subreddit, however it was written down", () => {
    for (const input of [
      "r/mechmarket",
      "/r/mechmarket",
      "R/MechMarket",
      "https://www.reddit.com/r/mechmarket/",
      "https://old.reddit.com/r/mechmarket/new/",
      "reddit.com/r/mechmarket",
    ]) {
      const t = parse(input);
      assert.equal(t?.meta?.kind, "subreddit", input);
      assert.equal(t?.meta?.subreddit?.toLowerCase(), "mechmarket", input);
    }
  });

  test("a user, in either of reddit's two spellings for one", () => {
    for (const input of [
      "u/linear_fan",
      "/u/linear_fan",
      "https://www.reddit.com/user/linear_fan/",
      "https://www.reddit.com/user/linear_fan/comments/",
    ]) {
      const t = parse(input);
      assert.equal(t?.meta?.kind, "user", input);
      assert.equal(t?.meta?.username, "linear_fan", input);
      assert.equal(t?.externalId, "u/linear_fan", input);
    }
  });

  test("a thread, as a permalink, a shortlink or a fullname", () => {
    const permalink = parse("https://www.reddit.com/r/mechmarket/comments/1n4k2qp/are_lubed_linears_worth_it/");
    assert.equal(permalink?.meta?.kind, "thread");
    // The fullname, not the short id: it is what `parent_id` and `link_id`
    // point at, so carrying the short form would mean translating at every
    // boundary and getting it wrong at one of them.
    assert.equal(permalink?.externalId, "t3_1n4k2qp");
    assert.equal(permalink?.meta?.subreddit, "mechmarket");

    assert.equal(parse("t3_1n4k2qp")?.externalId, "t3_1n4k2qp");
    assert.equal(parse("https://redd.it/1n4k2qp")?.externalId, "t3_1n4k2qp");
  });

  test("a link to one comment keeps the comment, because that is what a draft answers", () => {
    const t = parse("https://www.reddit.com/r/mechmarket/comments/1n4k2qp/some_slug/m9c3c3c/");
    assert.equal(t?.externalId, "t3_1n4k2qp");
    assert.equal(t?.meta?.focusCommentId, "t1_m9c3c3c");
  });

  test("what it refuses, and why each one would be worse than refusing", () => {
    // A bare word is as likely to be a typo as a subreddit, and this box is
    // shared with every other surface.
    assert.equal(parse("mechmarket"), null);
    assert.equal(parse(""), null);
    assert.equal(parse("   "), null);
    assert.equal(parse("not a link"), null);
    // A truncated thread link must NOT degrade into "watch the whole
    // subreddit" — that is how a copilot ends up reading a room nobody
    // pointed it at.
    assert.equal(parse("https://www.reddit.com/r/mechmarket/comments/ab"), null);
    // Suffix matching a hostname is how a lookalike domain gets a request
    // signed with a real token.
    assert.equal(parse("https://reddit.com.example.com/r/mechmarket"), null);
    assert.equal(parse("https://notreddit.com/r/mechmarket"), null);
    // An eBay event id is not a subreddit.
    assert.equal(parse("47tK1SX0VsiHEXN1"), null);
  });

  test("the registry routes reddit links to reddit and leaves eBay alone", () => {
    assert.equal(resolveSurface("r/mechmarket")?.adapter.id, "reddit");
    assert.equal(resolveSurface("https://www.reddit.com/r/mechmarket/comments/1n4k2qp/x/")?.adapter.id, "reddit");
    assert.equal(resolveSurface("47tK1SX0VsiHEXN1")?.adapter.id, "ebaylive");
    assert.equal(resolveSurface("demo")?.adapter.id, "simulated");
  });

  test("a target names the watch it describes", () => {
    assert.deepEqual(watchFor(redditAdapter.parseTarget("r/mechmarket")!), { kind: "subreddit", subreddit: "mechmarket" });
    assert.deepEqual(watchFor(redditAdapter.parseTarget("u/linear_fan")!), { kind: "user", username: "linear_fan" });
    assert.deepEqual(
      watchFor(redditAdapter.parseTarget("https://www.reddit.com/r/mechmarket/comments/1n4k2qp/x/")!),
      { kind: "thread", threadId: "t3_1n4k2qp", subreddit: "mechmarket" },
    );
  });
});

// ── reading what reddit sends ────────────────────────────────────────────────

describe("a recorded listing, as messages", () => {
  test("posts carry their own fullname as the thread they open", () => {
    const messages = messagesFromListing(NEW_LISTING);
    assert.equal(messages.length, 3);
    const first = messages[0]!;
    assert.equal(first.id, "t3_1n4k2qp");
    assert.equal(first.threadId, "t3_1n4k2qp", "a post IS its thread");
    assert.equal(first.parentId, undefined);
    assert.equal(first.room, "r/mechmarket");
    // Title and body are one utterance to a reader, and a post whose whole
    // question is in its title has an empty `selftext`.
    assert.match(first.text, /^Are lubed linears worth it on a budget TKL\?\n\n/);
    assert.equal(messages[1]!.text, "[US-CA] [H] Keychron Q1 v2, barely used [W] PayPal");
  });

  test("comments carry the post they live under and the thing above them", () => {
    const messages = messagesFromListing(USER_COMMENTS);
    const [reply, other] = messages;
    assert.equal(reply!.id, "t1_m9c3c3c");
    assert.equal(reply!.threadId, "t3_1n4k2qp", "the post, so the branch can be rebuilt");
    assert.equal(reply!.parentId, "t1_m9b2b2b", "the comment it answers");
    // One account, two rooms: the room travels with the message, because the
    // rules that constrain a reply are the room's.
    assert.equal(reply!.room, "r/mechmarket");
    assert.equal(other!.room, "r/MechanicalKeyboards");
    assert.equal(other!.parentId, "t3_1n2p7bb", "a top-level comment's parent is the post");
  });
});

describe("a recorded comment tree, as a thread context", () => {
  test("the branch above a message is the post and its ancestors, oldest first", () => {
    const thread = parseCommentTree(COMMENT_TREE);
    assert.equal(thread.threadId, "t3_1n4k2qp");
    assert.equal(thread.room, "r/mechmarket");

    const ctx = threadContextFor(thread, "t1_m9c3c3c");
    assert.deepEqual(ctx.ancestors.map((a) => a.author), ["kbd_curious", "switch_nerd", "kbd_curious"]);
    assert.match(ctx.ancestors[0]!.text, /Are lubed linears worth it/, "the opening post is the root");
    assert.match(ctx.ancestors[2]!.text, /Under \$150 all in/);
    // The sibling branch is the room's activity, not this conversation. A flat
    // sort by time would splice it in and the draft would answer a question
    // nobody in this subthread asked.
    assert.ok(!ctx.ancestors.some((a) => a.author === "hall_effect_guy"));
    assert.equal(ctx.threadId, "t3_1n4k2qp");
    assert.equal(ctx.room, "r/mechmarket");
  });

  test("`more` placeholders are skipped and a removed comment still counts as a rung", () => {
    const thread = parseCommentTree(COMMENT_TREE);
    const ids = thread.comments.map((c) => c.id);
    assert.deepEqual(ids, ["t1_m9a1a1a", "t1_m9b2b2b", "t1_m9c3c3c", "t1_m9d4d4d", "t1_m9e5e5e"]);
    assert.equal(thread.comments.find((c) => c.id === "t1_m9e5e5e")!.text, "[removed]");
  });

  test("a top-level comment still knows what the thread was about", () => {
    // Its parent IS the post, which `branchAbove` can only find because the
    // post is spliced into the same list.
    const ctx = threadContextFor(parseCommentTree(COMMENT_TREE), "t1_m9d4d4d");
    assert.deepEqual(ctx.ancestors.map((a) => a.author), ["kbd_curious"]);
  });
});

// ── the rules of the room ────────────────────────────────────────────────────

describe("a subreddit's rules, as constraints", () => {
  test("one fact per rule, numbered and named the way a moderator cites it", () => {
    const facts = rulesToFacts("mechmarket", RULES);
    assert.equal(facts.length, RULES.rules.length);
    assert.equal(facts.every((f) => f.corpus === "community"), true, "a rule constrains, it never grounds");
    const three = facts[2]!;
    assert.equal(three.factId, "community:mechmarket#3");
    assert.equal(three.label, "r/mechmarket rule 3 — No vendor self-promotion");
    assert.match(three.text, /^No vendor self-promotion\. Do not advertise/);
  });

  test("rules are read once an hour, not once a draft", async () => {
    const { client, sent } = clientFor(RULES);
    let now = 0;
    const rules = new CommunityRules(client, () => now);

    await rules.forSubreddit("r/mechmarket");
    await rules.forSubreddit("mechmarket");
    const reads = sent.filter((s) => s.url.includes("/about/rules")).length;
    assert.equal(reads, 1, "the second read came from the cache, and r/ is not part of the key");

    now += 61 * 60 * 1000;
    await rules.forSubreddit("mechmarket");
    assert.equal(sent.filter((s) => s.url.includes("/about/rules")).length, 2);
  });

  test("a draft that breaks a rule is blocked, and the block cites the rule", () => {
    const facts = rulesToFacts("mechmarket", RULES);
    const r = communityRuleGuard.run(guardInput(
      "Happy to help — we do vendor self promotion on our store page, link in bio.",
      facts,
    ));
    assert.equal(r.verdict, "block");
    assert.match(r.reason!, /r\/mechmarket rule 3 — No vendor self-promotion/);
    assert.match(r.reason!, /community:mechmarket#3/, "\"says who\" is answerable from the card");
    assert.equal(r.detail?.expected, "community:mechmarket#3");
  });

  test("a rule's quoted phrase is matched verbatim", () => {
    const facts = rulesToFacts("mechmarket", RULES);
    const r = communityRuleGuard.run(guardInput("Still have one left — DM me and I'll sort you out.", facts));
    assert.equal(r.verdict, "block");
    assert.equal(r.detail?.found, "dm me");
  });

  test("a reply that keeps to the rules is allowed", () => {
    const facts = rulesToFacts("mechmarket", RULES);
    const r = communityRuleGuard.run(guardInput(
      "Krytox 205g0 is what most people use on budget linears, and the build log lists the rest.",
      facts,
    ));
    assert.equal(r.verdict, "allow");
  });
});

function guardInput(answer: string, facts: Fact[]): GuardInput {
  return {
    draft: { answer, claims: [], parsedOk: true, raw: answer },
    question: "which lube for budget linears?",
    facts,
    factById: new Map(facts.map((f) => [f.factId, f])),
    currentListings: new Map(),
    slots: { listingIds: [], viaAnaphora: false } as unknown as GuardInput["slots"],
    policies: [],
    surface: capabilitiesOf("reddit"),
    community: facts.filter((f) => f.corpus === "community"),
  };
}

// ── pacing ───────────────────────────────────────────────────────────────────

describe("reddit's rate limit is a number it hands us, not a 429 to discover", () => {
  test("the headers are read off every response", () => {
    const r = parseRateHeaders(new Headers(LIMIT_OK))!;
    assert.deepEqual(r, { remaining: 540, resetS: 480, used: 60 });
    assert.equal(parseRateHeaders(new Headers({})), null, "no headers is not a budget of zero");
  });

  test("a full budget costs nothing and a nearly-spent one is spread over the window", () => {
    assert.equal(backoffMs({ remaining: 540, resetS: 480, used: 60 }), 0, "pacing a quiet poller buys nothing");
    // Five requests and sixty seconds left: one every twelve seconds, rather
    // than five into the next second and a block.
    assert.equal(backoffMs({ remaining: 5, resetS: 60, used: 595 }), 12_000);
    // Nothing left to spend. The only correct move is to wait out the window.
    assert.equal(backoffMs({ remaining: 0, resetS: 30, used: 600 }), 30_000);
    assert.equal(backoffMs(null), 0);
  });

  test("the client waits before the request that would have spent the last of it", async () => {
    const { client, waits } = clientFor(NEW_LISTING, {
      "x-ratelimit-remaining": "4", "x-ratelimit-reset": "40", "x-ratelimit-used": "596",
    });
    await client.get("/r/mechmarket/new");
    await client.get("/r/mechmarket/new");
    // The token mint is what first told us the budget was nearly gone, so the
    // very first read is already paced.
    assert.deepEqual(waits, [10_000, 10_000]);
    assert.equal(client.rateState?.remaining, 4);
  });

  test("a 429 is reported as our mistake, not as an expected outcome", async () => {
    const client = new RedditClient(
      CREDS,
      (async (url: string | URL | Request) =>
        String(url).includes("/api/v1/access_token")
          ? json({ access_token: "tok", expires_in: 3600 }, 200, LIMIT_OK)
          : json({ error: "too many requests" }, 429, LIMIT_OK)) as typeof fetch,
      async () => {},
    );
    await assert.rejects(
      () => client.get("/r/mechmarket/new"),
      (e: unknown) => e instanceof RedditError && e.status === 429 && /our pacing was wrong/.test(e.message),
    );
  });

  test("every request carries the user agent reddit rate-limits by, the token mint included", async () => {
    const { client, sent } = clientFor(NEW_LISTING);
    await client.get("/r/mechmarket/new");
    assert.equal(sent.length, 2, "a mint and a read");
    for (const s of sent) {
      const headers = (s.init?.headers ?? {}) as Record<string, string>;
      assert.equal(headers["User-Agent"], CREDS.userAgent, s.url);
    }
    // Without raw_json a quoted price range arrives as "&gt;$200" and the draft
    // quotes the escape back at the person who wrote it.
    assert.match(sent[1]!.url, /raw_json=1/);
  });

  test("one token is minted and reused", async () => {
    const { client, sent } = clientFor(NEW_LISTING);
    await client.get("/r/mechmarket/new");
    await client.get("/user/linear_fan/comments");
    assert.equal(sent.filter((s) => s.url.includes("/api/v1/access_token")).length, 1);
  });
});

// ── polling ──────────────────────────────────────────────────────────────────

describe("the poller", () => {
  const collector = () => {
    const messages: { id: string; threadId?: string; parentId?: string }[] = [];
    const status: string[] = [];
    const events: SurfaceEvents = {
      onMessage: (m) => { messages.push(m); },
      onStatus: (s) => { status.push(s.detail); },
    };
    return { events, messages, status };
  };

  test("the first pass seeds and emits nothing; the second emits only what is new", async () => {
    let page: RedditListing = NEW_LISTING;
    const { client } = clientFor(() => page);
    const { events, messages, status } = collector();
    const poller = new RedditPoller({ client, watch: { kind: "subreddit", subreddit: "mechmarket" }, events });

    assert.deepEqual(await poller.pollOnce(), [], "a backlog nobody asked for is not news");
    assert.equal(messages.length, 0);
    assert.match(status[0]!, /r\/mechmarket — 3 already here/);

    // Reddit answers `/new` newest first, so an arrival is prepended and every
    // row we already saw comes back with it.
    page = {
      ...NEW_LISTING,
      data: {
        ...NEW_LISTING.data,
        children: [
          {
            kind: "t3",
            data: {
              name: "t3_1n4kzzz", id: "1n4kzzz", subreddit: "mechmarket", author: "new_poster",
              title: "Which lube for budget linears?", selftext: "205g0 or 3204?",
              created_utc: 1789045200, permalink: "/r/mechmarket/comments/1n4kzzz/x/",
            },
          },
          ...NEW_LISTING.data.children,
        ],
      },
    };

    const fresh = await poller.pollOnce();
    assert.deepEqual(fresh.map((m) => m.id), ["t3_1n4kzzz"], "deduped by fullname, not by text or position");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.threadId, "t3_1n4kzzz");
    assert.equal(messages[0]!.parentId, undefined);
  });

  test("a watched profile's comments arrive with the branch they belong to", async () => {
    let page: RedditListing = { ...USER_COMMENTS, data: { ...USER_COMMENTS.data, children: [] } };
    const { client } = clientFor(() => page);
    const { events, messages } = collector();
    const poller = new RedditPoller({ client, watch: { kind: "user", username: "linear_fan" }, events });

    await poller.pollOnce();
    page = USER_COMMENTS;
    await poller.pollOnce();

    // Oldest first: reddit answers newest first, which is the wrong order for
    // reading a conversation.
    assert.deepEqual(messages.map((m) => m.id), ["t1_m8x9y0z", "t1_m9c3c3c"]);
    const inThread = messages.find((m) => m.id === "t1_m9c3c3c")!;
    assert.equal(inThread.threadId, "t3_1n4k2qp");
    assert.equal(inThread.parentId, "t1_m9b2b2b");
  });

  test("a watched thread emits the comments that appear under it", async () => {
    const { client } = clientFor(COMMENT_TREE);
    const { events, messages } = collector();
    const poller = new RedditPoller({ client, watch: { kind: "thread", threadId: "t3_1n4k2qp" }, events });
    await poller.pollOnce();
    assert.equal(messages.length, 0, "everything already in the thread is history, not an arrival");
    await poller.pollOnce();
    assert.equal(messages.length, 0, "and it is still history on the second pass");
  });

  test("a permanent failure stops the poll instead of spending a budget on it forever", async () => {
    const client = new RedditClient(
      CREDS,
      (async (url: string | URL | Request) =>
        String(url).includes("/api/v1/access_token")
          ? json({ access_token: "tok", expires_in: 3600 }, 200, LIMIT_OK)
          : json({ message: "Forbidden" }, 403, LIMIT_OK)) as typeof fetch,
      async () => {},
    );
    const ended: string[] = [];
    const poller = new RedditPoller({
      client,
      watch: { kind: "subreddit", subreddit: "private_sub" },
      events: { onEnded: (why) => { ended.push(why); } },
      schedule: () => { throw new Error("a stopped poller must not reschedule"); },
    });
    await poller.start();
    assert.equal(ended.length, 1);
    assert.match(ended[0]!, /403/);
  });
});

// ── the third axis ───────────────────────────────────────────────────────────

describe("asking, complaining, baiting", () => {
  test("a question with an answer is asking, on either surface", () => {
    for (const t of [
      "which lube for budget linears?",
      "does this ship to canada",
      "is this a scam or are they legit?",
    ]) assert.equal(classifyStance(t), "asking", t);
  });

  test("a grievance is a complaint, not an FAQ lookup", () => {
    for (const t of [
      "Third time I've asked about my refund and still no response.",
      "Ordered six weeks ago, never arrived, this is ridiculous",
      "It arrived cracked and nobody will answer me",
    ]) assert.equal(classifyStance(t), "complaining", t);
    // A complaint is still worth a reply — the stance changes how it should be
    // answered, not whether.
    const d = admit("Third time I've asked about my refund and still no response.", "returns", true);
    assert.equal(d.stance, "complaining");
  });

  test("bait never becomes a draft — it becomes a hand-off", () => {
    for (const t of [
      "lol this whole thing is a scam, prove me wrong",
      "you're just a bot, nobody asked",
      "obvious shill is obvious",
      "cope harder",
    ]) {
      assert.equal(classifyStance(t), "baiting", t);
      const d = admit(t, classify(t), true);
      assert.equal(d.admitted, false, t);
      // Not merely "we stayed quiet": somebody was asked to look, and the
      // console has to be able to show that.
      assert.equal(d.handoff, "flag_for_human", t);
      assert.match(d.reason!, /bait/);
    }
  });

  test("the first two axes are untouched by the third", () => {
    // The stance axis must not quietly re-decide what the other two decided.
    assert.equal(classify("whats the lowest on the chicagos?"), "discount_request");
    assert.equal(admit("i'll take it", classify("i'll take it"), true).admitted, true);
    assert.equal(admit("W", "hype", true).admitted, false);
    assert.equal(classifyStance("W"), "neutral");
    assert.equal(classifyStance("Steal right there"), "neutral");
  });
});

// ── the product rule ─────────────────────────────────────────────────────────

describe("reddit is monitor-and-draft", () => {
  test("delivery is draft-only, in the adapter and in the table both", () => {
    // If this ever fails, read the diff before fixing the test. Undisclosed
    // automation replying as a person breaks Reddit's own rules and is
    // reputationally fatal; the value is a grounded draft with its sources,
    // which a human sends from their own account.
    assert.equal(redditAdapter.capabilities.delivery, "draft-only");
    assert.equal(REDDIT_DELIVERY, "draft-only");
    assert.equal(capabilitiesOf("reddit").delivery, "draft-only", "the table and the adapter must not drift");
  });

  test("post_reply is not an action this surface has, and preflight refuses it", () => {
    assert.equal(redditAdapter.capabilities.actions.includes("post_reply"), false);
    assert.deepEqual([...redditAdapter.capabilities.actions], ["flag_for_human"]);

    const ctx = (posting?: { room: string; enabled: boolean }): PreflightContext => ({
      surface: redditAdapter.capabilities,
      posting,
      committedThisShow: 0, actionBudget: 10, committedLastMinute: 0, ratePerMinute: 6,
    });

    // Two locks, and a room switched on opens neither of them.
    const on = preflight("post_reply", null, {}, ctx({ room: "r/mechmarket", enabled: true }));
    assert.equal(on.ok, false);
    assert.match(on.checks[0]!.detail, /draft-only/);
    assert.equal(preflight("post_reply", null, {}, ctx()).ok, false);

    // The one action it does have still works: bait, and anything else that
    // should not be drafted at all, reaches a person.
    assert.equal(preflight("flag_for_human", null, {}, ctx()).ok, true);
  });

  test("without keys, open() is a typed refusal naming the variable", async () => {
    await assert.rejects(
      () => redditAdapter.open({ externalId: "r/mechmarket", meta: { kind: "subreddit", subreddit: "mechmarket" } }, {}),
      (e: unknown) => e instanceof SurfaceUnavailable && e.surface === "reddit" && e.missing === "REDDIT_CLIENT_ID",
    );
    // Each variable in turn, so the operator is told about the gap they
    // actually have rather than the first one we thought of.
    assert.equal(missingCredential({}), "REDDIT_CLIENT_ID");
    assert.equal(missingCredential({ ...CREDS, userAgent: "" }), "REDDIT_USER_AGENT");
    assert.equal(missingCredential({ ...CREDS, password: "" }), "REDDIT_PASSWORD");
    assert.equal(missingCredential(CREDS), null);
  });

  test("capabilities resolve without a key, so the console can say what reddit would do", () => {
    const c = redditAdapter.capabilities;
    assert.equal(c.tempo, "async");
    assert.deepEqual(c.perception, { audio: false, video: false });
    assert.equal(c.communityRules, true);
    assert.equal(c.corpora.includes("listing"), false, "there is no catalog behind a subreddit");
    assert.equal(c.corpora.includes("community"), true);
  });
});
