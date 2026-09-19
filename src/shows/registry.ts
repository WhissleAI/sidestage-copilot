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
  async ensureDemo(): Promise<ShowRuntime> {
    const existing = this.runtimes.get(DEMO_SHOW_ID);
    if (existing) return existing;

    const rt = new ShowRuntime({
      showId: DEMO_SHOW_ID,
      title: "Friday Night Grails — Ep. 42",
      sellerHandle: "@kicksbyrae",
      source: "simulated",
      events: this.events,
    });
    this.runtimes.set(DEMO_SHOW_ID, rt);
    await rt.init();
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

    // One event can be attached more than once over its life; each attach is
    // its own session with its own report. A live runtime for the event is
    // returned as-is; a session that ENDED is left alone, report or no report,
    // and the new one takes the next id (`sessionIdFor`).
    const live = [...this.runtimes.values()].find((r) => r.externalId === externalId);
    if (live) return live;
    // `ebay_` is history, not a convention: every eBay Live show id in
    // production carries it, and `nextSessionId` matches sessions by it. A
    // second surface gets its own prefix rather than renaming those rows.
    const base = adapter.id === "ebaylive" ? `ebay_${externalId}` : `${adapter.id}_${externalId}`;
    const showId = await this.nextSessionId(base, externalId);
    const inFlight = this.attaching.get(showId);
    if (inFlight) return inFlight;

    if (this.runtimes.size >= config.maxWatchedShows) {
      throw new Error(`already watching ${this.runtimes.size} shows (MAX_WATCHED_SHOWS=${config.maxWatchedShows})`);
    }

    const run = (async () => {
      const rt = new ShowRuntime({
        showId,
        title: meta.title || target.title || `${adapter.label} ${externalId}`,
        sellerHandle: meta.host || target.handle || "eBay Live seller",
        source: adapter.id,
        externalId,
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
    })().finally(() => this.attaching.delete(showId));
    this.attaching.set(showId, run);
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
   * The show a console lands on with no showId, or null when there is none.
   *
   * Falls forward to any other watched show rather than to a fixed id: after a
   * detach the operator is far more likely to want the show still on air than
   * an error about the one they just closed.
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

  get(showId?: string | null): ShowRuntime {
    const id = showId || this.active;
    // Two different failures, and the console renders them differently: no show
    // at all sends the operator to Shows to start one; a show it cannot find is
    // a stale link.
    if (!id) throw new Error("no show is being monitored — paste an eBay Live link on Shows to start one");
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error(`show ${id} is not being watched`);
    return rt;
  }

  has(showId: string): boolean {
    return this.runtimes.has(showId);
  }

  /** The id for a new session of this event. See `sessionIdFor`. */
  private async nextSessionId(base: string, eventId: string): Promise<string> {
    return nextSessionId(db(), base, eventId);
  }

  /** The account's newest live show, or none when it has none. */
  activeFor(ownerId: string | null | undefined): string | undefined {
    if (!ownerId) return undefined;
    // Rows older than ownership belong to nobody and stay visible to everyone;
    // every show attached since has exactly one owner.
    const mine = [...this.runtimes.values()].filter((rt) => rt.ownerAccountId === ownerId || rt.ownerAccountId === null);
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
  rows: { id: string; status: string }[],
): string {
  if (!rows.length) return base;
  // A resume, not a new session. Nothing else about a live row is reusable.
  const live = rows.find((r) => r.status === "live");
  if (live) return live.id;
  const taken = new Set(rows.map((r) => r.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** `sessionIdFor` over the rows this event already has. A read that fails
 *  yields the base id rather than blocking the attach. */
export async function nextSessionId(d: Pool, base: string, eventId: string): Promise<string> {
  const rows = await d
    .query<{ id: string; status: string }>(
      "SELECT id, status FROM shows WHERE external_id = $1 ORDER BY started_at DESC",
      [eventId],
    )
    .then((r) => r.rows)
    .catch(() => [] as { id: string; status: string }[]);
  return sessionIdFor(base, rows);
}
