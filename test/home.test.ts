/**
 * Home describes the product, not one surface.
 *
 * `GET /api/home` was eBay Live discovery with a few counts around it: every
 * key in it came out of the eBay grid poll, so a session on Twitch, a watch on
 * a subreddit and a queue of follow-ups were all invisible to the one endpoint
 * the front page reads. These are the rules of the shape that replaced it —
 * and the first of them is that nothing was taken away, because a browser tab
 * left open on the old bundle keeps polling this route through a deploy.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { surfaceReadiness, duringPhrase, afterPhrase, type ReadinessFacts } from "../src/surfaces/readiness.js";
import { nowBand, behindBand, type ReportRow } from "../src/api/home.js";
import { capabilitiesOf, SurfaceUnavailable, type SurfaceId } from "../src/surfaces/types.js";
import { requireTwitchCreds } from "../src/surfaces/twitch/api.js";
import { requireCreds as requireRedditCreds } from "../src/surfaces/reddit/api.js";
import { tiktokLiveEnabled } from "../src/surfaces/tiktoklive/adapter.js";
import type { ShowSummary } from "../src/shows/registry.js";
import type { ShowReport } from "../src/shows/sessionRecord.js";
import { db as pgPool } from "../src/db/pg.js";

// ── the surface table ────────────────────────────────────────────────────────

/** The surfaces as the registry hands them over: id, label, attachable. */
const REGISTERED: { id: SurfaceId; label: string; attachable: boolean }[] = [
  { id: "ebaylive", label: "eBay Live", attachable: true },
  { id: "simulated", label: "Simulated show", attachable: true },
  { id: "dm", label: "Follow-up inbox", attachable: false },
  { id: "reddit", label: "Reddit", attachable: true },
  { id: "whatnot", label: "Whatnot", attachable: true },
  { id: "tiktoklive", label: "TikTok Live", attachable: true },
  { id: "twitch", label: "Twitch", attachable: true },
];

/** An operator who has connected nothing at all. */
function facts(over: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    surfaces: REGISTERED,
    // Deliberately NOT process.env: a suite that read the ambient environment
    // would give a developer with a working .env a different answer from CI.
    env: {},
    ebayConnected: false,
    ebaySignedIn: false,
    twitchConnected: false,
    ownCatalogs: 0,
    ownCatalogItems: 0,
    prepared: 0,
    liveBySurface: {},
    roomsBySurface: {},
    followups: 0,
    ...over,
  };
}

const row = (f: ReadinessFacts, id: SurfaceId) => surfaceReadiness(f).find((s) => s.id === id)!;

/** What `SurfaceUnavailable` puts in `missing` for a surface with no keys. */
function refusalNames(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof SurfaceUnavailable ? e.missing : undefined;
  }
  return undefined;
}

describe("what each surface still needs", () => {
  test("a keyless Twitch names the SAME variable the refusal names", () => {
    const r = row(facts(), "twitch");
    assert.equal(r.connected, false);
    assert.equal(r.missing, "TWITCH_CLIENT_ID");
    // The whole point of naming it: the operator reads one string in the
    // surface table and the identical string in the 409 from attach.
    assert.equal(r.missing, refusalNames(() => requireTwitchCreds({})));
    // The first step is the one that is not done, and it says what to set.
    assert.equal(r.before[0]!.done, false);
    assert.match(r.before[0]!.cta!, /TWITCH_CLIENT_ID/);
  });

  test("half a Twitch application names the half that is missing", () => {
    const r = row(facts({ env: { TWITCH_CLIENT_ID: "abc" } }), "twitch");
    assert.equal(r.missing, "TWITCH_CLIENT_SECRET");
    assert.equal(r.connected, false);
  });

  test("keys without consent is a missing consent, not a missing variable", () => {
    const env = { TWITCH_CLIENT_ID: "abc", TWITCH_CLIENT_SECRET: "shh" };
    const r = row(facts({ env }), "twitch");
    assert.equal(r.connected, false);
    assert.equal(r.missing, "a connected Twitch account");
    assert.equal(r.before[0]!.done, true, "the application step is done");
    assert.equal(r.before[1]!.done, false, "the consent step is not");
  });

  test("keys AND consent is connected, with nothing missing", () => {
    const r = row(
      facts({ env: { TWITCH_CLIENT_ID: "abc", TWITCH_CLIENT_SECRET: "shh" }, twitchConnected: true }),
      "twitch",
    );
    assert.equal(r.connected, true);
    assert.equal(r.missing, null);
  });

  test("a scraped surface needs nothing, so it is connected rather than red", () => {
    const r = row(facts(), "whatnot");
    // No key, no consent, no account — the room is read in a browser. A red
    // mark here would be the table inventing a blocker to show.
    assert.equal(r.connected, true);
    assert.equal(r.missing, null);
    assert.equal(r.tempo, "live");
    assert.equal(r.delivery, "draft-only");
    // It answers in the moment; the human presses send, because no platform
    // door exists for us to post through.
    assert.equal(r.during, "answers, you send");
    assert.equal(r.after, "report and follow-ups");
    assert.equal(r.before[0]!.done, true, "there is nothing to connect");
    assert.equal(r.before.some((s) => /ground truth/i.test(s.label)), true);
    assert.equal(r.before.at(-1)!.label, "Attach a room");
  });

  test("a scraped surface with a room open says the room is open", () => {
    const r = row(facts({ liveBySurface: { whatnot: 1 }, ownCatalogItems: 12 }), "whatnot");
    assert.deepEqual(r.before.map((s) => s.done), [true, true, true]);
  });

  test("TikTok Live's off switch is a named variable, not a broken surface", () => {
    const off = row(facts(), "tiktoklive");
    assert.equal(off.connected, false);
    // Exactly what the adapter's refusal carries — the switch exists because
    // TikTok answers an unattended browser with a restriction on the seller's
    // own account, and the table says which switch.
    assert.equal(off.missing, "TIKTOK_LIVE_ENABLED");

    const on = row(facts({ env: { TIKTOK_LIVE_ENABLED: "1" } }), "tiktoklive");
    assert.equal(on.connected, true);
    assert.equal(on.missing, null);
    // The same predicate the adapter opens with, so the two cannot drift.
    assert.equal(tiktokLiveEnabled({ TIKTOK_LIVE_ENABLED: "1" }), true);
    assert.equal(tiktokLiveEnabled({}), false);
  });

  test("Reddit is draft-only, and the row says so where an operator will read it", () => {
    const r = row(facts(), "reddit");
    assert.equal(r.tempo, "async");
    assert.equal(r.delivery, "draft-only");
    assert.equal(r.during, "drafts only");
    assert.equal(r.after, "a record of what you sent");
    // Not only in a capability field: the promise that we never post is a
    // Before step, because that is where somebody decides whether to bother.
    assert.equal(
      r.before.some((s) => /is ever posted for you/i.test(s.label) && s.done),
      true,
    );
  });

  test("Reddit's missing credential is the one the refusal names, in the same order", () => {
    assert.equal(row(facts(), "reddit").missing, "REDDIT_CLIENT_ID");
    assert.equal(row(facts(), "reddit").missing, refusalNames(() => requireRedditCreds({})));
    const partial = { REDDIT_CLIENT_ID: "a", REDDIT_CLIENT_SECRET: "b" };
    assert.equal(row(facts({ env: partial }), "reddit").missing, "REDDIT_USERNAME");
  });

  test("Reddit counts its rooms, and the rules step follows them", () => {
    const env = {
      REDDIT_CLIENT_ID: "a", REDDIT_CLIENT_SECRET: "b", REDDIT_USERNAME: "c",
      REDDIT_PASSWORD: "d", REDDIT_USER_AGENT: "sidestage/1.0 by kicksbyrae",
    };
    const none = row(facts({ env }), "reddit");
    assert.equal(none.connected, true, "five values is a working script app");
    assert.equal(none.rooms, 0);
    assert.equal(none.before[1]!.done, false, "no subreddits chosen");
    assert.equal(none.before[2]!.done, false, "so no room's rules are in force");

    const watched = row(facts({ env, roomsBySurface: { reddit: 3 } }), "reddit");
    assert.equal(watched.rooms, 3);
    assert.equal(watched.before[1]!.done, true);
    assert.equal(watched.before[2]!.done, true);
  });

  test("the follow-up inbox is connected, async, and not attachable", () => {
    const r = row(facts(), "dm");
    assert.equal(r.connected, true);
    assert.equal(r.missing, null);
    assert.equal(r.attachable, false, "there is no feed to open");
    assert.equal(r.during, "drafts only");
    assert.equal(r.rooms, 0, "an async surface always carries a room count");
    assert.equal(r.before.at(-1)!.done, false);
    assert.equal(row(facts({ followups: 4 }), "dm").before.at(-1)!.done, true);
  });

  test("eBay Live keeps the four steps the old checklist had, in order", () => {
    const empty = row(facts(), "ebaylive");
    assert.deepEqual(
      empty.before.map((s) => s.label),
      ["Connect your eBay account", "Load your listings", "Sign in to eBay Live", "Prepare your next show"],
    );
    assert.deepEqual(empty.before.map((s) => s.done), [false, false, false, false]);
    assert.equal(empty.connected, false);
    assert.equal(empty.missing, "a connected eBay account");
    assert.equal(empty.during, "answers and acts");

    const ready = row(
      facts({ ebayConnected: true, ebaySignedIn: true, ownCatalogItems: 40, ownCatalogs: 1, prepared: 2 }),
      "ebaylive",
    );
    assert.deepEqual(ready.before.map((s) => s.done), [true, true, true, true]);
    assert.equal(ready.connected, true);
    assert.equal(ready.missing, null);
  });

  test("the environment is read at call time, so a restart with new keys shows", () => {
    // Two calls, one module load, two answers. A key captured at import would
    // need a deploy to mean anything, which is the failure this rules out.
    assert.equal(row(facts({ env: {} }), "reddit").connected, false);
    assert.equal(
      row(
        facts({
          env: {
            REDDIT_CLIENT_ID: "a", REDDIT_CLIENT_SECRET: "b", REDDIT_USERNAME: "c",
            REDDIT_PASSWORD: "d", REDDIT_USER_AGENT: "ua",
          },
        }),
        "reddit",
      ).connected,
      true,
    );
  });

  test("nothing is shared between accounts: the same call, two operators", () => {
    const rae = surfaceReadiness(facts({ ebayConnected: true, twitchConnected: true }));
    const jo = surfaceReadiness(facts());
    assert.equal(rae.find((s) => s.id === "ebaylive")!.connected, true);
    assert.equal(jo.find((s) => s.id === "ebaylive")!.connected, false, "Jo got Rae's answer");
  });

  test("during and after are read off the declared capabilities", () => {
    // Not a per-surface string table: a surface that loses `delivery: "api"`
    // must stop claiming it can send in the same edit.
    assert.equal(duringPhrase(capabilitiesOf("ebaylive")), "answers and acts");
    assert.equal(duringPhrase(capabilitiesOf("twitch")), "answers and acts");
    assert.equal(duringPhrase(capabilitiesOf("whatnot")), "answers, you send");
    assert.equal(duringPhrase(capabilitiesOf("reddit")), "drafts only");
    assert.equal(duringPhrase(capabilitiesOf("dm")), "drafts only");
    assert.equal(afterPhrase(capabilitiesOf("ebaylive")), "report and follow-ups");
    assert.equal(afterPhrase(capabilitiesOf("reddit")), "a record of what you sent");
  });

  test("every row carries the whole phase story, for every surface", () => {
    for (const s of surfaceReadiness(facts())) {
      assert.equal(typeof s.label, "string");
      assert.ok(["live", "async"].includes(s.tempo), s.id);
      assert.ok(["api", "draft-only"].includes(s.delivery), s.id);
      assert.equal(typeof s.connected, "boolean", s.id);
      assert.ok(s.missing === null || typeof s.missing === "string", s.id);
      assert.ok(Array.isArray(s.before) && s.before.length > 0, s.id);
      assert.ok(["answers and acts", "answers, you send", "drafts only"].includes(s.during), s.id);
      assert.ok(["report and follow-ups", "a record of what you sent"].includes(s.after), s.id);
    }
  });
});

// ── now, and behind you ──────────────────────────────────────────────────────

const session = (over: Partial<ShowSummary> = {}): ShowSummary => ({
  showId: "sess_1", ownerAccountId: null, agentId: "agent", catalogId: null,
  title: "A session", sellerHandle: "@host", source: "ebaylive", externalId: null,
  readOnly: true, writeTarget: "mock", status: "live", startedAt: "2026-09-18T20:00:00.000Z",
  viewers: 0, listings: 0, proposals: 0, awaiting: 0, blocked: 0,
  ...over,
});

describe("what needs a human now", () => {
  test("a session on air is on air whatever surface it is on", () => {
    const band = nowBand(
      [
        session({ showId: "tw_1", source: "twitch", title: "Friday stream", sellerHandle: "@rae", awaiting: 2, blocked: 1 }),
        session({ showId: "rd_1", source: "reddit", title: "r/mechmarket", awaiting: 4 }),
      ],
      0,
    );
    // The eBay grid can see neither of these. Until this, neither could home.
    assert.deepEqual(band.live.map((l) => l.surface), ["twitch", "reddit"]);
    assert.deepEqual(band.live[0], {
      showId: "tw_1", surface: "twitch", title: "Friday stream", host: "@rae",
      startedAt: "2026-09-18T20:00:00.000Z", awaiting: 2, blocked: 1, readOnly: true,
    });
  });

  test("a finished session is not on air", () => {
    const band = nowBand([session({ status: "ended" }), session({ showId: "b" })], 0);
    assert.deepEqual(band.live.map((l) => l.showId), ["b"]);
  });

  test("the drafts band is the ASYNC queues, not every queue", () => {
    const band = nowBand(
      [
        // A live console's queue is not a draft queue: somebody is sitting in
        // front of it, and NOW already names the session itself.
        session({ showId: "eb", source: "ebaylive", awaiting: 9 }),
        session({ showId: "rd", source: "reddit", awaiting: 4 }),
        session({ showId: "rd2", source: "reddit", awaiting: 3 }),
      ],
      2,
    );
    assert.equal(band.drafts.total, 9);
    assert.deepEqual(band.drafts.bySurface, [
      { surface: "reddit", count: 7 },
      { surface: "dm", count: 2 },
    ]);
  });

  test("an empty inbox adds no row at all", () => {
    const band = nowBand([], 0);
    assert.deepEqual(band.drafts, { total: 0, bySurface: [] });
    assert.deepEqual(band.live, []);
  });
});

describe("what finished", () => {
  const report = (gaps: { question: string; asked: number; reason: string }[]): ShowReport =>
    ({
      showId: "s", title: "Friday Night Grails", source: "ebaylive",
      startedAt: "2026-09-18T20:00:00.000Z", endedAt: "2026-09-18T22:00:00.000Z", durationMin: 120,
      engagement: { commentsSeen: 190, questionsAsked: 60, answered: 41, sent: 0, answeredRate: 0.68, medianLatencyMs: 900, p95LatencyMs: 1800, cacheHitRate: 0.2 },
      safety: { blocked: 3, revised: 1, abstained: 2, flaggedWrong: 0, flagReasons: {}, byGuard: {}, auditChain: { ok: true, height: 12 }, examples: [] },
      inventory: { lotsObserved: 20, lotsEnded: 18, priceChanges: 4, peakViewers: 300 },
      actions: { proposed: 2, committed: 1, rolledBack: 0, failed: 0 },
      gaps: { unanswered: gaps, droppedByGate: {} },
    }) as unknown as ShowReport;

  const rowFor = (over: Partial<ReportRow> = {}): ReportRow => ({
    showId: "ebay_1", title: "row title", surface: "ebaylive", source: "ebaylive",
    generatedAt: "2026-09-18T22:05:00.000Z", report: report([]), ...over,
  });

  test("the top gap is READ from the report, never recomputed", () => {
    const b = behindBand(
      [rowFor({
        report: report([
          { question: "do you ship to canada", asked: 2, reason: "no policy clause" },
          { question: "is the box included", asked: 7, reason: "not in the catalog" },
          { question: "what size is it", asked: 5, reason: "not in the catalog" },
        ]),
      })],
      { total: 0, ready: 0 },
    );
    assert.equal(b.reports[0]!.topGap, "is the box included");
    assert.equal(b.reports[0]!.answered, 41);
    assert.equal(b.reports[0]!.blocked, 3);
    assert.equal(b.reports[0]!.endedAt, "2026-09-18T22:00:00.000Z");
    // The report's own title wins over the row's: the row can be renamed after
    // the fact, the report is what the session actually was.
    assert.equal(b.reports[0]!.title, "Friday Night Grails");
  });

  test("a session that answered everything has no gap to name", () => {
    assert.equal(behindBand([rowFor()], { total: 0, ready: 0 }).reports[0]!.topGap, null);
  });

  test("a row written before surfaces existed answers as what it was", () => {
    const b = behindBand([rowFor({ surface: null, source: "simulated" })], { total: 1, ready: 1 });
    assert.equal(b.reports[0]!.surface, "simulated");
    assert.deepEqual(b.followups, { total: 1, ready: 1 });
  });
});

// ── the endpoint itself ──────────────────────────────────────────────────────

const { buildApp } = await import("../src/api/server.js");
type AppContext = Awaited<ReturnType<typeof buildApp>>["ctx"];

let app: FastifyInstance;
let ctx: AppContext;
let auth: Record<string, string>;
let accountId: string;
let otherAccountId: string;

/** Ids unique to this run. The suite shares one database with every other
 *  file and with every previous run, and a fixed id would be a row somebody
 *  else's account already owns. */
const run = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
const showIds: string[] = [];

const register = async (tag: string) =>
  (
    await app.inject({
      method: "POST", url: "/api/auth/register",
      headers: { "content-type": "application/json" },
      payload: {
        email: `home-${tag}-${Date.now()}${Math.random().toString(16).slice(2)}@test.local`,
        password: "password-123", displayName: `home-${tag}`,
      },
    })
  ).json() as { token: string; account: { id: string } };

before(async () => {
  ({ app, ctx } = await buildApp());
  const mine = await register("mine");
  auth = { authorization: `Bearer ${mine.token}` };
  accountId = mine.account.id;
  otherAccountId = (await register("other")).account.id;
});

after(async () => {
  // Leave the database as it was found: these rows exist for this run only.
  if (showIds.length) {
    await pgPool()
      .query("DELETE FROM shows WHERE id = ANY($1::text[])", [showIds])
      .catch(() => {});
  }
  await app.close();
  await ctx.stop();
});

const ebayShow = `home_${run}_ebay`;
const redditShow = `home_${run}_reddit`;
const otherShow = `home_${run}_other`;
const noReportShow = `home_${run}_noreport`;

const home = async () => {
  const r = await app.inject({ method: "GET", url: "/api/home", headers: auth });
  assert.equal(r.statusCode, 200);
  return r.json();
};

/** A finished session with a report, owned by one account. */
async function seedFinishedSession(
  id: string, owner: string, surface: SurfaceId, gaps: { question: string; asked: number; reason: string }[],
) {
  showIds.push(id);
  await pgPool().query(
    `INSERT INTO shows (id, owner_account_id, title, seller_handle, started_at, source, surface, status)
     VALUES ($1,$2,$3,'@rae','2026-09-18T20:00:00.000Z',$4,$4,'ended')
     ON CONFLICT (id) DO NOTHING`,
    [id, owner, `Session ${id}`, surface],
  );
  await pgPool().query(
    // A year ahead on purpose: test files run concurrently against one
    // database and several of them write reports, so "the newest six" is not
    // a thing a test can pin down without saying which one is newest.
    `INSERT INTO show_reports (show_id, generated_at, report)
     VALUES ($1, now() + interval '365 days', $2::jsonb)
     ON CONFLICT (show_id) DO UPDATE SET report = EXCLUDED.report, generated_at = EXCLUDED.generated_at`,
    [id, JSON.stringify({
      showId: id, title: `Report for ${id}`, source: surface,
      startedAt: "2026-09-18T20:00:00.000Z", endedAt: "2026-09-18T23:00:00.000Z", durationMin: 180,
      engagement: { commentsSeen: 10, questionsAsked: 8, answered: 6, sent: 1, answeredRate: 0.75, medianLatencyMs: 800, p95LatencyMs: 1500, cacheHitRate: 0 },
      safety: { blocked: 2, revised: 0, abstained: 1, flaggedWrong: 0, flagReasons: {}, byGuard: {}, auditChain: { ok: true, height: 3 }, examples: [] },
      inventory: { lotsObserved: 3, lotsEnded: 2, priceChanges: 1, peakViewers: 40 },
      actions: { proposed: 0, committed: 0, rolledBack: 0, failed: 0 },
      gaps: { unanswered: gaps, droppedByGate: {} },
    })],
  );
}

describe("GET /api/home", () => {
  test("every key the old bundle reads is still there, with the same shape", async () => {
    const body = await home();
    // The contract a tab opened before the deploy is still holding.
    for (const key of ["live", "discovery", "prepared", "preparing", "watching"]) {
      assert.ok(key in body, `lost ${key}`);
    }
    assert.ok(Array.isArray(body.live));
    assert.ok(Array.isArray(body.prepared));
    assert.ok(Array.isArray(body.preparing));
    assert.ok(Array.isArray(body.watching));
    assert.deepEqual(Object.keys(body.discovery).sort(), ["checkedAt", "reason", "session"]);
    assert.equal(typeof body.discovery.reason, "string");
    assert.equal(typeof body.discovery.session.present, "boolean");
  });

  test("and four new ones that describe the whole product", async () => {
    const body = await home();
    assert.ok(Array.isArray(body.now.live));
    assert.equal(typeof body.now.drafts.total, "number");
    assert.ok(Array.isArray(body.now.drafts.bySurface));
    // The prepared list is the same list, not a second opinion about it.
    assert.deepEqual(body.next.prepared, body.prepared);
    // `discoverable` is COMPUTED now, not the constant `["ebaylive"]` it used
    // to be. In the suite there is no eBay Live session, no Twitch key and no
    // Reddit credential, so the only surface Discover can actually read is the
    // one that needs nothing — and TikTok Live, which has no index to read at
    // all, is never in it whatever the environment says.
    assert.ok(Array.isArray(body.next.discoverable));
    assert.deepEqual(body.next.discoverable, ["whatnot"]);
    assert.equal(body.next.discoverable.includes("tiktoklive"), false);
    assert.ok(Array.isArray(body.behind.reports));
    assert.equal(typeof body.behind.followups.total, "number");
    assert.equal(typeof body.behind.followups.ready, "number");
    assert.ok(Array.isArray(body.surfaces));
  });

  test("the surface table is the surfaces that exist, not the ones we declared", async () => {
    const body = await home();
    const ids = body.surfaces.map((s: { id: string }) => s.id);
    // `youtubelive` has a capability row and no adapter in this build. Offering
    // it would be an invitation the attach route then refuses.
    assert.equal(ids.includes("youtubelive"), false);
    for (const id of ["ebaylive", "whatnot", "tiktoklive", "twitch", "reddit", "dm", "simulated"]) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
    const dm = body.surfaces.find((s: { id: string }) => s.id === "dm");
    assert.equal(dm.attachable, false);
    // The suite runs with no keys — and says which one it wants first.
    const twitch = body.surfaces.find((s: { id: string }) => s.id === "twitch");
    assert.equal(twitch.connected, false);
    assert.equal(twitch.missing, "TWITCH_CLIENT_ID");
    const reddit = body.surfaces.find((s: { id: string }) => s.id === "reddit");
    assert.equal(reddit.during, "drafts only");
    assert.equal(reddit.rooms, 0);
  });

  test("the rooms an operator watches show up against their surface", async () => {
    await app.inject({
      method: "POST", url: "/api/surfaces/reddit/rooms",
      headers: { ...auth, "content-type": "application/json" },
      payload: { room: "r/mechmarket" },
    });
    const reddit = (await home()).surfaces.find((s: { id: string }) => s.id === "reddit");
    assert.equal(reddit.rooms, 1);
    assert.equal(reddit.before[1].done, true, "choosing a subreddit is a step, and it is done");
  });

  test("the follow-up inbox is a draft queue, counted under dm", async () => {
    await seedFinishedSession(ebayShow, accountId, "ebaylive", []);
    await pgPool().query(
      `INSERT INTO followups (id, show_id, account_id, buyer, question, draft)
       VALUES ($1,$2,$3,'@buyer','is the box included','Yes — it ships in the original box.')
       ON CONFLICT (show_id, buyer) DO NOTHING`,
      [`fu_${run}_1`, ebayShow, accountId],
    );

    const body = await home();
    assert.deepEqual(body.behind.followups, { total: 1, ready: 1 });
    assert.deepEqual(
      body.now.drafts.bySurface.find((d: { surface: string }) => d.surface === "dm"),
      { surface: "dm", count: 1 },
    );
    assert.equal(body.now.drafts.total, 1);
    // And the surface row reads the same fact.
    const dm = body.surfaces.find((s: { id: string }) => s.id === "dm");
    assert.equal(dm.before.at(-1).done, true);
  });

  test("a report from another surface lands in BEHIND with its top gap", async () => {
    await seedFinishedSession(redditShow, accountId, "reddit", [
      { question: "does it ship to canada", asked: 1, reason: "no policy clause" },
      { question: "what is the warranty", asked: 6, reason: "not in the catalog" },
    ]);
    const body = await home();
    const mine = body.behind.reports.find((r: { showId: string }) => r.showId === redditShow);
    assert.ok(mine, "the report is not in the band");
    assert.equal(mine.surface, "reddit");
    assert.equal(mine.title, `Report for ${redditShow}`);
    assert.equal(mine.answered, 6);
    assert.equal(mine.blocked, 2);
    assert.equal(mine.endedAt, "2026-09-18T23:00:00.000Z");
    assert.equal(mine.topGap, "what is the warranty");
  });

  test("a session that ended and produced NO report is still a row in behind you", async () => {
    // The row an operator most wants to see: the session finished and nothing
    // came out of it. An inner join to `show_reports` hid exactly these.
    showIds.push(noReportShow);
    await pgPool().query(
      `INSERT INTO shows (id, owner_account_id, title, seller_handle, started_at, source, surface, status)
       VALUES ($1,$2,'The one whose report failed','@rae','2026-09-18T20:00:00.000Z','twitch','twitch','ended')
       ON CONFLICT (id) DO NOTHING`,
      [noReportShow, accountId],
    );
    await pgPool().query(
      `INSERT INTO chat_messages (show_id, id, author, text, at, admitted)
       VALUES ($1, 'm1', 'someone', 'is the 517 still up?', '2027-09-18T22:40:00.000Z', TRUE)
       ON CONFLICT DO NOTHING`,
      [noReportShow],
    );

    const body = await home();
    const row = body.behind.reports.find((r: { showId: string }) => r.showId === noReportShow);
    assert.ok(row, "a session with no report vanished from behind you");
    assert.equal(row.hasReport, false);
    assert.equal(row.surface, "twitch");
    assert.equal(row.title, "The one whose report failed");
    // Nulls, not zeroes: "answered 0" is a measurement nobody made.
    assert.equal(row.answered, null);
    assert.equal(row.blocked, null);
    assert.equal(row.topGap, null);
    // Nothing writes the moment a session stopped, so the end time falls back
    // to the last thing it heard.
    assert.equal(row.endedAt, "2027-09-18T22:40:00.000Z");

    // And a session WITH a report is unchanged, down to the flag.
    const reported = body.behind.reports.find((r: { showId: string }) => r.showId === redditShow);
    assert.ok(reported);
    assert.equal(reported.hasReport, true);
    assert.equal(reported.answered, 6);
  });

  test("another seller's follow-ups are not in this seller's numbers", async () => {
    await seedFinishedSession(otherShow, otherAccountId, "ebaylive", []);
    await pgPool().query(
      `INSERT INTO followups (id, show_id, account_id, buyer, question, draft)
       VALUES ($1,$2,$3,'@someone','how much','Not yours to read.')
       ON CONFLICT (show_id, buyer) DO NOTHING`,
      [`fu_${run}_other`, otherShow, otherAccountId],
    );
    const body = await home();
    assert.deepEqual(body.behind.followups, { total: 1, ready: 1 }, "counted somebody else's inbox");
    assert.equal(
      body.behind.reports.some((r: { showId: string }) => r.showId === otherShow),
      false,
      "showed somebody else's session",
    );
  });
});
