// The Twitch surface, with no key and no network.
//
// Every Helix call goes through an injected fetcher and every chat frame comes
// out of `fixtures/twitch/`, recorded from the real websocket. That is not a
// convenience: a suite that could reach Twitch would fail on somebody else's
// outage, take a rate limit budget from a live channel, and give a developer
// with a working `.env` a different answer from CI. The one thing that is
// genuinely tested against the platform — that these are the right endpoints —
// is tested by using it, not by a test.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { twitchAdapter } from "../src/surfaces/twitch/adapter.js";
import { resolve, get } from "../src/surfaces/registry.js";
import { SurfaceUnavailable, capabilitiesOf } from "../src/surfaces/types.js";
import { TwitchApi, TwitchApiError, missingTwitchKey } from "../src/surfaces/twitch/api.js";
import { TwitchChat, readFrame, parseIrcLine, CHAT_TRANSPORT, type ChatSocket, type SocketFactory } from "../src/surfaces/twitch/chat.js";
import { TwitchActions } from "../src/surfaces/twitch/actions.js";
import { twitchFacts, parseChannelCorpus, rulesOf, type ChannelCorpus } from "../src/surfaces/twitch/corpus.js";
import { preflight, type PreflightContext } from "../src/actions/preflight.js";
import { ActionExecutor } from "../src/actions/executor.js";
import { runChain } from "../src/guardrails/chain.js";
import { sponsorGuard, communityRuleGuard } from "../src/guardrails/guards.js";
import type { GuardInput } from "../src/guardrails/types.js";
import type { Fact } from "../src/retrieval/facts.js";
import type { SurfaceEvents } from "../src/surfaces/types.js";
import { rig, cleanup } from "./helpers.js";

const FRAMES = JSON.parse(
  readFileSync(new URL("../fixtures/twitch/eventsub-frames.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const CHANNEL_FILE = JSON.parse(
  readFileSync(new URL("../fixtures/twitch/kicksbyrae-channel.json", import.meta.url), "utf8"),
) as unknown;
const IRC_LINES = readFileSync(new URL("../fixtures/twitch/irc-lines.txt", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean);

const frame = (name: string): string => JSON.stringify(FRAMES[name]);

// ── a Twitch that never existed ──────────────────────────────────────────────
//
// One fetcher, routed by method and path, recording every call. The recording
// is what most of the action assertions are actually about: "did we archive the
// poll" is a question about the request we sent, not about a value we got back.

interface Call { method: string; url: string; body: unknown }

function fakeTwitch(overrides: Record<string, () => Response> = {}) {
  const calls: Call[] = [];
  let tokenGrants = 0;
  let refreshToken = "refresh_1";

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = init.body.startsWith("{") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    }
    calls.push({ method, url, body });

    const key = `${method} ${url.split("?")[0]}`;
    if (overrides[key]) return overrides[key]!();

    if (url.startsWith("https://id.twitch.tv/oauth2/token")) {
      tokenGrants++;
      const grant = (body as { grant_type?: string })?.grant_type;
      refreshToken = grant === "refresh_token" ? `refresh_${tokenGrants + 1}` : refreshToken;
      return json({
        access_token: `access_${tokenGrants}`,
        refresh_token: refreshToken,
        expires_in: 14_400,
        scope: ["user:read:chat"],
      });
    }
    if (url.includes("/helix/users?login=")) {
      const login = new URL(url).searchParams.get("login");
      if (login !== "kicksbyrae" && login !== "raeretro") return json({ data: [] });
      return json({
        data: [{ id: login === "kicksbyrae" ? "100" : "200", login, display_name: login === "kicksbyrae" ? "KicksByRae" : "RaeRetro" }],
      });
    }
    if (url.endsWith("/helix/users")) {
      return json({ data: [{ id: "900", login: "sidestagebot", display_name: "SideStageBot" }] });
    }
    if (url.includes("/helix/channels")) return json({ data: [{ title: "Board build night", game_name: "Just Chatting" }] });
    if (url.includes("/helix/streams?")) {
      return json({ data: [{ id: "str_1", title: "Board build night", game_name: "Just Chatting", started_at: "2026-09-17T22:00:00Z" }] });
    }
    if (url.includes("/helix/polls") && method === "GET") return json({ data: [] });
    if (url.includes("/helix/polls") && method === "POST") {
      return json({ data: [{ id: "poll_1", title: (body as { title?: string }).title, status: "ACTIVE" }] });
    }
    if (url.includes("/helix/polls") && method === "PATCH") {
      return json({ data: [{ id: "poll_1", title: "which switch", status: (body as { status?: string }).status }] });
    }
    if (url.includes("/helix/clips")) return json({ data: [{ id: "ClipSlug1", edit_url: "https://clips.twitch.tv/ClipSlug1/edit" }] });
    if (url.includes("/helix/streams/markers")) return json({ data: [{ id: "mk_1", position_seconds: 3512 }] });
    if (url.includes("/helix/chat/messages")) return json({ data: [{ message_id: "msg_1", is_sent: true }] });
    if (url.includes("/helix/chat/announcements")) return new Response(null, { status: 204 });
    if (url.includes("/helix/chat/shoutouts")) return new Response(null, { status: 204 });
    if (url.includes("/helix/moderation/chat")) return new Response(null, { status: 204 });
    if (url.includes("/helix/eventsub/subscriptions")) return json({ data: [{ id: "sub_1" }] });
    return json({ error: "Not Found", message: `nothing fake answers ${key}`, status: 404 }, 404);
  };

  return {
    fetcher,
    calls,
    get tokenGrants() { return tokenGrants; },
    sent: (method: string, fragment: string) => calls.filter((c) => c.method === method && c.url.includes(fragment)),
  };
}

/** The fake always claims to store the rotated refresh token, because the
 *  alternative — the environment-variable path — warns on every construction
 *  and would bury the assertions in it. The rotation itself is asserted below. */
const api = (f: ReturnType<typeof fakeTwitch>, onRefreshToken: (t: string) => void = () => {}) =>
  new TwitchApi(
    { clientId: "cid", clientSecret: "secret", botRefreshToken: "refresh_1" },
    { fetcher: f.fetcher, onRefreshToken },
  );

// ── 1. what an operator pastes ───────────────────────────────────────────────

describe("parsing a twitch target", () => {
  const parse = (s: string) => twitchAdapter.parseTarget(s);

  test("a link, an @handle and a bare channel name all resolve to the same channel", () => {
    for (const input of [
      "https://www.twitch.tv/kicksbyrae",
      "twitch.tv/kicksbyrae",
      "http://m.twitch.tv/kicksbyrae?tt_content=home",
      "https://www.twitch.tv/KicksByRae/videos",
      "@kicksbyrae",
      "kicksbyrae",
      "  KicksByRae  ",
    ]) {
      assert.equal(parse(input)?.externalId, "kicksbyrae", input);
    }
    assert.equal(parse("kicksbyrae")?.handle, "@kicksbyrae");
    assert.equal(parse("kicksbyrae")?.meta?.url, "https://twitch.tv/kicksbyrae");
  });

  test("a twitch link that is not a channel is refused rather than guessed at", () => {
    // twitch.tv/videos/12345 would otherwise attach a session to a channel
    // called "videos", which exists and belongs to somebody else.
    for (const input of ["https://twitch.tv/videos/12345", "twitch.tv/directory/game/Chess", "https://twitch.tv/settings"]) {
      assert.equal(parse(input), null, input);
    }
  });

  test("anything that is not a login is refused", () => {
    for (const input of [
      "", "   ", "abc", "a".repeat(26), "kicks by rae", "kicks-by-rae",
      "https://reddit.com/r/mechmarket/comments/abc", "47tK1SX0VsiHEXN1/player.html",
    ]) {
      assert.equal(parse(input), null, JSON.stringify(input));
    }
  });

  test("the registry still gives the narrower adapters their links first", () => {
    // Twitch is the only adapter that accepts a bare word, so registration
    // order is load-bearing: "demo" is a valid Twitch login AND how an operator
    // asks for the scripted show.
    assert.equal(resolve("47tK1SX0VsiHEXN1")?.adapter.id, "ebaylive");
    assert.equal(resolve("https://www.ebay.com/ebaylive/events/47tK1SX0VsiHEXN1/player.html")?.adapter.id, "ebaylive");
    assert.equal(resolve("simulated")?.adapter.id, "simulated");
    assert.equal(resolve("demo")?.adapter.id, "simulated");
    assert.equal(resolve("kicksbyrae")?.adapter.id, "twitch");
    assert.equal(resolve("twitch.tv/kicksbyrae")?.adapter.id, "twitch");
  });

  test("the adapter declares exactly what the capability table says", () => {
    // The table is what guards and preflight read; the adapter is what the
    // console reads. Drift between them is a safety check answering one way in
    // one place and another way in another.
    assert.deepEqual(twitchAdapter.capabilities, capabilitiesOf("twitch"));
    assert.equal(get("twitch")?.label, "Twitch");
    const c = twitchAdapter.capabilities;
    assert.equal(c.tempo, "live");
    assert.equal(c.delivery, "api");
    assert.deepEqual(c.perception, { audio: true, video: true });
    assert.equal(c.communityRules, true);
    for (const kind of ["create_clip", "mark_highlight", "run_poll", "shoutout", "pin_message", "post_reply"]) {
      assert.ok(c.actions.includes(kind as never), kind);
    }
    for (const corpus of ["schedule", "sponsor", "product", "qa"]) {
      assert.ok(c.corpora.includes(corpus as never), corpus);
    }
    assert.equal(c.corpora.includes("listing"), false, "there is no catalog behind a channel");
  });
});

// ── 2. a missing key is a refusal, not an outage ─────────────────────────────

describe("no keys", () => {
  test("open() throws SurfaceUnavailable naming the variable", async () => {
    // config blanks the Twitch keys under NODE_ENV=test, which is also what a
    // fresh clone looks like.
    await assert.rejects(
      () => twitchAdapter.open({ externalId: "kicksbyrae" }, {}),
      (e: unknown) =>
        e instanceof SurfaceUnavailable &&
        e.surface === "twitch" &&
        e.missing === "TWITCH_CLIENT_ID" &&
        /TWITCH_CLIENT_ID is not set/.test((e as Error).message),
    );
  });

  test("the variable named is the first one an operator would set", () => {
    // The consent flow issues the refresh token, so telling somebody it is
    // missing before they have registered an application is the wrong
    // instruction in the right order.
    assert.equal(missingTwitchKey(undefined), "TWITCH_CLIENT_ID");
    assert.equal(missingTwitchKey({ clientId: "a" }), "TWITCH_CLIENT_SECRET");
    assert.equal(missingTwitchKey({ clientId: "a", clientSecret: "b" }), "TWITCH_BOT_REFRESH_TOKEN");
    assert.equal(missingTwitchKey({ clientId: "a", clientSecret: "b", botRefreshToken: "c" }), null);
  });

  test("capabilities still resolve without a key", () => {
    // The whole point of the typed refusal: the console can show what Twitch
    // would do before anyone has connected anything.
    assert.equal(twitchAdapter.capabilities.actions.length > 0, true);
    assert.equal(capabilitiesOf("twitch").delivery, "api");
  });
});

// ── 3. tokens ────────────────────────────────────────────────────────────────

describe("token refresh", () => {
  test("a user token is minted once and reused until it ages out", async () => {
    const f = fakeTwitch();
    const a = api(f);
    assert.equal(await a.userToken(), "access_1");
    assert.equal(await a.userToken(), "access_1");
    assert.equal(f.tokenGrants, 1, "a cached token must not cost a grant per call");
    const grant = f.calls[0]!.body as Record<string, string>;
    assert.equal(grant.grant_type, "refresh_token");
    assert.equal(grant.refresh_token, "refresh_1");
    assert.equal(grant.client_id, "cid");
  });

  test("an app token and a user token are different grants and do not share a cache", async () => {
    // A 401 from Helix that says nothing about which token it wanted is the
    // most expensive error on this platform; keeping the two apart here is how
    // it is avoided.
    const f = fakeTwitch();
    const a = api(f);
    await a.userToken();
    await a.appToken();
    assert.equal(f.tokenGrants, 2);
    assert.deepEqual(
      f.calls.map((c) => (c.body as Record<string, string>).grant_type),
      ["refresh_token", "client_credentials"],
    );
  });

  test("a rotated refresh token is handed to whoever is storing it", async () => {
    const f = fakeTwitch();
    const stored: string[] = [];
    const a = api(f, (t) => void stored.push(t));
    await a.userToken();
    assert.deepEqual(stored, ["refresh_2"], "twitch rotates this, and dropping it means a connection that dies silently");
  });

  test("a refused refresh is a typed error, not a null token", async () => {
    const f = fakeTwitch({
      "POST https://id.twitch.tv/oauth2/token": () =>
        new Response(JSON.stringify({ status: 400, message: "Invalid refresh token" }), { status: 400 }),
    });
    await assert.rejects(
      () => api(f).userToken(),
      (e: unknown) => e instanceof TwitchApiError && /Invalid refresh token/.test((e as Error).message),
    );
  });
});

// ── 4. chat ──────────────────────────────────────────────────────────────────

describe("reading an EventSub frame", () => {
  test("a recorded chat notification becomes a SurfaceEvents message", () => {
    const f = readFrame(frame("chatMessage"));
    assert.equal(f.type, "message");
    if (f.type !== "message") return;
    // The two ids are different things and both matter: the envelope id is what
    // Twitch says to dedupe on, the chat id is what the delete endpoint takes.
    assert.equal(f.messageId, "0cf9d3f6-1f0c-4b98-8a1b-3a6a8b4e6f11");
    assert.equal(f.chat.id, "9a1f0b2c-6d4e-4a77-b1c3-5d8e7f6a2b40");
    assert.equal(f.chat.author, "MelonHusk");
    assert.equal(f.chat.authorId, "552");
    assert.equal(f.chat.text, "when is the next build stream?");
    assert.equal(f.chat.channel, "kicksbyrae");
    assert.equal(f.chat.at, "2026-09-17T23:14:02.191Z");
    assert.equal(f.chat.parentId, undefined);
  });

  test("a reply carries the parent, which is the only thread twitch chat has", () => {
    const f = readFrame(frame("replyMessage"));
    assert.equal(f.type === "message" && f.chat.parentId, "9a1f0b2c-6d4e-4a77-b1c3-5d8e7f6a2b40");
  });

  test("the session frames are read for the one value each of them carries", () => {
    const w = readFrame(frame("welcome"));
    assert.equal(w.type === "welcome" && w.sessionId, "AgoQ7Hq0sess1onId0000w");
    assert.equal(w.type === "welcome" && w.keepaliveSeconds, 10, "twitch negotiates this per connection");
    assert.equal(readFrame(frame("keepalive")).type, "keepalive");
    const r = readFrame(frame("reconnect"));
    assert.equal(r.type === "reconnect" && r.reconnectUrl, "wss://eventsub.wss.twitch.tv/ws?challenge=reconnect-token");
    const rev = readFrame(frame("revocation"));
    assert.equal(rev.type === "revocation" && rev.reason, "authorization_revoked");
  });

  test("garbage is a frame we do not act on, never a throw", () => {
    // This runs on a socket somebody else owns. A parse error that escaped
    // would take the session down for a frame nothing needed.
    assert.equal(readFrame("not json at all").type, "unknown");
    assert.equal(readFrame("{}").type, "unknown");
    assert.equal(readFrame(JSON.stringify({ metadata: { message_type: "notification" } })).type, "unknown");
  });

  test("eventsub is the primary transport", () => {
    assert.equal(CHAT_TRANSPORT, "eventsub");
  });
});

describe("the chat connection", () => {
  /** A websocket the test drives. The factory hands back the socket the chat
   *  client wired up, and the welcome arrives on its own the way a server's
   *  does — after the handlers are registered, not before. */
  function socketRig() {
    let onMessage: (d: string) => void = () => {};
    let onClose: (r: string) => void = () => {};
    const sent: string[] = [];
    const urls: string[] = [];
    let closed = 0;

    const factory: SocketFactory = (url) => {
      urls.push(url);
      const sock: ChatSocket = {
        send: (d) => void sent.push(d),
        close: () => void closed++,
        onopen: () => {},
        onmessage: (cb) => { onMessage = cb; },
        onclose: (cb) => { onClose = cb; },
        onerror: () => {},
      };
      setTimeout(() => onMessage(frame("welcome")), 0);
      return sock;
    };

    return {
      factory, sent, urls,
      get closed() { return closed; },
      deliver: (raw: string) => onMessage(raw),
      drop: (why: string) => onClose(why),
    };
  }

  function collect() {
    const messages: Parameters<NonNullable<SurfaceEvents["onMessage"]>>[0][] = [];
    const statuses: { connected: boolean; detail: string }[] = [];
    const titles: string[] = [];
    const ended: string[] = [];
    const events: SurfaceEvents = {
      onMessage: (m) => void messages.push(m),
      onStatus: (s) => void statuses.push(s),
      onTitle: (t) => void titles.push(t),
      onEnded: (w) => void ended.push(w),
    };
    return { events, messages, statuses, titles, ended };
  }

  test("a welcome subscribes to the channel's chat, and a notification reaches onMessage", async () => {
    const f = fakeTwitch();
    const s = socketRig();
    const c = collect();
    const chat = new TwitchChat({ api: api(f), channel: "kicksbyrae", events: c.events, socket: s.factory });
    await chat.start();

    // The subscription has to land within ten seconds of the welcome or Twitch
    // closes the socket, so it is the first thing done with the session id.
    const sub = f.sent("POST", "/eventsub/subscriptions")[0];
    assert.ok(sub, "no chat subscription was made");
    assert.deepEqual(sub!.body, {
      type: "channel.chat.message",
      version: "1",
      condition: { broadcaster_user_id: "100", user_id: "900" },
      transport: { method: "websocket", session_id: "AgoQ7Hq0sess1onId0000w" },
    });
    assert.deepEqual(c.titles, ["Board build night"]);
    assert.equal(c.statuses.at(-1)?.connected, true);

    s.deliver(frame("chatMessage"));
    assert.equal(c.messages.length, 1);
    assert.deepEqual(
      { id: c.messages[0]!.id, author: c.messages[0]!.author, text: c.messages[0]!.text },
      { id: "9a1f0b2c-6d4e-4a77-b1c3-5d8e7f6a2b40", author: "MelonHusk", text: "when is the next build stream?" },
    );
    assert.equal((c.messages[0]!.meta as { channel?: string }).channel, "kicksbyrae");

    s.deliver(frame("replyMessage"));
    assert.equal(c.messages[1]!.threadId, "9a1f0b2c-6d4e-4a77-b1c3-5d8e7f6a2b40");
    await chat.stop();
  });

  test("a redelivered frame is answered once", async () => {
    // EventSub explicitly redelivers across a reconnect. An answered question
    // asked twice is the failure a chat notices before any other.
    const f = fakeTwitch();
    const s = socketRig();
    const c = collect();
    const chat = new TwitchChat({ api: api(f), channel: "kicksbyrae", events: c.events, socket: s.factory });
    await chat.start();
    s.deliver(frame("chatMessage"));
    s.deliver(frame("chatMessage"));
    s.deliver(frame("chatMessage"));
    assert.equal(c.messages.length, 1);
    await chat.stop();
  });

  test("a revoked subscription ends the session rather than going quiet", async () => {
    const f = fakeTwitch();
    const s = socketRig();
    const c = collect();
    const chat = new TwitchChat({ api: api(f), channel: "kicksbyrae", events: c.events, socket: s.factory });
    await chat.start();
    s.deliver(frame("revocation"));
    assert.match(c.ended[0] ?? "", /revoked/);
    await chat.stop();
  });

  test("a channel that does not exist is said so, not retried", async () => {
    const f = fakeTwitch();
    const s = socketRig();
    const c = collect();
    const chat = new TwitchChat({ api: api(f), channel: "raeretr", events: c.events, socket: s.factory });
    await assert.rejects(() => chat.start(), /no channel called "raeretr"/);
  });
});

describe("the IRC fallback", () => {
  // Documented, behind a constant, and tested — because the value of a fallback
  // is entirely in whether it works on the day somebody switches to it.
  test("a tagged PRIVMSG parses to the same message the EventSub frame does", () => {
    const parsed = IRC_LINES.map(parseIrcLine).filter((x): x is Exclude<ReturnType<typeof parseIrcLine>, null> => x !== null);
    const messages = parsed.filter((p): p is Extract<typeof p, { id: string }> => !("ping" in p));
    assert.equal(messages.length, 2);
    assert.deepEqual(
      { id: messages[0]!.id, author: messages[0]!.author, text: messages[0]!.text, channel: messages[0]!.channel },
      {
        id: "9a1f0b2c-6d4e-4a77-b1c3-5d8e7f6a2b40",
        author: "MelonHusk",
        text: "when is the next build stream?",
        channel: "kicksbyrae",
      },
    );
    // Same id the EventSub frame carried for the same message: the two
    // transports are interchangeable to everything downstream, dedupe included.
    const viaEventSub = readFrame(frame("chatMessage"));
    assert.equal(viaEventSub.type === "message" && viaEventSub.chat.id, messages[0]!.id);
    assert.equal(messages[1]!.parentId, messages[0]!.id);
  });

  test("a PING is answered and a NOTICE is not mistaken for chat", () => {
    assert.deepEqual(parseIrcLine("PING :tmi.twitch.tv"), { ping: ":tmi.twitch.tv" });
    assert.equal(parseIrcLine(":tmi.twitch.tv NOTICE #kicksbyrae :This channel is in unique-chat mode."), null);
    assert.equal(parseIrcLine(""), null);
  });
});

// ── 5. actions ───────────────────────────────────────────────────────────────

const CHANNEL = "kicksbyrae";

const ctx = (posting?: { room: string; enabled: boolean }): PreflightContext => ({
  surface: capabilitiesOf("twitch"),
  posting,
  committedThisShow: 0,
  actionBudget: 10,
  committedLastMinute: 0,
  ratePerMinute: 6,
});

describe("preflight on a twitch channel", () => {
  test("every creator kind passes preflight with no listing behind it", () => {
    // A clip, a marker, a poll and a shoutout target something that is not in
    // any catalog. Refusing them for having no catalog row would refuse them
    // for the wrong reason.
    for (const kind of ["create_clip", "mark_highlight", "run_poll", "shoutout", "pin_message"] as const) {
      const r = preflight(kind, null, {}, ctx());
      assert.equal(r.ok, true, kind);
      assert.deepEqual(r.before, {}, "a channel action has no listing state to roll back to");
    }
  });

  test("a listing write is refused because this surface cannot do it", () => {
    const r = preflight("markdown_price", null, { newPriceCents: 100 }, ctx());
    assert.equal(r.ok, false);
    assert.equal(r.checks[0]!.detail, "this surface cannot markdown_price");
  });

  test("a reply is refused until a human turns posting on for the channel", () => {
    assert.equal(preflight("post_reply", null, {}, ctx()).ok, false);
    assert.equal(preflight("post_reply", null, {}, ctx({ room: "#kicksbyrae", enabled: false })).ok, false);
    assert.equal(preflight("post_reply", null, {}, ctx({ room: "#kicksbyrae", enabled: true })).ok, true);
  });
});

/** The real executor, pointed at Twitch. Nothing here is a Twitch-shaped
 *  executor: it is `ActionExecutor`, with `TwitchActions` where the marketplace
 *  usually is. */
async function twitchRig(f: ReturnType<typeof fakeTwitch>) {
  const r = await rig();
  await r.d.query("UPDATE shows SET source = 'twitch', surface = 'twitch' WHERE id = $1", [r.showId]);
  const actions = new TwitchActions(api(f), CHANNEL);
  const exec = new ActionExecutor(r.d, r.repo, actions, r.audit, { undoWindowS: 90 });
  return { ...r, actions, exec };
}

describe("committing a twitch action through the existing executor", () => {
  test("a clip is proposed, committed and recorded in the audit chain", async () => {
    const f = fakeTwitch();
    const { exec, audit } = await twitchRig(f);

    const a = await exec.propose("create_clip", CHANNEL, {}, "Clip the last 30 seconds", "chat asked for a clip 6 times");
    assert.equal(a.status, "proposed");
    assert.equal(a.preflight.ok, true);

    const committed = await exec.approve(a.id);
    assert.equal(committed.status, "committed", committed.error ?? "");
    assert.ok(committed.undoableUntil, "the undo window is offered on every committed action");
    assert.equal(f.sent("POST", "/helix/clips").length, 1);
    // The channel had to be read as live before the clip was cut — Helix
    // answers an offline clip request with a 404 that does not say why.
    assert.equal(f.sent("GET", "/helix/streams").length, 1);

    const entries = await audit.list(20);
    assert.ok(entries.some((e) => e.kind === "action_committed"), "the same audit chain, unchanged");
  });

  test("a poll commits and its undo archives it", async () => {
    const f = fakeTwitch();
    const { exec } = await twitchRig(f);
    const a = await exec.propose(
      "run_poll", CHANNEL,
      { title: "which switch next?", choices: ["U4T", "Boba", "Alpaca"], durationSeconds: 60 },
      "Run a 60s poll on the next switch", "three viewers asked",
    );
    const committed = await exec.approve(a.id);
    assert.equal(committed.status, "committed", committed.error ?? "");
    assert.equal((f.sent("POST", "/helix/polls")[0]!.body as { title: string }).title, "which switch next?");

    const rolled = await exec.rollback(a.id);
    assert.equal(rolled.status, "rolled_back", rolled.error ?? "");
    const patch = f.sent("PATCH", "/helix/polls")[0]!.body as { id: string; status: string };
    // ARCHIVED, not TERMINATED: an undo should take the poll off the screen,
    // not end it and leave the result standing.
    assert.deepEqual(patch, { broadcaster_id: "100", id: "poll_1", status: "ARCHIVED" });
  });

  test("a second poll is refused before anything is recorded as committing", async () => {
    const f = fakeTwitch({
      "GET https://api.twitch.tv/helix/polls": () =>
        new Response(JSON.stringify({ data: [{ id: "poll_0", title: "earlier poll", status: "ACTIVE" }] }), { status: 200 }),
    });
    const { exec } = await twitchRig(f);
    const a = await exec.propose("run_poll", CHANNEL, { title: "q", choices: ["a", "b"], durationSeconds: 60 }, "poll", "why");
    const out = await exec.approve(a.id);
    assert.equal(out.status, "failed");
    assert.match(out.error!, /a poll is already running/);
    assert.equal(f.sent("POST", "/helix/polls").length, 0, "nothing was written");
  });

  test("a poll that twitch would reject never leaves reserve", async () => {
    const f = fakeTwitch();
    const { exec } = await twitchRig(f);
    for (const params of [
      { title: "q", choices: ["only one"], durationSeconds: 60 },
      { title: "", choices: ["a", "b"], durationSeconds: 60 },
      { title: "q", choices: ["a", "b"], durationSeconds: 5 },
    ]) {
      const a = await exec.propose("run_poll", CHANNEL, params, "poll", "why");
      const out = await exec.approve(a.id);
      assert.equal(out.status, "failed", JSON.stringify(params));
    }
    assert.equal(f.sent("POST", "/helix/polls").length, 0);
  });

  test("a shoutout commits, and its undo says plainly that it cannot be taken back", async () => {
    const f = fakeTwitch();
    const { exec } = await twitchRig(f);
    const a = await exec.propose("shoutout", CHANNEL, { channel: "@raeretro" }, "Shout out @raeretro", "raided us");
    assert.equal((await exec.approve(a.id)).status, "committed");
    assert.equal(f.sent("POST", "/helix/chat/shoutouts").length, 1);

    const rolled = await exec.rollback(a.id);
    assert.equal(rolled.status, "failed");
    assert.match(rolled.error!, /shown to everyone watching #kicksbyrae and cannot be taken back/);
  });

  test("a clip's undo names the clip instead of reporting a rollback it did not do", async () => {
    // Helix lists two clip endpoints, Create and Get. There is no delete, so
    // the honest answer is a refusal that says where the clip is.
    const f = fakeTwitch();
    const { exec } = await twitchRig(f);
    const a = await exec.propose("create_clip", CHANNEL, {}, "Clip that", "chat asked");
    await exec.approve(a.id);
    const rolled = await exec.rollback(a.id);
    assert.equal(rolled.status, "failed");
    assert.match(rolled.error!, /no way to delete a clip/);
    assert.match(rolled.error!, /https:\/\/clips\.twitch\.tv\/ClipSlug1/);
  });

  test("a marker is cut into the VOD and cannot be un-cut", async () => {
    const f = fakeTwitch();
    const { exec } = await twitchRig(f);
    const a = await exec.propose("mark_highlight", CHANNEL, { note: "the Q1 sound test" }, "Mark this", "worth a highlight");
    assert.equal((await exec.approve(a.id)).status, "committed");
    assert.equal((f.sent("POST", "/helix/streams/markers")[0]!.body as { description: string }).description, "the Q1 sound test");
    assert.match((await exec.rollback(a.id)).error!, /no way to delete a stream marker/);
  });

  test("an announcement stands in for a pin, and says so when asked to undo", async () => {
    const f = fakeTwitch();
    const { exec } = await twitchRig(f);
    const a = await exec.propose("pin_message", CHANNEL, { message: "Next build stream: Thursday 7pm PT" }, "Pin the schedule", "asked 12 times");
    assert.equal((await exec.approve(a.id)).status, "committed");
    assert.equal(f.sent("POST", "/helix/chat/announcements").length, 1);
    assert.match((await exec.rollback(a.id)).error!, /cannot be unsaid/);
  });

  test("the same intent twice is one action, not two clips", async () => {
    const f = fakeTwitch();
    const { exec } = await twitchRig(f);
    const a = await exec.propose("create_clip", CHANNEL, { note: "same" }, "Clip that", "chat asked");
    const b = await exec.propose("create_clip", CHANNEL, { note: "same" }, "Clip that", "chat asked");
    assert.equal(b.id, a.id, "the idempotency key is the executor's, unchanged");
    await exec.approve(a.id);
    await exec.approve(b.id);
    assert.equal(f.sent("POST", "/helix/clips").length, 1);
  });

  test("a reply that AutoMod holds is a failure, not a commit", async () => {
    // Twitch answers 200 with `is_sent: false`. Recording that as committed
    // would put a reply in the audit log that no viewer ever saw.
    const f = fakeTwitch({
      "POST https://api.twitch.tv/helix/chat/messages": () =>
        new Response(
          JSON.stringify({ data: [{ message_id: "", is_sent: false, drop_reason: { code: "automod_held", message: "held by AutoMod" } }] }),
          { status: 200 },
        ),
    });
    const actions = new TwitchActions(api(f), CHANNEL);
    const res = await actions.reserve({
      kind: "post_reply", listingId: CHANNEL, expectedVersion: 0,
      params: { message: "Thursday 7pm PT" }, idempotencyKey: "post_reply:kicksbyrae:v0:held",
    });
    await assert.rejects(() => actions.apply(res), /did not post it — held by AutoMod/);
  });

  test("a posted reply is undone by deleting the message twitch named", async () => {
    // The only creator action with a clean undo besides a poll, and the reason
    // chat.ts prefers the transport that carries the same message id.
    const f = fakeTwitch();
    const actions = new TwitchActions(api(f), CHANNEL);
    const intent = {
      kind: "post_reply" as const, listingId: CHANNEL, expectedVersion: 0,
      params: { message: "Thursday 7pm PT", replyToMessageId: "9a1f0b2c-6d4e-4a77-b1c3-5d8e7f6a2b40" },
      idempotencyKey: "post_reply:kicksbyrae:v0:msg",
    };
    const res = await actions.reserve(intent);
    await actions.apply(res);
    assert.equal(
      (f.sent("POST", "/helix/chat/messages")[0]!.body as { reply_parent_message_id: string }).reply_parent_message_id,
      "9a1f0b2c-6d4e-4a77-b1c3-5d8e7f6a2b40",
    );

    // The executor suffixes the key on rollback; the apply recorded under the
    // base. If that join ever breaks, this is what catches it.
    await actions.compensate({ ...res, intent: { ...intent, idempotencyKey: `${intent.idempotencyKey}:rollback` } });
    const del = f.sent("DELETE", "/helix/moderation/chat")[0]!;
    assert.match(del.url, /message_id=msg_1/);
    assert.match(del.url, /moderator_id=900/);
  });

  test("an undo with nothing recorded says why instead of failing on a null", async () => {
    const f = fakeTwitch();
    const actions = new TwitchActions(api(f), CHANNEL);
    await assert.rejects(
      () => actions.compensate({
        token: "t", listingId: CHANNEL, expectedVersion: 0,
        intent: { kind: "run_poll", listingId: CHANNEL, expectedVersion: 0, params: {}, idempotencyKey: "gone:rollback" },
      }),
      /the process restarted since it committed/,
    );
  });

  test("an offline channel cannot be clipped, and finds out before the write", async () => {
    const f = fakeTwitch({
      "GET https://api.twitch.tv/helix/streams": () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    });
    const { exec } = await twitchRig(f);
    const a = await exec.propose("create_clip", CHANNEL, {}, "Clip that", "chat asked");
    const out = await exec.approve(a.id);
    assert.equal(out.status, "failed");
    assert.match(out.error!, /is not live/);
    assert.equal(f.sent("POST", "/helix/clips").length, 0);
  });
});

// ── 6. the corpus, through the real guard chain ──────────────────────────────

function guardInput(o: { facts: Fact[]; answer: string; claims?: { text: string; factId: string }[] }): GuardInput {
  return {
    draft: {
      answer: o.answer,
      claims: (o.claims ?? []).map((c) => ({ ...c, supported: false })),
      parsedOk: true,
      raw: o.answer,
    },
    question: "is the Q1 any good?",
    facts: o.facts,
    factById: new Map(o.facts.map((f) => [f.factId, f])),
    currentListings: new Map(),
    slots: { listingIds: [], viaAnaphora: false } as unknown as GuardInput["slots"],
    policies: [],
    surface: capabilitiesOf("twitch"),
    community: rulesOf(o.facts),
  };
}

describe("what grounds an answer on a channel", () => {
  const corpus = parseChannelCorpus(CHANNEL_FILE)!;
  const facts = twitchFacts(corpus);
  const byId = new Map(facts.map((f) => [f.factId, f]));

  test("an operator's channel file parses into the kinds the guards look for", () => {
    assert.equal(corpus.channel, "kicksbyrae");
    assert.equal(byId.get("schedule:kicksbyrae#1")!.corpus, "schedule");
    assert.match(byId.get("schedule:kicksbyrae#1")!.text, /Thursdays 7pm PT — Keyboard build night/);
    assert.equal(byId.get("sponsor:keychron-q1#brief")!.corpus, "sponsor");
    assert.equal(byId.get("sponsor:keychron-q1#claim1")!.corpus, "sponsor");
    assert.equal(byId.get("community:kicksbyrae#1")!.corpus, "community");
    assert.equal(byId.get("product:kicksbyrae#1")!.corpus, "product");
    // Every corpus this surface declares is one the facts can actually fill.
    for (const f of facts) assert.ok(capabilitiesOf("twitch").corpora.includes(f.corpus), f.factId);
  });

  test("a sponsor fact carries what must be said and what must not be claimed", () => {
    const brief = byId.get("sponsor:keychron-q1#brief")!;
    assert.match(brief.text, /Must be said: This segment is sponsored by Keychron/);
    assert.match(brief.text, /Must not be claimed: waterproof; lifetime warranty/);
    assert.match(brief.text, /Runs until 2026-10-31/);
    // The product name is on EVERY sponsor fact's label, because that is where
    // sponsorGuard looks for the subject of the sponsorship.
    for (const f of facts.filter((x) => x.corpus === "sponsor")) assert.match(f.label, /Keychron Q1/);
  });

  test("a malformed channel file loses the malformed part, not the channel", () => {
    assert.equal(parseChannelCorpus({ schedule: [] }), null, "a file with no channel names nothing");
    const partial = parseChannelCorpus({ channel: "someone", sponsors: [{ product: "A Thing" }] })!;
    assert.deepEqual(partial.sponsors![0]!.mustNotClaim, [], "a brief that forbids nothing is not a parse error");
    assert.equal(partial.schedule!.length, 0);
  });

  test("a claim about the sponsored product with no approved fact behind it BLOCKS", () => {
    const i = guardInput({
      facts,
      answer: "The Keychron is basically indestructible, I have dropped mine plenty of times.",
    });
    const r = sponsorGuard.run(i);
    assert.equal(r.verdict, "block");
    assert.match(r.reason!, /Keychron Q1/);
    // "says who" is answerable from the card: the refusal names the facts that
    // WOULD have supported it.
    assert.match(r.detail!.expected!, /sponsor:keychron-q1#claim1/);
    assert.equal(r.detail!.found, "no citation");

    // …and the whole chain says block, with the sponsor guard among the reasons.
    const chain = runChain(i, { evidenceQuality: 0.9 });
    assert.equal(chain.verdict, "block");
    assert.ok(chain.failures.some((x) => x.guard === "sponsor"));
  });

  test("the same claim citing an approved sponsor fact passes the whole chain", () => {
    const approved = byId.get("sponsor:keychron-q1#claim1")!;
    const i = guardInput({
      facts,
      answer: "The Keychron Q1 uses a gasket mount and comes fully assembled.",
      claims: [{ text: "uses a gasket mount and comes fully assembled", factId: approved.factId }],
    });
    assert.equal(sponsorGuard.run(i).verdict, "allow");
    const chain = runChain(i, { evidenceQuality: 0.9 });
    assert.equal(chain.verdict, "allow", JSON.stringify(chain.failures));
  });

  test("a sponsor's forbidden claim is blocked even when the draft cites correctly", () => {
    // sponsorGuard only asks whether an approved fact was CITED, so a draft
    // that cites the brief and then says the board is waterproof would pass it.
    // The prohibition reaches communityRuleGuard because it is emitted as a
    // constraint, which is the one corpus the chain treats as a rule.
    const i = guardInput({
      facts,
      answer: "The Keychron Q1 is waterproof, so spills are fine.",
      claims: [{ text: "waterproof", factId: "sponsor:keychron-q1#claim1" }],
    });
    const r = communityRuleGuard.run(i);
    assert.equal(r.verdict, "block");
    assert.match(r.reason!, /Keychron sponsor terms/);
    assert.equal(r.detail!.found, "waterproof");
    assert.equal(runChain(i).verdict, "block");
  });

  test("the channel's own chat rules block a draft that breaks one", () => {
    const i = guardInput({ facts, answer: "Sure — link in bio if you want one." });
    const r = communityRuleGuard.run(i);
    assert.equal(r.verdict, "block");
    assert.match(r.reason!, /#kicksbyrae chat rule 2/);
    assert.match(r.reason!, /community:kicksbyrae#2/);
  });

  test("a reply about the schedule is not blocked by anything", () => {
    const schedule = byId.get("schedule:kicksbyrae#1")!;
    const i = guardInput({
      facts,
      answer: "Thursdays 7pm PT — Keyboard build night, and there is a Q and A at the end.",
      claims: [{ text: "Thursdays 7pm PT keyboard build night", factId: schedule.factId }],
    });
    assert.equal(runChain(i, { evidenceQuality: 0.9 }).verdict, "allow");
    // The listing guards found no catalog behind this surface and said so
    // rather than inventing a listing for a number to be stale against.
    const chain = runChain(i, { evidenceQuality: 0.9 });
    assert.equal(chain.guards.find((g) => g.guard === "price")!.verdict, "n/a");
    assert.equal(chain.guards.find((g) => g.guard === "availability")!.verdict, "n/a");
  });
});

after(async () => { await cleanup(); });
