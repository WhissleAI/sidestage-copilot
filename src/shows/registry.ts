// The set of shows this process is watching.
//
// Any number of attached eBay Live shows, each an isolated ShowRuntime. The
// registry owns their lifecycle and routes events to the SSE hub tagged with
// the show they came from.
//
// There used to be a seeded demo show here that the server created on every
// boot and refused to delete, so the console always had something to render.
// What it rendered was a scripted animation: simulated buyers, simulated lots,
// a reply queue that filled whether or not anything was connected. A product
// whose empty state is a fake show cannot tell you it is not working — and the
// operator could not get rid of it. It is now opt-in (`DEMO_SHOW=1`, or
// `ensureDemo()` from a test), and when nothing is being watched the answer is
// that nothing is being watched.

import { config } from "../config.js";
import { db, type Pool } from "../db/pg.js";
import type { EventHub, EventName } from "../api/hub.js";
import type { SellerGuardrailPolicy } from "../guardrails/policy.js";
import type { Persona } from "../persona/store.js";
import type { Fact } from "../retrieval/facts.js";
import { ShowRuntime } from "./runtime.js";
import { describeFrames } from "./frameDescriber.js";
import { generateSessionFollowUps, type DrafterOpener } from "./sessionFollowups.js";
import type { ShowReport } from "./sessionRecord.js";
import { resolve as resolveSurface } from "../surfaces/registry.js";
import { isWaiting } from "../api/drafts.js";
import type { SurfaceId } from "../surfaces/types.js";
import { ownsABrowser } from "../surfaces/types.js";

export const DEMO_SHOW_ID = "show_ep42";

export interface ShowSummary {
  showId: string;
  /** Whose show this is. Null for rows older than ownership. */
  ownerAccountId: string | null;
  /** The Whissle agent answering for this show — one per catalog. */
  agentId: string;
  catalogId: string | null;
  title: string;
  sellerHandle: string;
  source: SurfaceId;
  externalId: string | null;
  readOnly: boolean;
  /** Where this show's approved writes actually land. Never inferred by a
   *  client: an operator must be told, not left to work it out. */
  writeTarget: "mock" | "ebay";
  status: "live" | "ended";
  /** When the show went on air. The live strip on every non-console screen
   *  counts from this, so it cannot be derived client-side. */
  startedAt: string;
  viewers: number;
  listings: number;
  proposals: number;
  /** What is waiting for the operator right now — so a screen that is not the
   *  console can still say "2 awaiting · 1 blocked". */
  awaiting: number;
  blocked: number;
}

/**
 * Nobody is watching anything — which is the console's RESTING state, not a
 * failure of it.
 *
 * A plain Error here made the SSE route emit `stream_error`, so the console
 * rendered its failed branch: a red panel, a warning triangle, "That did not
 * load." and a Reload button, for the ordinary situation of being between
 * shows. Console.tsx already draws absent and failed differently and says so
 * in a comment; it was being handed the wrong one. A type is what lets the
 * route tell them apart without matching on a sentence.
 */
export class NoShowMonitored extends Error {
  constructor() {
    super("no show is being monitored — paste a live link on Home to start one");
    this.name = "NoShowMonitored";
  }
}

export class ShowRegistry {
  private runtimes = new Map<string, ShowRuntime>();

  /**
   * The show a console sees when it does not name one.
   *
   * The operator console opens one SSE stream and does not pass a showId, so
   * something has to decide which show it is looking at. Rather than make the
   * console carry a switcher before it needs one, the server holds an ACTIVE
   * show that `POST /api/shows/:id/activate` moves. Null when nothing is being
   * watched — which is a real state now that there is no demo show standing in
   * for one.
   */
  private activeShowId: string | null = null;

  constructor(private hub: EventHub) {}

  /** Set by the API layer: the merged guard settings for one account. */
  policyFor: ((accountId: string) => Promise<SellerGuardrailPolicy>) | null = null;

  /** Set by the API layer: one account's persona and voice corpus. Null until
   *  it is, so a runtime started before the routes are registered composes the
   *  way it always did rather than failing. */
  personaFor: ((accountId: string) => Promise<{ persona: Persona; voice: Fact[] } | null>) | null = null;

  /** Fan a runtime's event out to consoles, tagged with its show. */
  private events = {
    emit: (showId: string, event: string, data: unknown) => {
      this.hub.emit(event as EventName, { showId, ...(data as object) });
    },
  };

  /**
   * The seeded, simulated show.
   *
   * Opt-in: the test suite calls it directly, and `DEMO_SHOW=1` brings it back
   * for anyone who wants the scripted walkthrough. The server does not create
   * one on boot — a fake show is the worst possible empty state, because it
   * looks exactly like a working one.
   */
  async ensureDemo(ownerAccountId: string | null = null): Promise<ShowRuntime> {
    const existing = this.runtimes.get(DEMO_SHOW_ID);
    if (existing) return existing;

    const rt = new ShowRuntime({
      showId: DEMO_SHOW_ID,
      title: "Friday Night Grails — Ep. 42",
      sellerHandle: "@kicksbyrae",
      source: "simulated",
      ownerAccountId,
      events: this.events,
    });
    this.runtimes.set(DEMO_SHOW_ID, rt);
    await rt.init();
    // The row outlives the process, so a demo row written before this argument
    // existed — or by a previous run under a different account — keeps its old
    // owner unless we say otherwise. An owned demo is the only kind that can be
    // driven now that an ownerless show refuses writes.
    if (ownerAccountId) {
      await db().query("UPDATE shows SET owner_account_id = $2 WHERE id = $1", [DEMO_SHOW_ID, ownerAccountId]);
      await rt.loadOwner();
    }
    await rt.start();
    if (!this.activeShowId) this.activeShowId = DEMO_SHOW_ID;
    return rt;
  }

  /**
   * Attach to a conversation. Accepts anything a registered surface recognises:
   * an eBay Live event id or show URL today, a channel or a thread once their
   * adapters land (docs/SURFACES.md).
   *
   * A show we do not own is READ-ONLY: we hold no seller credentials for
   * someone else's stream, so every write action is refused at preflight
   * (docs/TDD.md §8).
   */
  /** Attaches in flight, so two callers for one show share one runtime
   *  instead of the second getting a half-built one out of the map. */
  private attaching = new Map<string, Promise<ShowRuntime>>();
  /** Of those in flight, which need a browser of their own. Kept beside
   *  `attaching` rather than derived, because the adapter is not recoverable
   *  from a show id once the attach has been handed out. */
  private scrapedAttaching = new Map<string, boolean>();

  /** Watched rooms that cost a WHOLE Chrome each — started and starting. */
  private scrapedRoomCount(): number {
    let n = 0;
    for (const rt of this.runtimes.values()) if (ownsABrowser(rt.surface)) n++;
    for (const owns of this.scrapedAttaching.values()) if (owns) n++;
    return n;
  }

  async attach(
    input: string,
    meta: { title?: string; host?: string; ownerAccountId?: string | null; readOnly?: boolean } = {},
  ): Promise<ShowRuntime> {
    const resolved = resolveSurface(input);
    // Worded for eBay Live on purpose, and not widened yet: it is the only
    // surface an operator can paste a link for in this build, so a message
    // offering alternatives would be offering things that do not exist.
    if (!resolved) throw new Error(`could not read an eBay Live event id out of "${input}"`);
    const { adapter, target } = resolved;
    const externalId = target.externalId;

    // WHOSE session, on WHICH surface, watching WHICH id. All three, because
    // an external id is not an identity.
    //
    // `kicksbyrae` is a Twitch login and a Whatnot handle and a TikTok handle,
    // and matching on the id alone handed the second operator to paste one the
    // first operator's RUNNING session — whereupon the attach route minted an
    // agent onto it and applied a catalog to somebody else's live show. That is
    // a cross-tenant takeover of a session in flight, not a stale read, and the
    // fix is structural: a runtime is identified by the surface plus the id
    // plus the account, so a match across either boundary is not expressible.
    //
    // A row from before ownership belongs to nobody (`null`) and still matches
    // an attach that names no owner, which is what the resume path and the
    // `WATCH_EBAY` boot list do.
    const owner = meta.ownerAccountId ?? null;
    // One event can be attached more than once over its life; each attach is
    // its own session with its own report. A live runtime for the event is
    // returned as-is; a session that ENDED is left alone, report or no report,
    // and the new one takes the next id (`sessionIdFor`). The lookup is keyed
    // on SURFACE and OWNER as well as the external id: two surfaces share a
    // handle, so matching on the id alone handed you somebody else's running
    // session and then replaced their agent.
    const live = [...this.runtimes.values()].find(
      (r) => r.surface === adapter.id && r.externalId === externalId && r.ownerAccountId === owner,
    );
    if (live) return live;
    // `ebay_` is history, not a convention: every eBay Live show id in
    // production carries it, and `nextSessionId` matches sessions by it. A
    // second surface gets its own prefix rather than renaming those rows.
    const base = adapter.id === "ebaylive" ? `ebay_${externalId}` : `${adapter.id}_${externalId}`;
    const showId = await this.nextSessionId(base, externalId, adapter.id, owner);
    const inFlight = this.attaching.get(showId);
    if (inFlight) return inFlight;

    // Both caps count what is STARTING as well as what has started.
    //
    // `runtimes` is populated only after `rt.start()` RESOLVES, and for a
    // scraped surface that is a browser launch plus up to 45 s on `page.goto`
    // and 30 s on `waitForSelector`. So N concurrent attaches for N distinct
    // rooms — a console firing one per Discover card, or a double-click — all
    // observed `runtimes.size === 0`, all passed, and all launched a browser.
    // The cap was a check against a map that is filled in after the expensive
    // thing has already happened.
    const watching = this.runtimes.size + this.attaching.size;
    if (watching >= config.maxWatchedShows) {
      throw new Error(`already watching ${watching} shows (MAX_WATCHED_SHOWS=${config.maxWatchedShows})`);
    }
    // A session is not a browser. Six sessions is a sensible number of
    // sessions; six WHATNOT sessions is six real Chromes on a box whose
    // container limit holds Node and every browser together, and the
    // container OOMs long before the box does — so the app dies rather than
    // degrades, taking every other watched show with it.
    if (ownsABrowser(adapter.id)) {
      const rooms = this.scrapedRoomCount();
      if (rooms >= config.maxScrapedRooms) {
        throw new Error(
          `already watching ${rooms} ${rooms === 1 ? "room" : "rooms"} on a surface that needs its own browser ` +
          `(MAX_SCRAPED_ROOMS=${config.maxScrapedRooms}). Stop one before attaching another.`,
        );
      }
    }

    const run = (async () => {
      const rt = new ShowRuntime({
        showId,
        title: meta.title || target.title || `${adapter.label} ${externalId}`,
        // The surface names its own placeholder. A Whatnot room whose host we
        // could not read used to be labelled "eBay Live seller" in the console
        // header, which tells the operator the wrong thing about where they
        // are — and `isPlaceholderHandle` in api/drafts.ts only knew the eBay
        // spelling, so any other surface's placeholder read as a real name.
        sellerHandle: meta.host || target.handle || `${adapter.label} seller`,
        source: adapter.id,
        externalId,
        // The WHOLE target, not the one string of it that an eBay Live event
        // happens to be. Everything an async surface knows — which thread,
        // whose profile, which room's rules are in force — is in `meta`, and
        // this layer used to drop it on the floor between `parseTarget` and
        // `adapter.open`.
        target,
        // Read-only unless the caller proved the show is theirs (routes match
        // the connected eBay username to the show's seller handle).
        readOnly: meta.readOnly ?? true,
        ownerAccountId: meta.ownerAccountId ?? null,
        events: this.events,
        policyFor: meta.ownerAccountId && this.policyFor
          ? (() => this.policyFor!(meta.ownerAccountId!))
          : undefined,
        personaFor: meta.ownerAccountId && this.personaFor
          ? (() => this.personaFor!(meta.ownerAccountId!))
          : undefined,
        // The feed went silent for a quarter of an hour: finish the session
        // the way a detach would, report and all, and free the slot.
        onEnded: (id, why) => {
          console.log(`  ${id}: ${why} — finishing session`);
          void this.detach(id).catch((e) => console.warn(`  ${id}: finish after end failed — ${(e as Error).message}`));
        },
      });
      try {
        await rt.init();
        await rt.loadOwner();
        await rt.start();
      } catch (e) {
        await rt.close().catch(() => {});
        throw e;
      }
      // Only a runtime that started is a runtime anyone may be handed.
      this.runtimes.set(showId, rt);
      this.hub.emit("shows", await this.list());
      return rt;
    })();
    // Registered in the SAME synchronous turn as the cap check above — the
    // async body has only run as far as its first `await` — so the next caller
    // counts this attach whether or not its browser has finished opening.
    this.attaching.set(showId, run);
    this.scrapedAttaching.set(showId, ownsABrowser(adapter.id));
    void run.catch(() => undefined).finally(() => {
      this.attaching.delete(showId);
      this.scrapedAttaching.delete(showId);
    });
    return run;
  }

  /**
   * The name every caller of this has used since before surfaces existed.
   *
   * Kept as an alias rather than renamed at the call sites: the signature is
   * the contract the attach route, the resume path and the console all hold,
   * and a rename buys nothing an alias does not.
   */
  async attachEbayLive(
    input: string,
    meta: { title?: string; host?: string; ownerAccountId?: string | null; readOnly?: boolean } = {},
  ): Promise<ShowRuntime> {
    return this.attach(input, meta);
  }

  /**
   * How a finished session gets a drafter for its follow-ups.
   *
   * The same seam as `policyFor` and `personaFor`: the default is the real
   * thing — a replay runtime over the session's own catalog, voice and guards —
   * and it is replaceable so the rest of the session-end path can be exercised
   * without a gateway.
   */
  drafterFor: DrafterOpener | undefined;

  /**
   * Background work a detach started but does not wait for.
   *
   * Kept so a shutdown can let it finish rather than killing a report's frame
   * descriptions or a seller's follow-ups halfway through.
   */
  private background = new Set<Promise<unknown>>();

  private inBackground(p: Promise<unknown>): void {
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }

  /** Wait for everything a detach left running. */
  async settle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  async detach(showId: string): Promise<ShowReport | null> {
    const rt = this.runtimes.get(showId);
    if (!rt) return null;
    // The report is built BEFORE teardown, while the show row still says what
    // it was, and returned so the console can show it instead of dropping the
    // operator back to an empty launcher with nothing to read.
    const report = await rt.finishSession();
    // The timeline's fuller frame readings, in the background, with the
    // show's own agent while it still exists. Never delays the detach.
    this.inBackground(
      describeFrames(showId, rt.signals, rt.llm)
        .then((r) => { if (r.described) console.log(`  ${showId}: described ${r.described} frames for the timeline`); })
        .catch((e) => console.warn(`  ${showId}: frame descriptions failed — ${(e as Error).message}`)),
    );
    this.runtimes.delete(showId);
    if (this.activeShowId === showId) this.activeShowId = null;
    await rt.close().catch(() => {});
    // The people who asked and did not buy. Same contract as the frame
    // descriptions — background, never delaying the detach — and started after
    // the runtime is out of the map so the drafter is a replay over the
    // finished session rather than a pipeline that is being torn down.
    //
    // Until now nothing called `buildFollowUps` at all: its only caller was a
    // route no client ever hit, so the inbox was permanently empty while the
    // home page promised it held one written reply per person who asked.
    this.inBackground(
      generateSessionFollowUps(db(), showId, this.drafterFor ? { open: this.drafterFor } : {})
        .then((r) => {
          if (!r) return console.log(`  ${showId}: no owner, so no inbox to file follow-ups into`);
          console.log(
            `  ${showId}: ${r.drafted} follow-up(s) from ${r.selected} buyer(s)` +
            `${r.unreached ? ` — ${r.unreached} NOT reached, past this job's bound` : ""}` +
            `${r.guardedOut ? `, ${r.guardedOut} blocked by a guard` : ""}` +
            `${r.abstained ? `, ${r.abstained} with nothing to say` : ""}`,
          );
        })
        // Loud, and named as the thing it is. A follow-up that silently does
        // not exist is exactly the failure this path was added to fix.
        .catch((e) => console.warn(`  ${showId}: FOLLOW-UPS FAILED — ${(e as Error).message}`)),
    );
    this.hub.emit("shows", await this.list());
    return report;
  }

  /**
   * The last show attached or activated in THIS PROCESS, or null.
   *
   * Process-global and therefore NOT an answer to "which show is the caller
   * asking about" — it was, and that was a cross-tenant read: a signed-in
   * seller with no show of their own read whichever show the box happened to
   * be running, because `get()` fell back to it. Nothing account-facing may
   * use this. `activeFor(ownerId)` is the account-scoped question, and it is
   * the only one the API layer is allowed to ask.
   *
   * What is left for it: the registry's own bookkeeping (a detach clears it),
   * and `POST /api/shows/:id/activate`, which is already ownership-checked.
   */
  get active(): string | null {
    if (this.activeShowId && this.runtimes.has(this.activeShowId)) return this.activeShowId;
    return this.runtimes.keys().next().value ?? null;
  }

  async activate(showId: string): Promise<ShowSummary> {
    if (!this.runtimes.has(showId)) throw new Error(`show ${showId} is not being watched`);
    this.activeShowId = showId;
    const shows = await this.list();
    this.hub.emit("shows", shows);
    return shows.find((s) => s.showId === showId)!;
  }

  /**
   * The runtime for a show, named explicitly.
   *
   * The id is REQUIRED. It used to be optional and fell back to `this.active`,
   * which is what made every unscoped read serve whichever show was attached
   * last on the whole box. There is no "the" show any more: a caller who has
   * not named one is asking about an account, and that question is
   * `activeFor`.
   */
  get(showId: string): ShowRuntime {
    // Two different failures, and the console renders them differently: no show
    // at all sends the operator to Shows to start one; a show it cannot find is
    // a stale link.
    if (!showId) throw new NoShowMonitored();
    const rt = this.runtimes.get(showId);
    if (!rt) throw new Error(`show ${showId} is not being watched`);
    return rt;
  }

  has(showId: string): boolean {
    return this.runtimes.has(showId);
  }

  /** The id for a new session of this event. See `sessionIdFor`. */
  private async nextSessionId(
    base: string,
    eventId: string,
    surface: SurfaceId,
    owner: string | null,
  ): Promise<string> {
    return nextSessionId(db(), base, eventId, surface, owner);
  }

  /**
   * The account's newest live show, or none when it has none.
   *
   * `includeOwnerless` is the legacy allowance, and it is off for anything
   * that writes. Rows older than ownership belong to nobody and stay VISIBLE
   * to everyone — a seller must not lose their own history to a column that
   * did not exist when the row was written — but "nobody's" cannot mean
   * "anybody may drive it", and with no showId to check the ownership
   * preHandler never sees the question. So the answer is given here instead:
   * a caller who is about to change something is only ever handed a show that
   * is theirs.
   */
  activeFor(ownerId: string | null | undefined, opts: { includeOwnerless?: boolean } = {}): string | undefined {
    if (!ownerId) return undefined;
    const ownerless = opts.includeOwnerless ?? true;
    const mine = [...this.runtimes.values()].filter(
      (rt) => rt.ownerAccountId === ownerId || (ownerless && rt.ownerAccountId === null),
    );
    return mine.length ? mine[mine.length - 1]!.showId : undefined;
  }

  /**
   * Is a session open on this surface right now, in this process?
   *
   * Synchronous and free, unlike `list()`, which reads every runtime's show row
   * and its listings. The Reddit rate budget asks this on the discovery path —
   * "is somebody watching a room whose headroom I would be spending" — and a
   * question asked to AVOID work must not cost a round trip per runtime.
   */
  anyLiveOn(surface: SurfaceId): boolean {
    return [...this.runtimes.values()].some((rt) => rt.surface === surface);
  }

  /** Every watched show, or only one account's. A show is one account's or
   *  nobody's; there is no shared show. */
  async list(ownerId?: string | null): Promise<ShowSummary[]> {
    const mine = [...this.runtimes.values()].filter(
      (rt) => ownerId === undefined || rt.ownerAccountId === ownerId || rt.ownerAccountId === null,
    );
    return Promise.all(mine.map(async (rt) => {
      const [s, listings] = await Promise.all([rt.show(), rt.repo.listings()]);
      return {
        showId: rt.showId,
        ownerAccountId: rt.ownerAccountId,
        agentId: rt.agentId,
        catalogId: rt.catalogId,
        title: s.title,
        sellerHandle: s.sellerHandle,
        source: s.source,
        externalId: s.externalId,
        readOnly: s.readOnly,
        writeTarget: rt.writeTarget,
        status: s.status,
        startedAt: s.startedAt,
        viewers: s.viewers,
        listings: listings.length,
        proposals: rt.pipeline.list().length,
        // One definition of "waiting on a human", shared with the drafts queue
        // (src/api/drafts.ts). Home's count and the Drafts page's list are the
        // same number because they ask the same function, not because two
        // places list the same two statuses.
        awaiting: rt.pipeline.list().filter(isWaiting).length,
        blocked: rt.pipeline.list().filter((p) => p.status === "blocked").length,
      };
    }));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((rt) => rt.close().catch(() => {})));
    this.runtimes.clear();
    // A shutdown that killed a half-written inbox would leave a seller with
    // some of their follow-ups, which is worse than none: they cannot tell.
    await this.settle();
  }
}

/**
 * Which id a new session of this event takes.
 *
 * A row is reused only when it is still LIVE, which is the one case that is not
 * a new session at all: a resume after a restart, reconnecting to a show that
 * never stopped. Everything else gets the next id — `base-2`, `base-3`, …
 *
 * It used to reuse any row with no REPORT, and that is a different question
 * with a much worse answer. `show_id` is overloaded: it is both "this event"
 * and "this session of this event", and making report generation the thing that
 * tells them apart made a downstream artefact load-bearing for identity. A
 * report that failed to build — a gateway timeout, a schema drift — therefore
 * handed the dead session's id to the NEXT attach of the same event, and
 * everything keyed on `show_id` merged: chat, proposals, the audit chain, the
 * signals, the sales. The "ended, no report" row an operator had just been told
 * to go and look at silently went back on air, the eventual report counted the
 * previous session's comments and blocks as its own, and the old utterances and
 * frames landed at negative offsets on the new session's timeline.
 *
 * Cross-account it was worse: `ShowRuntime.init` puts a reused row back to
 * `live` and resets its clock but never rewrites `owner_account_id`, so a
 * second account re-attaching an event kept the first account's ownership —
 * B's session answered 404 to B's own report route and the finished report
 * belonged to A, while `show_costs.account_id` was written as B.
 *
 * Exported as a rule over rows, separately from the read, so it can be argued
 * with in a test without a database, a browser or an event that exists.
 */
export function sessionIdFor(
  base: string,
  rows: { id: string; status: string; surface?: string | null; owner_account_id?: string | null }[],
  surface?: SurfaceId,
  owner?: string | null,
): string {
  if (!rows.length) return base;
  // A resume, not a new session. Two conditions, from two different defects.
  //
  // LIVE, because a session that ended is never reused: reuse used to key on
  // "has no report", so a session whose report FAILED had its row picked up by
  // the next attach and two sessions' chat, proposals and audit merged.
  //
  // Same SURFACE and same OWNER, because two surfaces share a handle and
  // picking up somebody else's ended row resumes their session under our
  // attach — the durable half of the live takeover the lookup above prevents.
  //
  // Ids that are merely TAKEN are still counted across every row on the id,
  // whoever owns it: the id is a primary key and a collision is a failed insert.
  const live = rows.find(
    (r) =>
      r.status === "live" &&
      (surface === undefined || (r.surface ?? null) === surface) &&
      (owner === undefined || (r.owner_account_id ?? null) === (owner ?? null)),
  );
  if (live) return live.id;
  const taken = new Set(rows.map((r) => r.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** `sessionIdFor` over the rows this event already has. A read that fails
 *  yields the base id rather than blocking the attach. */
export async function nextSessionId(
  d: Pool,
  base: string,
  eventId: string,
  surface?: SurfaceId,
  owner?: string | null,
): Promise<string> {
  type Row = { id: string; status: string; surface: string | null; owner_account_id: string | null };
  const rows = await d
    .query<Row>(
      `SELECT id, status, COALESCE(surface, source) AS surface, owner_account_id
         FROM shows WHERE external_id = $1 ORDER BY started_at DESC`,
      [eventId],
    )
    .then((r) => r.rows)
    .catch(() => [] as Row[]);
  return sessionIdFor(base, rows, surface, owner);
}
