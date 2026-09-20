// What the box can afford, and what it refuses.
//
// Steady state on the deployed instance is genuinely good — zero Chrome, zero
// zombies, every container well inside its limit after a real browse scrape.
// The defects are all at the EDGES, and they share one shape: every caller
// reasoned about browser lifetime on its own and no single place knew how many
// were open.
//
// Worst case before this: six watched Whatnot rooms (a whole Chrome each) plus
// the shared eBay Live browser plus the five-minute discovery poll = EIGHT real
// Chromes against a 1100 MB container limit that also holds Node. That is an
// OOM kill, which takes every other watched show with it, rather than a
// refusal.
//
// None of this code can be exercised through a real browser here: there is not
// one Playwright import in the suite, which is exactly why these three bugs
// survived. So the parts that are pure STATE — the count, the admission
// decision and the acquire/release pairing — were moved somewhere a test can
// reach them, and this is that test.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { takeBrowser, browserBudget, resetBrowserBudget, NoBrowserBudget } from "../src/surfaces/browserBudget.js";
import { ownsABrowser } from "../src/surfaces/types.js";
import { EbayLiveWatcher } from "../src/ingest/ebaylive/watcher.js";

describe("the browser budget owns the count", () => {
  beforeEach(() => resetBrowserBudget());

  test("the box refuses the browser it cannot afford instead of being killed holding the others", () => {
    const max = config.maxBrowsers;
    const leases = [];
    for (let i = 0; i < max; i++) leases.push(takeBrowser(`p${i}`));
    assert.equal(browserBudget().open, max);

    assert.throws(() => takeBrowser("one-too-many"), NoBrowserBudget);
    // Refusing is an answer a route can put in a response; the message has to
    // tell an operator what to do about it.
    try {
      takeBrowser("one-too-many");
    } catch (e) {
      assert.match((e as Error).message, /MAX_BROWSERS/);
      assert.match((e as Error).message, /Stop watching a room/);
    }

    leases[0]!.release();
    assert.equal(browserBudget().open, max - 1, "a released slot comes back");
    assert.doesNotThrow(() => takeBrowser("now-affordable"));
  });

  test("releasing twice does not hand out a slot twice — the refcount bug, made unwritable", () => {
    const a = takeBrowser("x");
    takeBrowser("y");
    assert.equal(browserBudget().open, 2);
    a.release();
    a.release();
    a.release();
    assert.equal(browserBudget().open, 1, "an idempotent lease cannot lie about the count");
  });

  test("the budget says what each browser is for, so /health can name the rooms", () => {
    takeBrowser("room:whatnot");
    takeBrowser("room:whatnot");
    takeBrowser("ebay-discovery");
    assert.deepEqual(browserBudget().held, { "room:whatnot": 2, "ebay-discovery": 1 });
  });
});

describe("which surfaces cost a whole browser", () => {
  test("only the scraped ones — stated once rather than derived from four launchers", () => {
    assert.equal(ownsABrowser("whatnot"), true);
    assert.equal(ownsABrowser("tiktoklive"), true);
    // eBay Live drives a browser but SHARES one Chromium across every show.
    assert.equal(ownsABrowser("ebaylive"), false);
    for (const s of ["twitch", "reddit", "dm", "simulated"] as const) {
      assert.equal(ownsABrowser(s), false, `${s} is HTTP, not a browser`);
    }
  });
});

describe("the eBay Live watcher gives its browser reference back", () => {
  test("recovery releases the dead page's reference BEFORE taking a new one", async () => {
    const w = new EbayLiveWatcher({ eventId: "ev_leak_1" });
    const p = w as unknown as {
      holding: boolean;
      page: unknown;
      openPage(): Promise<void>;
      scrape(): Promise<unknown>;
      recoverIfDead(): Promise<void>;
    };

    // The state after a successful start: this watcher holds a reference, and
    // its page has since died.
    p.holding = true;
    p.page = null;

    let holdingWhenReopened: boolean | null = null;
    p.openPage = async () => {
      holdingWhenReopened = p.holding;
      p.holding = true;
      p.page = { isClosed: () => false, context: () => ({ browser: () => ({ isConnected: () => true }) }) };
    };
    p.scrape = async () => ({ comments: [], lot: null, viewers: null });

    await p.recoverIfDead();

    assert.equal(
      holdingWhenReopened,
      false,
      "the old reference must be given back first — without this every renderer crash " +
      "permanently raised the refcount and the shared Chromium was never closed",
    );
    assert.equal(p.holding, true, "and the watcher holds exactly one again");
  });

  test("stopping gives the reference back, and stopping twice does not give it back twice", async () => {
    const w = new EbayLiveWatcher({ eventId: "ev_leak_2" });
    const p = w as unknown as { holding: boolean; page: unknown };
    p.holding = true;
    p.page = null;
    await w.stop();
    assert.equal(p.holding, false);
    await w.stop();
    assert.equal(p.holding, false);
  });
});

// ── the cap that did not cap ────────────────────────────────────────────────
//
// `MAX_WATCHED_SHOWS` was checked against `this.runtimes`, which is populated
// only AFTER `rt.start()` resolves — and for a scraped surface that is a
// browser launch plus up to 45 s on `page.goto` and 30 s on
// `waitForSelector`. So N concurrent attaches for N distinct rooms all
// observed `runtimes.size === 0`, all passed the check, and all launched a
// browser. A console firing attach for several Discover cards, or a
// double-click, reaches it.

import { after } from "node:test";
import { ShowRegistry } from "../src/shows/registry.js";
import { EventHub } from "../src/api/hub.js";
import { db, migrate, closeDb } from "../src/db/pg.js";

after(async () => closeDb());

describe("the caps count what is STARTING, not only what has started", () => {
  /** An attach that will never settle — exactly the 45-second browser open
   *  the old check walked straight past. */
  const inFlight = () => new Promise<never>(() => {});

  const registry = async () => {
    await migrate(db());
    const reg = new ShowRegistry(new EventHub());
    return {
      reg,
      priv: reg as unknown as {
        attaching: Map<string, Promise<unknown>>;
        scrapedAttaching: Map<string, boolean>;
      },
    };
  };

  test("a room whose browser is still opening counts against MAX_SCRAPED_ROOMS", async () => {
    const { reg, priv } = await registry();
    for (let i = 0; i < config.maxScrapedRooms; i++) {
      priv.attaching.set(`whatnot_pending_${i}`, inFlight());
      priv.scrapedAttaching.set(`whatnot_pending_${i}`, true);
    }
    await assert.rejects(
      () => reg.attach("https://www.whatnot.com/live/abc123def"),
      /MAX_SCRAPED_ROOMS/,
      "the browser for the third room must be refused, not launched",
    );
  });

  test("an eBay Live show does not count against the scraped-room cap — it shares one Chromium", async () => {
    const { reg, priv } = await registry();
    const count = (reg as unknown as { scrapedRoomCount(): number }).scrapedRoomCount.bind(reg);
    for (let i = 0; i < config.maxScrapedRooms + 2; i++) {
      priv.attaching.set(`ebay_pending_${i}`, inFlight());
      priv.scrapedAttaching.set(`ebay_pending_${i}`, false);
    }
    assert.equal(count(), 0, "four eBay Live attaches are still one Chromium");
    priv.scrapedAttaching.set("whatnot_pending", true);
    priv.attaching.set("whatnot_pending", inFlight());
    assert.equal(count(), 1, "one Whatnot room is one whole browser");
  });

  test("attaches in flight count against MAX_WATCHED_SHOWS", async () => {
    const { reg, priv } = await registry();
    for (let i = 0; i < config.maxWatchedShows; i++) {
      priv.attaching.set(`pending_${i}`, inFlight());
      priv.scrapedAttaching.set(`pending_${i}`, false);
    }
    await assert.rejects(
      () => reg.attach("https://www.whatnot.com/live/zzz999aaa"),
      /MAX_WATCHED_SHOWS/,
    );
  });
});
