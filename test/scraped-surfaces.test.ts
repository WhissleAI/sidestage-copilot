// Whatnot and TikTok Live, without a network and without a browser.
//
// The eBay watcher's selectors could only ever be checked against a live show,
// which meant they were checked when a show happened to be on and not when
// somebody changed them. These two surfaces are read through a function that
// runs outside a browser as well as inside one (src/surfaces/scrapeDom.ts), so
// every selector here is checked by this file against a fixture of the shape it
// assumes — and when a platform changes, the fixture and the selectors move
// together in one commit and this suite says whether they still agree.
//
// What the fixtures are NOT is captures of real rooms. Whatnot answers a plain
// request with a Cloudflare challenge and TikTok Live is off by default, so
// neither could be refreshed on demand; and a real capture would put a real
// seller's chat in the repo. They record a SHAPE, which is the thing a selector
// is an opinion about.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { domFromHtml, withDocument } from "./domlite.js";
import { extractInPage, type PageSnapshot, type ScrapeSelectors } from "../src/surfaces/scrapeDom.js";
import { dedupeKey } from "../src/surfaces/scrapeWatcher.js";
import { WHATNOT_SELECTORS, whatnotSpec } from "../src/surfaces/whatnot/scrape.js";
import { TIKTOK_SELECTORS, tiktokLiveSpec } from "../src/surfaces/tiktoklive/scrape.js";
import { whatnotAdapter } from "../src/surfaces/whatnot/adapter.js";
import { tiktokLiveAdapter, tiktokLiveEnabled } from "../src/surfaces/tiktoklive/adapter.js";
import { all, get, resolve } from "../src/surfaces/registry.js";
import { capabilitiesOf, SurfaceUnavailable } from "../src/surfaces/types.js";
import { preflight, type PreflightContext } from "../src/actions/preflight.js";

function read(name: string, sel: ScrapeSelectors): PageSnapshot {
  const html = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return withDocument(domFromHtml(html), () => extractInPage(sel));
}

/** What the watcher's poll loop does with a snapshot, minus the browser: new
 *  messages are the ones whose key has not been seen. */
function fresh(seen: Set<string>, s: PageSnapshot): PageSnapshot["messages"] {
  return s.messages.filter((m) => {
    const k = dedupeKey(m);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

describe("reading a Whatnot room", () => {
  const page = read("whatnot-live.html", WHATNOT_SELECTORS);

  test("every buyer message comes out with the platform's own id", () => {
    assert.deepEqual(
      page.messages.map((m) => [m.id, m.author, m.text]),
      [
        ["wn_msg_01HQ7", "sneakerdad", "is the size 10 still open?"],
        ["wn_msg_01HQ8", "cardsbykat", "what’s shipping to Canada on this one?"],
        ["wn_msg_01HQ9", "slabhunter", "GL all — in for $1,300"],
      ],
    );
  });

  test("a system row is not a buyer, and does not become one", () => {
    // "gradedgems started a giveaway" is in the feed with a message id and no
    // author. Passing it on would put the room's own chrome through the reply
    // pipeline as a question to answer.
    assert.ok(!page.messages.some((m) => /giveaway/.test(m.text)));
  });

  test("both markups the app ships are read by the same selector list", () => {
    // Three rows carry `data-testid`, one carries the hashed CSS-module class
    // the app still falls back to. A selector list that only knew the first
    // would lose a message and report a quieter room than there is.
    assert.equal(page.messages.length, 3);
    assert.ok(page.messages.some((m) => m.id === "wn_msg_01HQ9"), "the hashed-class row went missing");
  });

  test("the lot on screen becomes an item with its own id and the current bid", () => {
    const item = whatnotSpec.item!(page.item!, { externalId: "room_1", meta: { kind: "room" } });
    assert.equal(item!.externalRef, "lot_9f31c2", "the platform's lot id is the only stable ref");
    assert.equal(item!.title, "2003 Topps Chrome LeBron RC — PSA 9");
    // The CURRENT BID, not the "Started at $0.99" line sitting next to it. The
    // stale-price guard compares a draft against this number, so reading the
    // wrong one would make it bless a two-year-old price.
    assert.equal(item!.priceCents, 125_000);
    assert.equal(item!.soldOut, false);
  });

  test("the viewer count survives the K the app switches to above a thousand", () => {
    // Read naively, "1.2K watching" is 1 — and a room crossing a thousand
    // viewers would look like it emptied, which the activity watchdog would
    // read as movement and the console would draw as a cliff.
    assert.equal(whatnotSpec.viewers!(page.viewers!), 1200);
  });

  test("a second poll of an unchanged page is not three new messages", () => {
    const seen = new Set<string>();
    assert.equal(fresh(seen, page).length, 3, "the first poll is the backlog");
    assert.equal(fresh(seen, page).length, 0, "the room said nothing and we heard it again");
  });

  test("a Cloudflare challenge is a named failure, not a quiet room", () => {
    // Measured 2026-09-18: whatnot.com/live/<id> over plain HTTPS returns 403
    // and this page. It has a DOM and no chat in it, so an extractor that only
    // counted messages would report the busiest room as silent.
    const blocked = read("whatnot-blocked.html", WHATNOT_SELECTORS);
    assert.match(blocked.blocked!, /Cloudflare/);
    assert.match(blocked.blocked!, /EBAY_DISCOVERY_PROXY/, "the operator needs the fix, not the symptom");
    assert.equal(blocked.messages.length, 0);
    assert.equal(blocked.item, null);
  });

  test("the room's own id and the host's handle address different URLs", () => {
    assert.equal(
      whatnotSpec.url({ externalId: "2f3a9c1e-77de", meta: { kind: "room" } }),
      "https://www.whatnot.com/live/2f3a9c1e-77de",
    );
    // A seller's room id changes every show and their profile URL never does,
    // which is why a handle is addressable at all.
    assert.equal(
      whatnotSpec.url({ externalId: "kicksbyrae", meta: { kind: "handle" } }),
      "https://www.whatnot.com/user/kicksbyrae/live",
    );
  });
});

describe("reading a TikTok Live room", () => {
  const page = read("tiktok-live.html", TIKTOK_SELECTORS);

  test("chat comes out even where TikTok ships no id on the row", () => {
    assert.deepEqual(
      page.messages.map((m) => [m.id, m.author]),
      [
        ["7731900100001", "glowbyjune"],
        ["7731900100002", "mk_reviews"],
        ["", "sunsetsam"],
        ["", "sunsetsam"],
      ],
    );
  });

  test("an idless repeat is heard once, and that is the cost we chose", () => {
    // TikTok keys its chat list in React and the key never reaches the DOM, so
    // two identical "🔥" from one viewer are indistinguishable to us. Hearing
    // them once loses a 🔥; hearing them twice sends a buyer two replies.
    const seen = new Set<string>();
    const first = fresh(seen, page);
    assert.equal(first.length, 3, "the two identical rows collapse to one");
    assert.equal(fresh(seen, page).length, 0);
  });

  test("the pinned TikTok Shop product becomes an item", () => {
    const item = tiktokLiveSpec.item!(page.item!, { externalId: "glowbyjune" });
    assert.equal(item!.externalRef, "tts_7731");
    assert.equal(item!.title, "Hydrating Lip Oil — Peach");
    assert.equal(item!.priceCents, 1299);
    assert.equal(item!.url, "https://www.tiktok.com/@glowbyjune/live");
  });

  test("18.4K viewers is eighteen thousand, not eighteen", () => {
    assert.equal(tiktokLiveSpec.viewers!(page.viewers!), 18_400);
  });

  test("a verification challenge names itself and says a person is needed", () => {
    const blocked = read("tiktok-blocked.html", TIKTOK_SELECTORS);
    assert.match(blocked.blocked!, /verification challenge/);
    // Not a retry. A loop grinding against this page is how a temporary
    // challenge becomes a restricted account.
    assert.match(blocked.blocked!, /a person, not a retry/);
    assert.equal(blocked.messages.length, 0);
  });

  test("a card that has not filled in yet is not an item", () => {
    // TikTok renders the product frame before its data arrives. Emitting the
    // empty one would put an item called "" in front of the seller and, worse,
    // would take the change key — so the real product a beat later would look
    // like the same one and never be emitted at all.
    const empty = { ref: null, title: "", price: "", qty: "", soldOut: false };
    assert.equal(tiktokLiveSpec.item!(empty, { externalId: "x" }), null);
    assert.equal(whatnotSpec.item!(empty, { externalId: "x" }), null);
  });
});

describe("what the operator pasted", () => {
  test("Whatnot accepts a room link, a host link and a qualified handle", () => {
    const cases: [string, string, string | undefined][] = [
      ["https://www.whatnot.com/live/2f3a9c1e-4b77-4d21-9a10-77de0b12c3d4", "2f3a9c1e-4b77-4d21-9a10-77de0b12c3d4", "room"],
      ["whatnot.com/live/2f3a9c1e-4b77", "2f3a9c1e-4b77", "room"],
      ["https://whatnot.com/user/kicksbyrae/live", "kicksbyrae", "handle"],
      ["www.whatnot.com/user/kicksbyrae", "kicksbyrae", "handle"],
      ["https://www.whatnot.com/@kicksbyrae", "kicksbyrae", "handle"],
      ["whatnot:@kicksbyrae", "kicksbyrae", "handle"],
      ["whatnot:2f3a9c1e-4b77", "2f3a9c1e-4b77", "room"],
      ["https://www.whatnot.com/live/abc123?utm_source=x#chat", "abc123", "room"],
    ];
    for (const [input, id, kind] of cases) {
      const t = whatnotAdapter.parseTarget(input);
      assert.equal(t?.externalId, id, input);
      assert.equal(t?.meta?.kind, kind, input);
    }
  });

  test("a bare @handle is refused by BOTH scraped surfaces, on purpose", () => {
    // The same name exists on Whatnot and on TikTok, and the registry resolves
    // by first match over registration order — so accepting it would let
    // registration order decide which stranger's room a seller's copilot
    // attached to. A handle is accepted only when the string says where it is.
    assert.equal(whatnotAdapter.parseTarget("@kicksbyrae"), null);
    assert.equal(tiktokLiveAdapter.parseTarget("@kicksbyrae"), null);
    assert.equal(resolve("@kicksbyrae"), null);
  });

  test("Whatnot refuses what is not a Whatnot live link", () => {
    for (const input of [
      "whatnot.com",
      "whatnot.com/",
      "https://www.whatnot.com/browse/sports-cards",
      "https://www.whatnot.com/live/",
      "https://notwhatnot.com/live/abc123",
      "https://www.tiktok.com/@kicksbyrae/live",
      "47tK1SX0VsiHEXN1",
      "",
    ]) {
      assert.equal(whatnotAdapter.parseTarget(input), null, input || "(empty)");
    }
  });

  test("TikTok accepts a live link and the host page, and nothing else", () => {
    assert.equal(tiktokLiveAdapter.parseTarget("https://www.tiktok.com/@glowbyjune/live")?.externalId, "glowbyjune");
    assert.equal(tiktokLiveAdapter.parseTarget("tiktok.com/@glowbyjune")?.externalId, "glowbyjune");
    assert.equal(tiktokLiveAdapter.parseTarget("tiktoklive:@glowbyjune")?.externalId, "glowbyjune");
    assert.equal(tiktokLiveAdapter.parseTarget("https://www.tiktok.com/@glowbyjune/live")?.handle, "@glowbyjune");

    // A video is a real TikTok URL for a thing that is not a live room.
    // Resolving it to whatever the host is streaming now would attach to
    // something the operator did not name.
    assert.equal(tiktokLiveAdapter.parseTarget("https://www.tiktok.com/@glowbyjune/video/7731900100001"), null);
    assert.equal(tiktokLiveAdapter.parseTarget("https://www.tiktok.com/explore"), null);
    assert.equal(tiktokLiveAdapter.parseTarget("tiktok.com"), null);
    assert.equal(tiktokLiveAdapter.parseTarget("https://www.whatnot.com/live/abc123"), null);
  });

  test("the registry resolves both, and eBay Live still gets first refusal", () => {
    assert.equal(resolve("https://www.whatnot.com/live/abc123")?.adapter.id, "whatnot");
    assert.equal(resolve("https://www.tiktok.com/@glowbyjune/live")?.adapter.id, "tiktoklive");
    assert.equal(resolve("47tK1SX0VsiHEXN1")?.adapter.id, "ebaylive");
    assert.equal(all()[0]!.id, "ebaylive");
    assert.ok(get("whatnot"), "whatnot is not registered");
    assert.ok(get("tiktoklive"), "tiktoklive is not registered — a surface that is off must still be visible");
  });
});

describe("what a scraped surface may do", () => {
  test("neither surface may post, and no setting can change that", () => {
    for (const id of ["whatnot", "tiktoklive"]) {
      const c = capabilitiesOf(id);
      assert.equal(c.delivery, "draft-only", id);
      assert.equal(c.tempo, "live", id);
      // We read the DOM, not the stream. Offering host signals here would be
      // offering an analysis of audio nothing ever decoded.
      assert.deepEqual(c.perception, { audio: false, video: false }, id);
      assert.equal(c.communityRules, false, id);
    }
  });

  test("a markdown is refused because the surface cannot land it anywhere", () => {
    // Every listing write in this system ends at a marketplace we hold seller
    // credentials for, and we hold none for Whatnot. A markdown that changed
    // our row while the platform kept selling at the old price would report
    // success and change nothing a buyer can see.
    const ctx: PreflightContext = {
      surface: capabilitiesOf("whatnot"),
      committedThisShow: 0, actionBudget: 10, committedLastMinute: 0, ratePerMinute: 6,
    };
    const r = preflight("markdown_price", null, { newPriceCents: 900 }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.checks[0]!.detail, "this surface cannot markdown_price");

    // What is left is the two kinds that only write records we own.
    assert.equal(preflight("flag_for_human", null, {}, ctx).ok, true);
    assert.equal(preflight("mark_highlight", null, {}, ctx).ok, true);
  });

  test("the adapters declare the same capabilities the static table does", () => {
    // The table is what guards and preflight read, sometimes before an adapter
    // has been imported. These two must not be able to drift.
    assert.equal(whatnotAdapter.capabilities, capabilitiesOf("whatnot"));
    assert.equal(tiktokLiveAdapter.capabilities, capabilitiesOf("tiktoklive"));
  });
});

describe("TikTok Live is shipped off", () => {
  test("open() refuses while the switch is unset, and names the switch", async () => {
    const before = process.env.TIKTOK_LIVE_ENABLED;
    delete process.env.TIKTOK_LIVE_ENABLED;
    try {
      assert.equal(tiktokLiveEnabled(), false);
      await assert.rejects(
        () => tiktokLiveAdapter.open({ externalId: "glowbyjune" }, {}),
        (e: unknown) =>
          e instanceof SurfaceUnavailable &&
          e.surface === "tiktoklive" &&
          e.missing === "TIKTOK_LIVE_ENABLED" &&
          // The refusal has to carry the reason. "Not enabled" invites someone
          // to enable it on a cron; "it costs the seller's account" does not.
          /account/.test(e.message),
      );
    } finally {
      if (before === undefined) delete process.env.TIKTOK_LIVE_ENABLED;
      else process.env.TIKTOK_LIVE_ENABLED = before;
    }
  });

  test("the switch is read at open(), not captured at import", () => {
    // An operator who sets it in front of the process expects the next attach
    // to obey. A value read once at module load needs a restart to mean
    // anything, which is a surprise nobody has a reason to expect.
    const before = process.env.TIKTOK_LIVE_ENABLED;
    try {
      for (const on of ["1", "true", "YES", "on"]) {
        process.env.TIKTOK_LIVE_ENABLED = on;
        assert.equal(tiktokLiveEnabled(), true, on);
      }
      for (const off of ["", "0", "false", "no", " "]) {
        process.env.TIKTOK_LIVE_ENABLED = off;
        assert.equal(tiktokLiveEnabled(), false, JSON.stringify(off));
      }
    } finally {
      if (before === undefined) delete process.env.TIKTOK_LIVE_ENABLED;
      else process.env.TIKTOK_LIVE_ENABLED = before;
    }
  });
});
