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
import type { LlmPort } from "../llm/types.js";
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
  llm: LlmPort;
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

  private watcher: EbayLiveWatcher | null = null;
  private simSource: ChatSource | null = null;
  private hostAudio: ScriptedHostAudio | null = null;
  private started = false;

  constructor(private o: ShowRuntimeOpts) {
    this.showId = o.showId;

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
        for (const l of this.repo.listings()) emit("listing", l);
      },
    });

    this.proposer = new ActionProposer(this.repo);
    this.research = new ResearchService(this.repo);

    this.showContext = new ShowContextEngine({
      llm: o.llm,
      lotTitles: () => this.repo.listings().map((l) => ({ id: l.id, title: `${l.title} size ${l.size}` })),
      onUpdate: (c) => emit("context", c),
    });

    this.pipeline = new Pipeline({
      repo: this.repo,
      llm: o.llm,
      retriever: this.retriever,
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

  snapshot(): Record<string, unknown> {
    return {
      show: this.repo.show(),
      listings: this.repo.listings(),
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
          this.repo.updateShow({ pinnedListingId: listing.id });
          for (const l of this.repo.listings()) emit("listing", l);
          this.audit.append(
            "action_committed",
            "system",
            created ? `lot opened: ${lot.title}` : `lot updated: ${lot.title}`,
            { source: "ebaylive", eventId, priceCents: lot.priceCents, soldOut: lot.soldOut, highBidder: lot.highBidder },
          );
          emit("audit", this.audit.list(1)[0]);
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
