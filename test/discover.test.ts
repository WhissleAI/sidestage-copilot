// Discovery, on every surface, with no key and no browser.
//
// Four things in here are load-bearing, and they are the four the product would
// be worst at getting wrong:
//
//   1. **A derived term the operator deletes stays deleted.** Not until the
//      next import — permanently. If that fails, the chips are decoration.
//   2. **Every hit says why it is on screen.** A card that cannot name the
//      interest that put it there does not belong there, and the only exception
//      is a caller explicitly asking for everything live on one surface.
//   3. **A surface that cannot answer still returns a source**, with the
//      environment variable spelled exactly as `SurfaceUnavailable` spells it.
//      A missing tab reads as a broken product.
//   4. **One operator never sees another's interests**, on any path.
//
// Twitch and Reddit are exercised against RECORDED SHAPES through the seams
// both clients already have — `TwitchApi`'s injectable fetcher and
// `RedditClient`'s constructor — because the suite has no keys and must never
// acquire any: a test that could reach Twitch fails on somebody else's outage
// and a test that could reach Reddit can get an account rate-limited. Whatnot's
// DOM read runs over a fixture through the same `domlite` the room scrapers use.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";

import { domFromHtml, withDocument } from "./domlite.js";
import {
  InterestStore, deriveInterests, slugify, itemForDerivation, type DerivationItem,
} from "../src/discover/interests.js";
import { mentions, rank, whyFor } from "../src/discover/match.js";
import { DiscoverService } from "../src/discover/service.js";
import { ebayLiveSource } from "../src/discover/sources/ebaylive.js";
import { twitchSource, missingForDiscovery } from "../src/discover/sources/twitch.js";
import { redditSource, RedditBudgetReserved } from "../src/discover/sources/reddit.js";
import { whatnotSource, whatnotDiscoveryEnabled } from "../src/discover/sources/whatnot.js";
import { tiktokLiveSource } from "../src/discover/sources/tiktoklive.js";
import { readBrowseInPage, WHATNOT_BROWSE_SELECTORS } from "../src/surfaces/whatnot/browse.js";
import { RedditClient } from "../src/surfaces/reddit/api.js";
import { requireTwitchCreds } from "../src/surfaces/twitch/api.js";
import { requireCreds as requireRedditCreds } from "../src/surfaces/reddit/api.js";
import { SurfaceUnavailable, type SurfaceId } from "../src/surfaces/types.js";
import { getCatalog } from "../src/shows/catalogs.js";
import type { DiscoverHit, DiscoverSource } from "../src/discover/types.js";
import { db as pgPool } from "../src/db/pg.js";

const fixture = <T>(path: string): T =>
  JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8")) as T;
const html = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// ── deriving interests from Knowledge ────────────────────────────────────────

describe("what an operator sells, read off their catalog", () => {
  const sneakers = (getCatalog("kicksbyrae")?.items ?? []).map(itemForDerivation);
  const cards = (getCatalog("curated-cards")?.items ?? []).map(itemForDerivation);

  test("a sneaker catalog derives sneaker terms, not vocabulary", () => {
    const terms = deriveInterests(sneakers).map((t) => t.slug);
    assert.ok(terms.length, "the catalog is not empty, so the chips are not");
    // The brands are what this seller actually sells, and they come off eBay's
    // own aspect fields rather than off a guess about the title.
    assert.ok(terms.includes("nike"), `no nike in ${terms.join(", ")}`);
    assert.ok(terms.some((t) => t.includes("jordan")), `no jordan in ${terms.join(", ")}`);
    // Grammar and packaging noise never becomes a thing you sell.
    for (const junk of ["the", "with", "new", "size", "og"]) {
      assert.equal(terms.includes(junk), false, `"${junk}" is not an interest`);
    }
  });

  test("a card catalog derives the sets, and a year is not a set", () => {
    const terms = deriveInterests(cards).map((t) => t.slug);
    assert.ok(terms.some((t) => t.includes("topps")), `no topps in ${terms.join(", ")}`);
    // "1996", "2004", "114" — numbers in a card title are the year and the card
    // number, and neither is a thing anybody searches a live show for.
    assert.equal(terms.some((t) => /^\d+$/.test(t)), false, `a bare number got through: ${terms.join(", ")}`);
  });

  test("the phrase beats its parts when the part never stands alone", () => {
    const items: DerivationItem[] = [
      { title: "Air Jordan 1 Retro High" },
      { title: "Air Jordan 4 Bred" },
      { title: "Air Jordan 3 White Cement" },
      { title: "Air Jordan 1 Chicago" },
    ];
    const terms = deriveInterests(items).map((t) => t.slug);
    assert.ok(terms.includes("air jordan"), "the phrase is what a person would type");
    // "jordan" never occurs outside "air jordan" here, so it is that phrase's
    // shadow and listing both would be two chips for one idea.
    assert.equal(terms.includes("jordan"), false);
  });

  test("a word that also stands on its own keeps its own chip", () => {
    const items: DerivationItem[] = [
      { title: "Air Jordan 1 Retro" },
      { title: "Air Jordan 4 Bred" },
      { title: "Jordan brand snapback" },
      { title: "Jordan shorts" },
    ];
    const terms = deriveInterests(items).map((t) => t.slug);
    assert.ok(terms.includes("air jordan"));
    assert.ok(terms.includes("jordan"), "it means more than the phrase here");
  });

  test("weight is listings, not occurrences", () => {
    const rows = deriveInterests([
      { title: "Pokémon Pokémon Pokémon booster box" },
      { title: "Yu-Gi-Oh starter deck" },
      { title: "Pokémon graded slab" },
    ]);
    const pokemon = rows.find((r) => r.slug === "pokemon");
    assert.ok(pokemon, "derived");
    // Three mentions in one title is one listing that sells Pokémon.
    assert.equal(pokemon.weight, 2);
    // The display form keeps the spelling the catalog used; the slug does not.
    assert.equal(pokemon.term, "Pokémon");
    assert.equal(slugify("Pokémon"), "pokemon");
  });

  test("no catalog is no interests — nothing is ever invented", () => {
    assert.deepEqual(deriveInterests([]), []);
    assert.deepEqual(deriveInterests([{ title: "" }, { title: "   " }]), []);
  });
});

// ── the why, and the ranking that reads it ───────────────────────────────────

describe("why a card is in front of the operator", () => {
  const interests = [
    { slug: "pokemon", term: "Pokémon" },
    { slug: "air jordan", term: "Air Jordan" },
  ];

  test("a match is a whole word, never a substring", () => {
    assert.equal(mentions("ps5 bundle", "ps5"), true);
    assert.equal(mentions("ps500 bundle", "ps5"), false);
    assert.equal(mentions("cardigan season", "card"), false);
    // A plural is the same thing, and only a plural.
    assert.equal(mentions("sneakers tonight", "sneaker"), true);
  });

  test("a term found twice is one reason, reported at its strongest", () => {
    const why = whyFor(
      [
        { text: "Pokémon rips all night", where: "title" },
        { text: "Pokémon Cards", where: "category" },
      ],
      interests,
    );
    assert.equal(why.length, 1);
    assert.deepEqual(why[0], { term: "Pokémon", where: "title" });
  });

  test("a hit that cannot say why is dropped, not shown blank", () => {
    const hits: DiscoverHit[] = [
      hit({ id: "a", title: "Pokémon box break", why: [{ term: "Pokémon", where: "title" }] }),
      hit({ id: "b", title: "someone playing chess", why: [] }),
    ];
    const kept = rank(hits, { all: false, limit: 10 });
    assert.deepEqual(kept.map((h) => h.id), ["a"]);
  });

  test("…unless the caller asked for everything live on that surface", () => {
    const hits: DiscoverHit[] = [
      hit({ id: "a", why: [{ term: "Pokémon", where: "title" }] }),
      hit({ id: "b", why: [] }),
    ];
    assert.equal(rank(hits, { all: true, limit: 10 }).length, 2);
  });

  test("two interests in the title outrank one in a category", () => {
    const both = hit({
      id: "both", viewers: 2,
      why: [{ term: "Pokémon", where: "title" }, { term: "Air Jordan", where: "title" }],
    });
    const one = hit({ id: "one", viewers: 9000, why: [{ term: "Pokémon", where: "category" }] });
    assert.deepEqual(rank([one, both], { all: false, limit: 5 }).map((h) => h.id), ["both", "one"]);
  });

  test("an audience only breaks a tie — it never buys a place", () => {
    const small = hit({ id: "small", viewers: 4, why: [{ term: "Pokémon", where: "title" }] });
    const big = hit({ id: "big", viewers: 40_000, why: [{ term: "Pokémon", where: "title" }] });
    assert.deepEqual(rank([small, big], { all: false, limit: 5 }).map((h) => h.id), ["big", "small"]);
    // …and a surface that counts nobody does not sort below one that does
    // merely for being honest about it.
    const nulled = hit({ id: "nulled", viewers: null, why: [
      { term: "Pokémon", where: "title" }, { term: "Air Jordan", where: "title" },
    ] });
    assert.equal(rank([big, nulled], { all: false, limit: 5 })[0]!.id, "nulled");
  });
});

function hit(over: Partial<DiscoverHit> = {}): DiscoverHit {
  return {
    surface: "twitch", id: "x", title: "a show", host: null,
    url: "https://example.test", startedAt: null, liveNow: true, viewers: null,
    why: [], action: "attach", ...over,
  };
}

// ── Twitch, on an app token, against recorded shapes ─────────────────────────

describe("Twitch discovery needs an application key and nothing else", () => {
  const CATEGORIES = fixture<{ data: { id: string; name: string }[] }>("twitch/discovery-categories.json");
  const STREAMS = fixture<{ data: unknown[] }>("twitch/discovery-streams.json");

  /** Every Helix call, recorded. Most of what is asserted below is about the
   *  REQUESTS we sent, not the values we got back. */
  function fakeTwitch() {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string"
        ? Object.fromEntries(new URLSearchParams(init.body))
        : null;
      calls.push({ method, url, body });
      const json = (b: unknown) =>
        new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("https://id.twitch.tv/oauth2/token")) {
        return json({ access_token: "app_token_1", expires_in: 5_000_000 });
      }
      if (url.includes("/search/categories")) {
        const q = new URL(url).searchParams.get("query") ?? "";
        return json(/pok/i.test(q) ? CATEGORIES : { data: [] });
      }
      if (url.includes("/streams")) return json(STREAMS);
      return json({ data: [] });
    };
    return { calls, fetcher };
  }

  const env = { TWITCH_CLIENT_ID: "cid", TWITCH_CLIENT_SECRET: "shh" } as NodeJS.ProcessEnv;
  const req = (over: Partial<Parameters<DiscoverSource["fetch"]>[0]> = {}) => ({
    interests: [{ slug: "pokemon", term: "Pokémon" }],
    limit: 10, all: false, timeoutMs: 5_000, env, ...over,
  });

  test("a keyless Twitch names the SAME variable the attach refusal names", () => {
    const refused = twitchSource().unavailable({} as NodeJS.ProcessEnv);
    assert.equal(refused?.missing, "TWITCH_CLIENT_ID");
    assert.equal(refused?.missing, refusalNames(() => requireTwitchCreds({})));
    assert.match(refused!.reason, /TWITCH_CLIENT_ID/);
    // Half an application names the other half.
    assert.equal(twitchSource().unavailable({ TWITCH_CLIENT_ID: "cid" } as NodeJS.ProcessEnv)?.missing, "TWITCH_CLIENT_SECRET");
  });

  test("it does NOT ask for the bot's refresh token — that gate is attaching", () => {
    // The whole claim of this work: listing what is live acts as nobody, so an
    // operator must not be told to go and consent before they can browse.
    assert.equal(missingForDiscovery(env), null);
    assert.equal(twitchSource().unavailable(env), null);
  });

  test("it mints an APP token and never a user one", async () => {
    const { calls, fetcher } = fakeTwitch();
    await twitchSource({ fetcher }).fetch(req());
    const grants = calls.filter((c) => c.url.startsWith("https://id.twitch.tv/oauth2/token"));
    assert.equal(grants.length, 1, "one grant, cached for the rest of the read");
    assert.equal((grants[0]!.body as { grant_type: string }).grant_type, "client_credentials");
    assert.equal("refresh_token" in (grants[0]!.body as object), false);
  });

  test("interests become categories, and every category is ONE streams call", async () => {
    const { calls, fetcher } = fakeTwitch();
    await twitchSource({ fetcher }).fetch(
      req({ interests: [{ slug: "pokemon", term: "Pokémon" }, { slug: "pokemon tcg", term: "Pokémon TCG" }] }),
    );
    const searches = calls.filter((c) => c.url.includes("/search/categories"));
    const streams = calls.filter((c) => c.url.includes("/helix/streams"));
    assert.equal(searches.length, 2, "one category search per interest");
    assert.equal(streams.length, 1, "Helix takes up to a hundred game_id parameters at once");
    const ids = new URL(streams[0]!.url).searchParams.getAll("game_id");
    assert.deepEqual(ids.sort(), ["1728473193", "27471"]);
  });

  test("a stream whose title says nothing still says which interest reached it", async () => {
    const { fetcher } = fakeTwitch();
    const hits = await twitchSource({ fetcher }).fetch(req());
    const quiet = hits.find((h) => h.id === "quietchannel");
    assert.ok(quiet, "the row is there");
    // "just chatting for a bit" mentions nothing. It is on screen because its
    // CATEGORY is one the operator's interest resolved to, and it says so.
    assert.deepEqual(quiet.why, [{ term: "Pokémon", where: "category" }]);
  });

  test("the id is what the paste box takes, and a missing audience is null", async () => {
    const { fetcher } = fakeTwitch();
    const hits = await twitchSource({ fetcher }).fetch(req());
    const rae = hits.find((h) => h.id === "cardsbyrae")!;
    assert.equal(rae.url, "https://www.twitch.tv/cardsbyrae");
    assert.equal(rae.host, "CardsByRae");
    assert.equal(rae.viewers, 1428);
    assert.equal(rae.startedAt, "2026-09-19T01:04:12Z");
    assert.equal(rae.action, "attach");
    // Twitch omitted `viewer_count` on this row. Null, never zero.
    assert.equal(hits.find((h) => h.id === "quietchannel")!.viewers, null);
  });

  test("no interest resolves to a category: spend nothing", async () => {
    const { calls, fetcher } = fakeTwitch();
    const hits = await twitchSource({ fetcher }).fetch(
      req({ interests: [{ slug: "omega seamaster", term: "Omega Seamaster" }] }),
    );
    assert.deepEqual(hits, []);
    assert.equal(calls.some((c) => c.url.includes("/helix/streams")), false,
      "an unfiltered /streams is the front page of Twitch, and no card on it could say why");
  });

  test("discovery only ever READS", async () => {
    const { calls, fetcher } = fakeTwitch();
    await twitchSource({ fetcher }).fetch(req());
    const writes = calls.filter((c) => c.method !== "GET" && !c.url.includes("oauth2/token"));
    assert.deepEqual(writes, []);
  });
});

// ── Reddit, through the client that already paces itself ─────────────────────

describe("Reddit discovery is search, and it is read-only", () => {
  const SUBS = fixture<unknown>("reddit/subreddits-search.json");
  const THREADS = fixture<unknown>("reddit/search-threads.json");
  const LIMIT_OK = { "x-ratelimit-remaining": "540", "x-ratelimit-reset": "480", "x-ratelimit-used": "60" };
  const CREDS = {
    clientId: "cid", clientSecret: "secret", username: "sidestage_bot",
    password: "pw", userAgent: "macos:ai.whissle.sidestage:v1.0 (by /u/kicksbyrae)",
  };

  function fakeReddit(headers: Record<string, string> = LIMIT_OK) {
    const sent: { url: string; method: string }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      sent.push({ url, method: (init?.method ?? "GET").toUpperCase() });
      const json = (b: unknown) =>
        new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json", ...headers } });
      if (url.includes("/api/v1/access_token")) return json({ access_token: "tok", expires_in: 3600 });
      if (url.includes("/subreddits/search")) return json(SUBS);
      return json(THREADS);
    };
    return { sent, client: new RedditClient(CREDS, fetcher, async () => {}) };
  }

  const req = (over: Record<string, unknown> = {}) => ({
    interests: [{ slug: "mechanical keyboards", term: "mechanical keyboards" }],
    limit: 10, all: false, timeoutMs: 5_000, env: {} as NodeJS.ProcessEnv, ...over,
  });

  test("a keyless Reddit names the SAME variable the attach refusal names", () => {
    const refused = redditSource().unavailable({} as NodeJS.ProcessEnv);
    assert.equal(refused?.missing, "REDDIT_CLIENT_ID");
    assert.equal(refused?.missing, refusalNames(() => requireRedditCreds({})));
    // Four of the five is still not a credential — the app identity and the
    // account identity are different halves of one thing.
    const four = {
      REDDIT_CLIENT_ID: "a", REDDIT_CLIENT_SECRET: "b",
      REDDIT_USERNAME: "c", REDDIT_PASSWORD: "d",
    } as NodeJS.ProcessEnv;
    assert.equal(redditSource().unavailable(four)?.missing, "REDDIT_USER_AGENT");
  });

  test("a subreddit is a room to watch and its id is what the rooms API takes", async () => {
    const { client } = fakeReddit();
    const hits = await redditSource({ client }).fetch(req());
    const room = hits.find((h) => h.id === "r/mechmarket");
    assert.ok(room, `no r/mechmarket in ${hits.map((h) => h.id).join(", ")}`);
    // `r/mechmarket`, with the prefix — exactly what `redditAdapter.parseTarget`
    // resolves and exactly what `POST /api/surfaces/reddit/rooms` stores.
    assert.equal(room.action, "watch-room");
    assert.equal(room.url, "https://www.reddit.com/r/mechmarket/");
    assert.equal(room.liveNow, false);
    // Subscribers are not an audience. Nobody measured who is there now.
    assert.equal(room.viewers, null);
    assert.equal(room.startedAt, null);
    assert.equal(room.host, null);
  });

  test("a private or adult room is not a room to put a copilot in", async () => {
    const { client } = fakeReddit();
    const ids = (await redditSource({ client }).fetch(req())).map((h) => h.id);
    assert.equal(ids.includes("r/keebtrade_private"), false, "restricted: nobody can watch it");
    assert.equal(ids.includes("r/notsafekeebs"), false);
    assert.equal(ids.includes("t3_1n5cnsf"), false, "the over-18 thread too");
  });

  test("a thread is a conversation to open, timed from when it was posted", async () => {
    const { client } = fakeReddit();
    const hits = await redditSource({ client }).fetch(req());
    const thread = hits.find((h) => h.id === "t3_1n5b7kd")!;
    assert.equal(thread.action, "open");
    assert.equal(thread.host, "u/kbd_curious");
    assert.equal(thread.url, "https://www.reddit.com/r/MechanicalKeyboards/comments/1n5b7kd/which_mechanical_keyboards_are_actually_worth_it/");
    assert.equal(thread.startedAt, new Date(1789124400 * 1000).toISOString());
    assert.ok(thread.why.length, "it matched in the title");
  });

  test("nothing it does is a write, and nothing it does is a post", async () => {
    const { sent, client } = fakeReddit();
    await redditSource({ client }).fetch(req());
    const nonGet = sent.filter((s) => s.method !== "GET" && !s.url.includes("access_token"));
    assert.deepEqual(nonGet, [], "discovery is read-only on every surface");
    assert.equal(sent.some((s) => /\/api\/(comment|submit|compose)/.test(s.url)), false);
  });

  test("a watched room's rate budget is not discovery's to spend", async () => {
    // Reddit meters per ACCOUNT. When a room is open, the drafts the operator
    // is waiting on are worth more than a subreddit search.
    const { sent, client } = fakeReddit({ "x-ratelimit-remaining": "12", "x-ratelimit-reset": "300" });
    // One read to let the client learn the budget from the headers.
    await client.get("/subreddits/search", { q: "x" });
    const before = sent.length;
    await assert.rejects(
      () => redditSource({ client, activeWatch: () => true }).fetch(req()),
      (e: Error) => e instanceof RedditBudgetReserved,
    );
    assert.equal(sent.length, before, "and it spends nothing while it says so");
    // With nothing being watched, the same budget is discovery's to use.
    await redditSource({ client, activeWatch: () => false }).fetch(req());
    assert.ok(sent.length > before);
  });

  test("no interests is no search — Reddit has no 'everything live'", async () => {
    const { sent, client } = fakeReddit();
    assert.deepEqual(await redditSource({ client }).fetch(req({ interests: [], all: true })), []);
    assert.deepEqual(sent, []);
  });
});

// ── Whatnot: the investigation, and what it is safe to ship ──────────────────

describe("reading Whatnot's public grid", () => {
  const read = (name: string) =>
    withDocument(domFromHtml(html(name)), () => readBrowseInPage(WHATNOT_BROWSE_SELECTORS));

  test("a search page yields the room, the host, the title and the audience", () => {
    const snap = read("whatnot-browse.html");
    assert.equal(snap.blocked, null);
    assert.equal(snap.shell, true);
    assert.equal(snap.cards.length, 3);
    const first = snap.cards[0]!;
    // The uuid, which is what `whatnotAdapter.parseTarget` takes.
    assert.equal(first.id, "c04a283d-93f4-4e1f-b025-5e90e2456f25");
    assert.equal(first.host, "raecards");
    // The un-truncated title off the attribute, not the line-clamped text.
    assert.equal(first.title, "Vintage base set box break, $1 starts");
    assert.deepEqual(first.tags, ["Pokémon Cards", "$1 Starts, Vintage, Sudden Death"]);
    assert.equal(first.viewersRaw, "2.2k");
    assert.equal(first.liveNow, true);
  });

  test("a card with no live badge is not live and has no audience", () => {
    const scheduled = read("whatnot-browse.html").cards[2]!;
    assert.equal(scheduled.liveNow, false);
    assert.equal(scheduled.viewersRaw, null, "zero would be a measurement nobody made");
  });

  test("a Cloudflare challenge is a wall with a name, never an empty grid", () => {
    const snap = read("whatnot-browse-blocked.html");
    assert.deepEqual(snap.cards, []);
    assert.match(snap.blocked!, /Cloudflare/);
    assert.equal(snap.shell, false);
  });

  test("a 200 that rendered nothing is caught too — that is the dangerous one", () => {
    // Not a challenge and not an error. Without this check it is
    // indistinguishable from a genuinely quiet night on Whatnot, which is the
    // failure that would make an operator conclude the product is broken.
    const snap = read("whatnot-browse-empty.html");
    assert.deepEqual(snap.cards, []);
    assert.equal(snap.blocked, null);
    assert.equal(snap.shell, false);
  });

  const req = (over: Record<string, unknown> = {}) => ({
    interests: [{ slug: "pokemon", term: "Pokémon" }],
    limit: 10, all: false, timeoutMs: 5_000, env: {} as NodeJS.ProcessEnv, ...over,
  });

  test("the source needs no key at all", () => {
    assert.equal(whatnotSource().unavailable({} as NodeJS.ProcessEnv), null);
    assert.equal(whatnotDiscoveryEnabled({} as NodeJS.ProcessEnv), true);
  });

  test("but it can be switched off from the environment, and says which switch", () => {
    // It drives a browser per read on a two-gigabyte box. After an outage
    // caused by browsers, whoever is awake should be able to stop it.
    const off = whatnotSource().unavailable({ WHATNOT_DISCOVERY: "0" } as NodeJS.ProcessEnv);
    assert.equal(off?.missing, "WHATNOT_DISCOVERY");
  });

  test("one query per interest, capped, and the browser is closed either way", async () => {
    const asked: string[] = [];
    const src = whatnotSource({
      maxQueries: 2,
      read: async (url) => {
        asked.push(url);
        return withDocument(domFromHtml(html("whatnot-browse.html")), () =>
          readBrowseInPage(WHATNOT_BROWSE_SELECTORS));
      },
    });
    const hits = await src.fetch(req({
      interests: [
        { slug: "pokemon", term: "Pokémon" },
        { slug: "air jordan", term: "Air Jordan" },
        { slug: "omega seamaster", term: "Omega Seamaster" },
      ],
    }));
    assert.equal(asked.length, 2, "a third page load is a third Chrome navigation");
    assert.match(asked[0]!, /search\?query=Pok%C3%A9mon/);
    // Two reads of the same fixture, deduplicated by room id.
    assert.equal(new Set(hits.map((h) => h.id)).size, hits.length);
    const pokemonRoom = hits.find((h) => h.id === "c04a283d-93f4-4e1f-b025-5e90e2456f25")!;
    assert.deepEqual(pokemonRoom.why, [{ term: "Pokémon", where: "category" }]);
    assert.equal(pokemonRoom.viewers, 2200, "2.2k is two thousand two hundred");
    assert.equal(pokemonRoom.startedAt, null, "Whatnot does not publish when a room opened");
  });

  test("a wall is raised so the service can report it, not swallowed", async () => {
    const src = whatnotSource({
      read: async () => withDocument(domFromHtml(html("whatnot-browse-blocked.html")), () =>
        readBrowseInPage(WHATNOT_BROWSE_SELECTORS)),
    });
    await assert.rejects(() => src.fetch(req()), /Cloudflare/);
  });

  test("and so is a page with no grid on it", async () => {
    const src = whatnotSource({
      read: async () => withDocument(domFromHtml(html("whatnot-browse-empty.html")), () =>
        readBrowseInPage(WHATNOT_BROWSE_SELECTORS)),
    });
    await assert.rejects(() => src.fetch(req()), /not getting the real page/);
  });
});

// ── TikTok Live: a different fact from the switch ────────────────────────────

describe("TikTok Live has no index to read", () => {
  test("it is a source that says so, not an absent tab", async () => {
    const refused = tiktokLiveSource.unavailable({ TIKTOK_LIVE_ENABLED: "1" } as NodeJS.ProcessEnv);
    assert.ok(refused, "even with the switch ON there is nothing to discover");
    assert.match(refused.reason, /no public index/i);
    // NOT TIKTOK_LIVE_ENABLED. Setting it would not produce one hit here, and
    // naming it would send an operator to flip a switch that changes nothing
    // about this tab.
    assert.equal(refused.missing, null);
    assert.deepEqual(
      await tiktokLiveSource.fetch({
        interests: [{ slug: "pokemon", term: "Pokémon" }],
        limit: 10, all: true, timeoutMs: 1_000, env: {} as NodeJS.ProcessEnv,
      }),
      [],
    );
  });
});

// ── the service: parallel, timed out, cached, tenanted ───────────────────────

describe("asking every surface at once", () => {
  /** A source that never answers. */
  const hangs = (surface: SurfaceId): DiscoverSource => ({
    surface, method: "a source that never answers",
    unavailable: () => null,
    fetch: () => new Promise(() => {}),
  });
  const answers = (surface: SurfaceId, hits: DiscoverHit[]): DiscoverSource => ({
    surface, method: "a source that answers",
    unavailable: () => null,
    fetch: async () => hits,
  });

  test("a slow surface does not hold the four that answered", async () => {
    const svc = new DiscoverService({
      timeoutMs: 40,
      sources: [
        hangs("whatnot"),
        answers("twitch", [hit({ surface: "twitch", id: "a", why: [{ term: "Pokémon", where: "title" }] })]),
      ],
    });
    const t0 = Date.now();
    const out = await svc.run({ accountId: "acct", interests: [{ slug: "pokemon", term: "Pokémon" }] });
    assert.ok(Date.now() - t0 < 2_000, "it did not wait for the one that hung");
    const slow = out.find((s) => s.surface === "whatnot")!;
    // A timeout is an `unavailable` REASON, not an error, and the source is
    // still in the list with an empty hit array.
    assert.deepEqual(slow.hits, []);
    assert.match(slow.unavailable!.reason, /did not answer within/);
    assert.equal(slow.unavailable!.missing, null);
    assert.equal(out.find((s) => s.surface === "twitch")!.hits.length, 1);
  });

  test("a surface that cannot answer is never omitted", async () => {
    const svc = new DiscoverService();
    const out = await svc.run({ accountId: "acct", interests: [], env: {} as NodeJS.ProcessEnv });
    // Five sources, always, whatever the environment holds. `youtubelive` is
    // not among them: it has a capability row and no adapter in this build.
    assert.deepEqual(out.map((s) => s.surface), ["ebaylive", "whatnot", "twitch", "reddit", "tiktoklive"]);
    for (const s of out) assert.ok(Array.isArray(s.hits), `${s.surface} has a hits array`);
    assert.equal(out.find((s) => s.surface === "twitch")!.unavailable!.missing, "TWITCH_CLIENT_ID");
    assert.equal(out.find((s) => s.surface === "reddit")!.unavailable!.missing, "REDDIT_CLIENT_ID");
    for (const s of out) assert.ok(s.method.length > 10, `${s.surface} says how it reads`);
  });

  test("the answer is cached per account, and two accounts never share one", async () => {
    let reads = 0;
    const counting: DiscoverSource = {
      surface: "twitch", method: "counts",
      unavailable: () => null,
      fetch: async () => {
        reads++;
        return [hit({ id: `r${reads}`, why: [{ term: "Pokémon", where: "title" }] })];
      },
    };
    const svc = new DiscoverService({ sources: [counting] });
    const q = { interests: [{ slug: "pokemon", term: "Pokémon" }] };
    await svc.run({ accountId: "one", ...q });
    await svc.run({ accountId: "one", ...q });
    assert.equal(reads, 1, "the second poll is the cache — Twitch and Reddit both meter");
    await svc.run({ accountId: "two", ...q });
    assert.equal(reads, 2, "another operator's answer is never handed over");
    // A different question is a different answer.
    await svc.run({ accountId: "one", interests: [{ slug: "air jordan", term: "Air Jordan" }] });
    assert.equal(reads, 3);
  });

  test("`discoverable` is the surfaces that can answer, computed, not a constant", () => {
    const svc = new DiscoverService();
    // Nothing configured: only the surface that needs nothing.
    assert.deepEqual(svc.discoverable({} as NodeJS.ProcessEnv), ["whatnot"]);
    // A key arrives, and Twitch is discoverable with no deploy and no consent.
    assert.deepEqual(
      svc.discoverable({ TWITCH_CLIENT_ID: "a", TWITCH_CLIENT_SECRET: "b" } as NodeJS.ProcessEnv),
      ["whatnot", "twitch"],
    );
    // TikTok Live is never in it, whatever is set.
    assert.equal(
      svc.discoverable({ TIKTOK_LIVE_ENABLED: "1" } as NodeJS.ProcessEnv).includes("tiktoklive"),
      false,
    );
  });

  test("`all` is only ever a question about one named surface", async () => {
    const svc = new DiscoverService({
      sources: [answers("twitch", [hit({ id: "nameless", why: [] })])],
    });
    const everywhere = await svc.run({ accountId: "a", interests: [], all: true });
    assert.deepEqual(everywhere[0]!.hits, [], "asked of every surface it is a page of strangers");
    const here = await svc.run({ accountId: "a", interests: [], surface: "twitch", all: true });
    assert.equal(here[0]!.hits.length, 1);
  });

  test("the eBay source says why it is empty rather than showing a quiet night", () => {
    // No signed-in session in the suite, which is a different fact from "nobody
    // is on air" and has a different fix.
    const refused = ebayLiveSource.unavailable({} as NodeJS.ProcessEnv);
    assert.ok(refused, "it cannot answer without a session");
    assert.match(refused.reason, /sign|grid|read/i);
  });
});

/** What `SurfaceUnavailable` puts in `missing`, so the two strings can be
 *  compared rather than assumed equal. */
function refusalNames(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof SurfaceUnavailable ? e.missing : undefined;
  }
  return undefined;
}

// ── the interests an operator owns ───────────────────────────────────────────

const { buildApp } = await import("../src/api/server.js");
type AppContext = Awaited<ReturnType<typeof buildApp>>["ctx"];

let app: FastifyInstance;
let ctx: AppContext;
let mine: { token: string; id: string };
let theirs: { token: string; id: string };

const register = async (tag: string) => {
  const body = (
    await app.inject({
      method: "POST", url: "/api/auth/register",
      headers: { "content-type": "application/json" },
      payload: {
        email: `discover-${tag}-${Date.now()}${Math.random().toString(16).slice(2)}@test.local`,
        password: "password-123", displayName: `discover-${tag}`,
      },
    })
  ).json() as { token: string; account: { id: string } };
  return { token: body.token, id: body.account.id };
};

before(async () => {
  ({ app, ctx } = await buildApp());
  mine = await register("mine");
  theirs = await register("theirs");
});

after(async () => {
  await pgPool()
    .query("DELETE FROM discover_interests WHERE account_id = ANY($1::text[])", [[mine.id, theirs.id]])
    .catch(() => {});
  await app.close();
  await ctx.stop();
});

const auth = (who: { token: string }) => ({ authorization: `Bearer ${who.token}` });

describe("interests are derived, then owned", () => {
  test("a term the operator deletes STAYS deleted across future imports", async () => {
    const store = new InterestStore(pgPool());
    await store.absorb(mine.id, [
      { slug: "pokemon", term: "Pokémon", weight: 9 },
      { slug: "air jordan", term: "Air Jordan", weight: 4 },
    ]);
    assert.deepEqual((await store.list(mine.id)).map((i) => i.slug).sort(), ["air jordan", "pokemon"]);

    await store.remove(mine.id, "Pokémon");
    assert.deepEqual((await store.list(mine.id)).map((i) => i.slug), ["air jordan"]);

    // The next catalog import derives it again, with a bigger weight. The
    // operator already answered this question and the import does not get to
    // argue with them.
    await store.absorb(mine.id, [
      { slug: "pokemon", term: "Pokémon", weight: 40 },
      { slug: "air jordan", term: "Air Jordan", weight: 6 },
    ]);
    const after = await store.list(mine.id);
    assert.deepEqual(after.map((i) => i.slug), ["air jordan"], "it did not come back");
    assert.equal(after[0]!.weight, 6, "the one they kept is updated, though");
    assert.ok((await store.tombstones(mine.id)).has("pokemon"));
  });

  test("asking for it back BY NAME is a decision, and that does work", async () => {
    const store = new InterestStore(pgPool());
    const added = await store.add(mine.id, "Pokémon", true);
    assert.equal(added?.origin, "own");
    assert.equal(added?.pinned, true);
    const live = await store.list(mine.id);
    assert.equal(live[0]!.slug, "pokemon", "pinned sorts first");
    // And a later import does not take their own term away from them.
    await store.absorb(mine.id, [{ slug: "pokemon", term: "pokemon", weight: 40 }]);
    const again = (await store.list(mine.id)).find((i) => i.slug === "pokemon")!;
    assert.equal(again.origin, "own");
    assert.equal(again.term, "Pokémon", "their spelling, not the catalog's");
    assert.equal(again.weight, 40, "the count is the catalog's, though");
  });

  test("one operator never sees another's interests", async () => {
    const store = new InterestStore(pgPool());
    await store.absorb(theirs.id, [{ slug: "omega seamaster", term: "Omega Seamaster", weight: 3 }]);
    const ours = (await store.list(mine.id)).map((i) => i.slug);
    assert.equal(ours.includes("omega seamaster"), false);
    // And the tombstone is theirs alone: our removal must not delete for them.
    assert.equal((await store.tombstones(theirs.id)).has("pokemon"), false);

    const seen = (await app.inject({ method: "GET", url: "/api/discover/interests", headers: auth(theirs) })).json();
    assert.equal(
      (seen.interests as { slug: string }[]).some((i) => i.slug === "air jordan"), false,
      "not through the endpoint either",
    );
  });

  test("PUT replaces the set, and the removals become tombstones", async () => {
    const put = await app.inject({
      method: "PUT", url: "/api/discover/interests", headers: { ...auth(mine), "content-type": "application/json" },
      payload: { interests: [{ term: "Graded slabs", pinned: true }, { term: "Air Jordan" }] },
    });
    assert.equal(put.statusCode, 200);
    const slugs = (put.json().interests as { slug: string; pinned: boolean }[]);
    assert.deepEqual(slugs.map((i) => i.slug), ["graded slabs", "air jordan"]);
    // Everything they dropped is gone and stays gone.
    const store = new InterestStore(pgPool());
    const dead = await store.tombstones(mine.id);
    assert.ok(dead.has("pokemon"), "dropped in the PUT, tombstoned");
    await store.absorb(mine.id, [{ slug: "pokemon", term: "Pokémon", weight: 99 }]);
    assert.equal((await store.list(mine.id)).some((i) => i.slug === "pokemon"), false);
  });

  test("a body that is not a list of interests is refused, not half-applied", async () => {
    const bad = await app.inject({
      method: "PUT", url: "/api/discover/interests", headers: { ...auth(mine), "content-type": "application/json" },
      payload: { interests: "pokemon" },
    });
    assert.equal(bad.statusCode, 400);
    const still = (await app.inject({ method: "GET", url: "/api/discover/interests", headers: auth(mine) })).json();
    assert.deepEqual((still.interests as { slug: string }[]).map((i) => i.slug), ["graded slabs", "air jordan"]);
  });
});

// ── the endpoint ─────────────────────────────────────────────────────────────

describe("GET /api/discover", () => {
  test("every surface answers, including the ones that cannot", async () => {
    const r = await app.inject({ method: "GET", url: "/api/discover", headers: auth(mine) });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.ok(Array.isArray(body.interests));
    assert.deepEqual(
      (body.sources as { surface: string }[]).map((s) => s.surface),
      ["ebaylive", "whatnot", "twitch", "reddit", "tiktoklive"],
      "a missing tab reads as a broken product",
    );
    for (const s of body.sources as { surface: string; hits: unknown[]; method: string; unavailable: unknown }[]) {
      assert.ok(Array.isArray(s.hits), `${s.surface} always has a hits array`);
      assert.ok(typeof s.method === "string" && s.method.length, `${s.surface} says how it reads`);
    }
    const twitch = (body.sources as { surface: string; unavailable: { missing: string } | null }[])
      .find((s) => s.surface === "twitch")!;
    assert.equal(twitch.unavailable!.missing, "TWITCH_CLIENT_ID");
  });

  test("a named surface answers alone", async () => {
    const r = await app.inject({ method: "GET", url: "/api/discover?surface=reddit", headers: auth(mine) });
    assert.deepEqual((r.json().sources as { surface: string }[]).map((s) => s.surface), ["reddit"]);
  });

  test("the query is echoed as a term that is not saved", async () => {
    const r = await app.inject({ method: "GET", url: "/api/discover?q=Omega%20Seamaster", headers: auth(mine) });
    assert.equal(r.json().query, "Omega Seamaster");
    const kept = (await app.inject({ method: "GET", url: "/api/discover/interests", headers: auth(mine) })).json();
    assert.equal(
      (kept.interests as { slug: string }[]).some((i) => i.slug === "omega seamaster"), false,
      "typing in the search box is not editing your interests",
    );
  });

  test("a signed-out caller gets nothing at all", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/api/discover" })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/discover/interests" })).statusCode, 401);
  });
});
