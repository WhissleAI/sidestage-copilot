// The set of shows this process is watching.
//
// One seeded demo show always exists (so the console has something to render
// with no network), plus any number of attached eBay Live shows. Each is an
// isolated ShowRuntime; the registry only owns their lifecycle and routes events
// to the SSE hub tagged with the show they came from.

import { config } from "../config.js";
import type { EventHub, EventName } from "../api/hub.js";
import { ShowRuntime } from "./runtime.js";
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
  status: "live" | "ended";
  viewers: number;
  listings: number;
  proposals: number;
}

export class ShowRegistry {
  private runtimes = new Map<string, ShowRuntime>();

  /**
   * The show a console sees when it does not name one.
   *
   * The operator console opens one SSE stream and does not pass a showId, so
   * something has to decide which show it is looking at. Rather than make the
   * console carry a switcher before it needs one, the server holds an ACTIVE
   * show that `POST /api/shows/:id/activate` moves.
   */
  private activeShowId: string = DEMO_SHOW_ID;

  constructor(private hub: EventHub) {}

  /** Fan a runtime's event out to consoles, tagged with its show. */
  private events = {
    emit: (showId: string, event: string, data: unknown) => {
      this.hub.emit(event as EventName, { showId, ...(data as object) });
    },
  };

  /** The seeded demo show. Uses the main database so `npm run seed` drives it. */
  async ensureDemo(): Promise<ShowRuntime> {
    const existing = this.runtimes.get(DEMO_SHOW_ID);
    if (existing) return existing;

    const rt = new ShowRuntime({
      showId: DEMO_SHOW_ID,
      title: "Friday Night Grails — Ep. 42",
      sellerHandle: "@kicksbyrae",
      source: "simulated",
      events: this.events,
      dbPath: config.dbPath,
    });
    this.runtimes.set(DEMO_SHOW_ID, rt);
    await rt.start();
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
      await rt.start();
    } catch (e) {
      this.runtimes.delete(showId);
      await rt.close().catch(() => {});
      throw e;
    }

    this.hub.emit("shows", this.list());
    return rt;
  }

  async detach(showId: string): Promise<void> {
    if (showId === DEMO_SHOW_ID) throw new Error("the demo show cannot be detached");
    const rt = this.runtimes.get(showId);
    if (!rt) return;
    this.runtimes.delete(showId);
    if (this.activeShowId === showId) this.activeShowId = DEMO_SHOW_ID;
    await rt.close().catch(() => {});
    this.hub.emit("shows", this.list());
  }

  get active(): string {
    return this.runtimes.has(this.activeShowId) ? this.activeShowId : DEMO_SHOW_ID;
  }

  activate(showId: string): ShowSummary {
    if (!this.runtimes.has(showId)) throw new Error(`show ${showId} is not being watched`);
    this.activeShowId = showId;
    this.hub.emit("shows", this.list());
    return this.list().find((s) => s.showId === showId)!;
  }

  get(showId?: string | null): ShowRuntime {
    const rt = this.runtimes.get(showId || this.active);
    if (!rt) throw new Error(`show ${showId} is not being watched`);
    return rt;
  }

  has(showId: string): boolean {
    return this.runtimes.has(showId);
  }

  list(): ShowSummary[] {
    return [...this.runtimes.values()].map((rt) => {
      const s = rt.show;
      return {
        showId: rt.showId,
        agentId: rt.agentId,
        catalogId: rt.catalogId,
        title: s.title,
        sellerHandle: s.sellerHandle,
        source: s.source,
        externalId: s.externalId,
        readOnly: s.readOnly,
        status: s.status,
        viewers: s.viewers,
        listings: rt.repo.listings().length,
        proposals: rt.pipeline.list().length,
      };
    });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((rt) => rt.close().catch(() => {})));
    this.runtimes.clear();
  }
}
