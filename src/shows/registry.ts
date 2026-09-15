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
import type { EventHub, EventName } from "../api/hub.js";
import { ShowRuntime } from "./runtime.js";
import type { ShowReport } from "./sessionRecord.js";
import { parseEventId } from "../ingest/ebaylive/discovery.js";

export const DEMO_SHOW_ID = "show_ep42";

export interface ShowSummary {
  showId: string;
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
  async attachEbayLive(input: string, meta: { title?: string; host?: string } = {}): Promise<ShowRuntime> {
    const eventId = parseEventId(input);
    if (!eventId) throw new Error(`could not read an eBay Live event id out of "${input}"`);

    const showId = `ebay_${eventId}`;
    const existing = this.runtimes.get(showId);
    if (existing) return existing;

    if (this.runtimes.size > config.maxWatchedShows) {
      throw new Error(`already watching ${this.runtimes.size} shows (MAX_WATCHED_SHOWS=${config.maxWatchedShows})`);
    }

    const rt = new ShowRuntime({
      showId,
      title: meta.title || `eBay Live ${eventId}`,
      sellerHandle: meta.host || "eBay Live seller",
      source: "ebaylive",
      externalId: eventId,
      readOnly: true,
      events: this.events,
    });
    this.runtimes.set(showId, rt);

    try {
      await rt.init();
    await rt.start();
    } catch (e) {
      this.runtimes.delete(showId);
      await rt.close().catch(() => {});
      throw e;
    }

    this.hub.emit("shows", await this.list());
    return rt;
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

  async list(): Promise<ShowSummary[]> {
    return Promise.all([...this.runtimes.values()].map(async (rt) => {
      const [s, listings] = await Promise.all([rt.show(), rt.repo.listings()]);
      return {
        showId: rt.showId,
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
