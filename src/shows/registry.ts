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
import { db } from "../db/pg.js";
import type { EventHub, EventName } from "../api/hub.js";
import { ShowRuntime } from "./runtime.js";
import type { ShowReport } from "./sessionRecord.js";
import { parseEventId } from "../ingest/ebaylive/discovery.js";

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
  source: "simulated" | "ebaylive";
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
   * Attach to a real eBay Live show. Accepts an event id or any show URL.
   * The show is READ-ONLY: we hold no seller credentials for someone else's
   * stream, so every write action is refused at preflight (docs/TDD.md §8).
   */
  /** Attaches in flight, so two callers for one show share one runtime
   *  instead of the second getting a half-built one out of the map. */
  private attaching = new Map<string, Promise<ShowRuntime>>();

  async attachEbayLive(
    input: string,
    meta: { title?: string; host?: string; ownerAccountId?: string | null; readOnly?: boolean } = {},
  ): Promise<ShowRuntime> {
    const eventId = parseEventId(input);
    if (!eventId) throw new Error(`could not read an eBay Live event id out of "${input}"`);

    // One event can be attached more than once over its life; each attach is
    // its own session with its own report. A live runtime for the event is
    // returned as-is; a finished session that already has a report is left
    // alone and the new one takes the next id. Re-attaching used to reuse the
    // row, reset its clock and overwrite the report.
    const live = [...this.runtimes.values()].find((r) => r.externalId === eventId);
    if (live) return live;
    const base = `ebay_${eventId}`;
    const showId = await this.nextSessionId(base, eventId);
    const inFlight = this.attaching.get(showId);
    if (inFlight) return inFlight;

    if (this.runtimes.size >= config.maxWatchedShows) {
      throw new Error(`already watching ${this.runtimes.size} shows (MAX_WATCHED_SHOWS=${config.maxWatchedShows})`);
    }

    const run = (async () => {
      const rt = new ShowRuntime({
        showId,
        title: meta.title || `eBay Live ${eventId}`,
        sellerHandle: meta.host || "eBay Live seller",
        source: "ebaylive",
        externalId: eventId,
        // Read-only unless the caller proved the show is theirs (routes match
        // the connected eBay username to the show's seller handle).
        readOnly: meta.readOnly ?? true,
        ownerAccountId: meta.ownerAccountId ?? null,
        events: this.events,
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

  async detach(showId: string): Promise<ShowReport | null> {
    const rt = this.runtimes.get(showId);
    if (!rt) return null;
    // The report is built BEFORE teardown, while the show row still says what
    // it was, and returned so the console can show it instead of dropping the
    // operator back to an empty launcher with nothing to read.
    const report = await rt.finishSession();
    this.runtimes.delete(showId);
    if (this.activeShowId === showId) this.activeShowId = null;
    await rt.close().catch(() => {});
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

  /** The id for a new session of this event: the base id if unused or reusable
   *  (ended, no report), else base-2, base-3, … */
  private async nextSessionId(base: string, eventId: string): Promise<string> {
    const rows = await db()
      .query<{ id: string; status: string; has_report: boolean }>(
        `SELECT s.id, s.status, (r.show_id IS NOT NULL) AS has_report
           FROM shows s LEFT JOIN show_reports r ON r.show_id = s.id
          WHERE s.external_id = $1 ORDER BY s.started_at DESC`,
        [eventId],
      )
      .then((r) => r.rows)
      .catch(() => [] as { id: string; status: string; has_report: boolean }[]);
    if (!rows.length) return base;
    const reusable = rows.find((r) => !r.has_report);
    if (reusable) return reusable.id;
    const taken = new Set(rows.map((r) => r.id));
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  /** The account's newest live show, or none when it has none. */
  activeFor(ownerId: string | null | undefined): string | undefined {
    if (!ownerId) return undefined;
    // Rows older than ownership belong to nobody and stay visible to everyone;
    // every show attached since has exactly one owner.
    const mine = [...this.runtimes.values()].filter((rt) => rt.ownerAccountId === ownerId || rt.ownerAccountId === null);
    return mine.length ? mine[mine.length - 1]!.showId : undefined;
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
        awaiting: rt.pipeline.list().filter((p) => p.status === "ready" || p.status === "needs_review").length,
        blocked: rt.pipeline.list().filter((p) => p.status === "blocked").length,
      };
    }));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((rt) => rt.close().catch(() => {})));
    this.runtimes.clear();
  }
}
