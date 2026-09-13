// One watched show = one ShowRuntime.
//
// A runtime owns its OWN SQLite file (data/shows/<showId>.db) and its own
// pipeline, retriever, executor and audit chain. That is the tenancy boundary:
// there are no cross-show queries, attaching a third show cannot slow or corrupt
// the two already running, and a show that ends can be dropped by closing one
// handle.
//
// The alternative — a `show_id` column on every table — would have meant every
// query in the system remembering to filter, and one missed filter leaking
// another seller's catalog into a reply.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { openDb, type DB } from "../db/index.js";
import { Repo } from "../domain/repo.js";
import { Retriever } from "../retrieval/retriever.js";
import { AuditLog } from "../actions/audit.js";
import { ActionExecutor } from "../actions/executor.js";
import { ActionProposer } from "../actions/proposer.js";
import { MockMarketplace } from "../actions/marketplace/mock.js";
import type { RemoteListing } from "../actions/marketplace/port.js";
import { ResearchService } from "../research/research.js";
import { ShowContextEngine } from "../ingest/showContext.js";
import { Pipeline } from "../pipeline/pipeline.js";
import { WhissleClient } from "../llm/whissle.js";
import type { AutonomyLevel, ShowState } from "../domain/types.js";
import { EbayLiveWatcher } from "../ingest/ebaylive/watcher.js";
import { SimulatedShowSource, ScriptedHostAudio, type ChatSource } from "../ingest/sources.js";

export interface RuntimeEvents {
  emit(showId: string, event: string, data: unknown): void;
}

export interface ShowRuntimeOpts {
  showId: string;
  title: string;
  sellerHandle: string;
  source: "simulated" | "ebaylive";
  externalId?: string | null;
  readOnly?: boolean;
  events: RuntimeEvents;
  /** Use this database instead of a per-show file (the seeded demo show). */
  dbPath?: string;
}

export class ShowRuntime {
  readonly showId: string;
  readonly db: DB;
  readonly repo: Repo;
  readonly retriever: Retriever;
  readonly audit: AuditLog;
  readonly executor: ActionExecutor;
  readonly proposer: ActionProposer;
  readonly research: ResearchService;
  readonly showContext: ShowContextEngine;
  readonly pipeline: Pipeline;
  readonly market: MockMarketplace;

  /**
   * This show's OWN client. Each catalog owns a Whissle agent, so two sellers
   * monitored at once talk to two agents with two knowledge bases and cannot
   * retrieve each other's inventory. Until a catalog is loaded it falls back to
   * WHISSLE_AGENT_ID, which is what the seeded demo show uses.
   */
  readonly llm: WhissleClient;

  /** Set when a catalog is applied. Feeds the composer so replies carry the
   *  seller's identity and voice, not a generic one. */
  seller: { handle: string; name: string; about: string; voice: string } | null = null;
  /** The catalog currently loaded into this show. */
  catalogId: string | null = null;

  private watcher: EbayLiveWatcher | null = null;
  private simSource: ChatSource | null = null;
  private hostAudio: ScriptedHostAudio | null = null;
  private started = false;

  constructor(private o: ShowRuntimeOpts) {
    this.showId = o.showId;
    this.llm = new WhissleClient({
      apiKey: config.whissle.apiKey,
      agentId: config.whissle.agentId,
      baseUrl: config.whissle.base,
      timeoutMs: Math.max(4000, config.latencyBudgetMs * 3),
      // Tags every gateway call this show makes, which is the only per-show
      // cost attribution available — the platform's own usage rows carry no
      // agent_id for text (see llm/meter.ts).
      showId: o.showId,
    });

    const path = o.dbPath ?? join(config.showsDir, `${o.showId}.db`);
    mkdirSync(config.showsDir, { recursive: true });
    this.db = openDb(path);
    this.repo = new Repo(this.db);

    // A per-show database starts empty; the demo show arrives pre-seeded.
    let show: ShowState;
    try {
      show = this.repo.show();
    } catch {
      show = this.repo.createShow({
        id: o.showId,
        title: o.title,
        sellerHandle: o.sellerHandle,
        source: o.source,
        externalId: o.externalId ?? null,
        readOnly: o.readOnly ?? false,
        autonomyLevel: config.autonomyDefault,
        undoWindowS: config.undoWindowS,
      });
    }

    this.retriever = new Retriever(this.repo);
    this.audit = new AuditLog(this.db);

    const remote: RemoteListing[] = this.repo.listings().map((l) => ({
      id: l.id, priceCents: l.priceCents, qty: l.qty, state: l.state, pinned: l.pinned, version: l.version,
    }));
    this.market = new MockMarketplace(remote);

    const emit = (event: string, data: unknown) => o.events.emit(this.showId, event, data);

    this.executor = new ActionExecutor(this.db, this.repo, this.market, this.audit, {
      undoWindowS: show.undoWindowS,
      onChange: (a) => {
        emit("action", a);
        emit("audit", this.audit.list(1)[0]);
      },
      onListingWrite: (id) => {
        this.retriever.rebuild();
        // Emit the listing that changed, plus whatever is pinned (a swap moves
        // the pin off another row). Re-emitting the whole catalog on every write
        // put 315 listing frames on the wire in 30 seconds against a live show.
        const changed = this.repo.listing(id);
        if (changed) emit("listing", changed);
        const pinned = this.repo.pinned();
        if (pinned && pinned.id !== id) emit("listing", pinned);
      },
    });

    this.proposer = new ActionProposer(this.repo);
    this.research = new ResearchService(this.repo);

    this.showContext = new ShowContextEngine({
      llm: this.llm,
      lotTitles: () => this.repo.listings().map((l) => ({ id: l.id, title: `${l.title} size ${l.size}` })),
      onUpdate: (c) => emit("context", c),
    });

    this.pipeline = new Pipeline({
      repo: this.repo,
      seller: () => this.seller,
      llm: this.llm,
      retriever: this.retriever,
      research: this.research,
      executor: this.executor,
      proposer: this.proposer,
      showContext: this.showContext,
      audit: this.audit,
      events: {
        onChat: (m) => emit("chat", m),
        onProposal: (p) => emit("proposal", p),
        onMetrics: (m) => emit("metrics", m),
        onListingChanged: (id) => {
          const l = this.repo.listing(id);
          if (l) emit("listing", l);
        },
      },
    });
  }

  get show(): ShowState {
    return this.repo.show();
  }

  /** Point this show at the agent belonging to the catalog it just loaded. */
  useAgent(agentId: string): void {
    this.llm.setAgent(agentId);
  }

  get agentId(): string {
    return this.llm.agentId;
  }

  /**
   * What a console gets when it connects.
   *
   * Deliberately not "everything in the database". A three-hour show ends with
   * hundreds of closed lots, and a reviewer opening the console on hotel wifi
   * should not wait for them: an ended lot cannot be sold, cannot be pinned and
   * cannot be the subject of a reply. The pinned lot is always included even if
   * it just closed, so the rail never blanks out mid-render.
   */
  snapshot(): Record<string, unknown> {
    const show = this.repo.show();
    const listings = this.repo.listings().filter(
      (l) => l.state !== "ended" || l.id === show.pinnedListingId,
    );
    return {
      seller: this.seller,
      catalogId: this.catalogId,
      agentId: this.llm.agentId,
      show,
      listings,
      proposals: this.pipeline.list(),
      actions: this.executor.list(),
      audit: this.audit.list(200),
      metrics: this.pipeline.metrics(),
      context: this.showContext.current(),
    };
  }

  setAutonomy(level: AutonomyLevel): ShowState {
    this.pipeline.setAutonomy(level);
    return this.repo.show();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.showContext.start();

    if (this.o.source === "ebaylive" && this.o.externalId) {
      await this.startEbayWatcher(this.o.externalId);
    } else if (config.simulate) {
      this.simSource = new SimulatedShowSource();
      this.simSource.onMessage((m) => this.pipeline.ingest(m));
      void this.simSource.start();
      this.hostAudio = new ScriptedHostAudio();
      this.hostAudio.onSegment((t) => this.showContext.push(t));
      this.hostAudio.start();
    }
  }

  private async startEbayWatcher(eventId: string): Promise<void> {
    const emit = (event: string, data: unknown) => this.o.events.emit(this.showId, event, data);

    this.watcher = new EbayLiveWatcher({
      eventId,
      onStatus: (s) => emit("source", { source: "ebaylive", eventId, ...s }),

      onTitle: (title) => {
        // Attaching by id alone gives the show a placeholder name; the page knows
        // what it is actually called.
        this.db.prepare("UPDATE show SET title = ? WHERE id = ?").run(title, this.showId);
        emit("show", this.repo.show());
      },

      onComment: (c) => {
        // Straight into the same pipeline the simulated source feeds. eBay's own
        // per-comment UUID becomes the message id, so a re-attach cannot replay
        // a comment that was already answered.
        this.pipeline.ingest({ author: c.author, text: c.text, externalId: c.id });
      },

      onLot: (lot) => {
        if (!lot.title) return;
        // The live lot becomes a versioned listing. When the price moves, the
        // version bumps — which is exactly the input the staleness guard and the
        // version-keyed reply cache were built for, now driven by a real auction
        // rather than a scripted markdown.
        const { listing, changed, created } = this.repo.upsertObservedLot({
          title: lot.title,
          priceCents: lot.priceCents,
          soldOut: lot.soldOut,
          highBidder: lot.highBidder,
        });
        if (changed) {
          this.retriever.rebuild();
          const prevPinned = this.repo.show().pinnedListingId;
          this.repo.updateShow({ pinnedListingId: listing.id });
          emit("listing", listing);
          if (prevPinned && prevPinned !== listing.id) {
            const prev = this.repo.listing(prevPinned);
            if (prev) emit("listing", prev);
          }
          // Deliberately NOT audited.
          //
          // The hash chain is the record of AGENCY — what this copilot and this
          // seller did, so that "who changed the price" has an answer and every
          // write can be undone. A bid landing on someone else's auction is not
          // something we did; writing it as `action_committed` by `system` made
          // the vocabulary lie and buried the one entry that mattered (a reply
          // sent to a buyer) under 199 identical lines.
          //
          // The observation is not lost: `emit("listing", …)` above carries it
          // live, and the listing row keeps `version` + `observedAt`, which is
          // what stale-price detection actually reads.
        }
      },

      onViewers: (n) => {
        this.repo.updateShow({ viewers: n });
        emit("show", this.repo.show());
      },
    });

    await this.watcher.start();
  }

  async stop(): Promise<void> {
    // Drain the reply path FIRST. A draft still waiting on the gateway will
    // come back to a database this method is about to close.
    await this.pipeline.stop();
    this.showContext.stop();
    this.simSource?.stop();
    this.hostAudio?.stop();
    await this.watcher?.stop().catch(() => {});
    this.watcher = null;
    this.started = false;
  }

  async close(): Promise<void> {
    await this.stop();
    this.db.close();
  }
}
