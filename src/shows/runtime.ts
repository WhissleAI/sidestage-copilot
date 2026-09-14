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
import { db as pgPool, type Pool } from "../db/pg.js";
import { Repo, type ListingWithDescription } from "../domain/repo.js";
import { Retriever } from "../retrieval/retriever.js";
import { AuditLog } from "../actions/audit.js";
import { ActionExecutor } from "../actions/executor.js";
import { ActionProposer } from "../actions/proposer.js";
import { MockMarketplace } from "../actions/marketplace/mock.js";
import type { RemoteListing } from "../actions/marketplace/port.js";
import { ResearchService } from "../research/research.js";
import { enrichLot, needsIdentity } from "../ingest/enrichLot.js";
import { SessionRecord, buildReport, type ShowReport } from "./sessionRecord.js";
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

/** How long to let the host talk about a new lot before asking what it is. A
 *  lot hits the screen before anyone describes it. */
const NAME_AFTER_MS = 12_000;

export class ShowRuntime {
  readonly showId: string;
  readonly db: Pool;
  readonly repo: Repo;
  readonly retriever: Retriever;
  readonly audit: AuditLog;
  readonly executor: ActionExecutor;
  readonly proposer: ActionProposer;
  readonly research: ResearchService;
  /** Persists chat + proposals so a report can be built after the fact. */
  readonly record: SessionRecord;
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

    this.db = pgPool();
    this.repo = new Repo(this.db, o.showId);
    this.retriever = new Retriever(this.repo);
    this.audit = new AuditLog(this.db, o.showId);
    this.market = new MockMarketplace([]);

    const emit = (event: string, data: unknown) => o.events.emit(this.showId, event, data);

    this.executor = new ActionExecutor(this.db, this.repo, this.market, this.audit, {
      undoWindowS: config.undoWindowS,
      onChange: (a) => {
        emit("action", a);
        void this.audit.list(1).then((rows) => { if (rows[0]) emit("audit", rows[0]); });
      },
      onListingWrite: (id) => {
        void (async () => {
          await this.refreshIndex();
          // Emit the listing that changed, plus whatever is pinned (a swap moves
          // the pin off another row). Re-emitting the whole catalog on every write
          // put 315 listing frames on the wire in 30 seconds against a live show.
          const changed = await this.repo.listing(id);
          if (changed) emit("listing", changed);
          const pinned = await this.repo.pinned();
          if (pinned && pinned.id !== id) emit("listing", pinned);
        })();
      },
    });

    this.proposer = new ActionProposer(this.repo);
    this.research = new ResearchService(this.repo);
    this.record = new SessionRecord(this.db, o.showId);

    this.showContext = new ShowContextEngine({
      llm: this.llm,
      // Served from the snapshot the retriever last indexed, so the context
      // engine and the grounding facts always describe the same lineup.
      lotTitles: () => this.lots,
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
        onChat: (m) => {
          emit("chat", m);
          // Fire-and-forget: a buyer's question must never wait on a write.
          this.record.recordChat(m);
        },
        onProposal: (p) => {
          emit("proposal", p);
          this.record.recordProposal(p);
        },
        onMetrics: (m) => emit("metrics", m),
        onListingChanged: (id) => {
          void this.repo.listing(id).then((l) => { if (l) emit("listing", l); });
        },
      },
    });
  }

  /** Lot titles for the context engine, refreshed with the retriever's index. */
  private lots: { id: string; title: string }[] = [];
  /** Lots already sent for naming, so a re-observation does not re-ask. */
  private named = new Set<string>();

  /**
   * Name one observed lot from the show itself.
   *
   * Deferred a beat: a lot appears on screen before the host has said anything
   * about it, and asking in that instant gets a name built from the previous
   * lot's speech — confidently wrong, which is worse than unnamed.
   */
  private async nameLot(listingId: string, lot: { title: string; priceCents: number }): Promise<void> {
    await new Promise((r) => setTimeout(r, NAME_AFTER_MS));
    try {
      const show = await this.repo.show();
      const id = await enrichLot(this.llm, lot, this.showContext.current(), show.title);
      if (!id) return;
      await this.repo.nameObservedLot(listingId, id.name, id.basis);
      await this.refreshIndex();
      const named = await this.repo.listing(listingId);
      if (named) this.o.events.emit(this.showId, "listing", named);
      console.log(`  named ${listingId}: ${id.name} (${id.basis})`);
    } catch {
      /* a lot without a name still has a price; naming is an enhancement */
    }
  }

  /**
   * Everything the constructor cannot do because it needs the database.
   *
   * Split out rather than hidden behind lazy getters: a show that failed to
   * provision should fail loudly at creation, not on the first buyer question.
   */
  async init(): Promise<void> {
    // A show row may not exist yet; the demo show arrives pre-seeded.
    try {
      await this.repo.show();
    } catch {
      await this.repo.createShow({
        id: this.o.showId,
        title: this.o.title,
        sellerHandle: this.o.sellerHandle,
        source: this.o.source,
        externalId: this.o.externalId ?? null,
        readOnly: this.o.readOnly ?? false,
        autonomyLevel: config.autonomyDefault,
        undoWindowS: config.undoWindowS,
      });
    }

    await this.refreshIndex();
    const remote: RemoteListing[] = this.lotRows.map((l) => ({
      id: l.id, priceCents: l.priceCents, qty: l.qty, state: l.state, pinned: l.pinned, version: l.version,
    }));
    this.market.reset(remote);
  }

  private lotRows: ListingWithDescription[] = [];

  /** Rebuild the retrieval index and the caches derived from the same snapshot. */
  private async refreshIndex(): Promise<void> {
    await this.retriever.rebuild();
    this.lotRows = await this.repo.listings();
    this.lots = this.lotRows.map((l) => ({ id: l.id, title: `${l.title} size ${l.size}` }));
  }

  show(): Promise<ShowState> {
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
  async snapshot(): Promise<Record<string, unknown>> {
    // One round of reads, in parallel: a console connecting should not wait on
    // five sequential queries.
    const [show, all, actions, audit, metrics] = await Promise.all([
      this.repo.show(), this.repo.listings(), this.executor.list(),
      this.audit.list(200), this.pipeline.metrics(),
    ]);
    const listings = all.filter((l) => l.state !== "ended" || l.id === show.pinnedListingId);
    return {
      seller: this.seller,
      catalogId: this.catalogId,
      agentId: this.llm.agentId,
      show,
      listings,
      proposals: this.pipeline.list(),
      actions,
      audit,
      metrics,
      context: this.showContext.current(),
    };
  }

  async setAutonomy(level: AutonomyLevel): Promise<ShowState> {
    await this.pipeline.setAutonomy(level);
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
        void this.repo.updateShow({ title }).then((next) => emit("show", next));
      },

      onComment: (c) => {
        // Straight into the same pipeline the simulated source feeds. eBay's own
        // per-comment UUID becomes the message id, so a re-attach cannot replay
        // a comment that was already answered.
        void this.pipeline.ingest({ author: c.author, text: c.text, externalId: c.id });
      },

      onLot: (lot) => {
        if (!lot.title) return;
        void (async () => {
        // The live lot becomes a versioned listing. When the price moves, the
        // version bumps — which is exactly the input the staleness guard and the
        // version-keyed reply cache were built for, now driven by a real auction
        // rather than a scripted markdown.
        const { listing, changed, created } = await this.repo.upsertObservedLot({
          title: lot.title,
          priceCents: lot.priceCents,
          soldOut: lot.soldOut,
          highBidder: lot.highBidder,
        });

        // eBay names lots "#007 - As seen on eBay LIVE", which tells a buyer's
        // question nothing to match against. Ask the show what it is, ONCE per
        // lot, from the host's speech and the camera — the two places the
        // identity actually exists.
        if (created && needsIdentity(lot.title) && !this.named.has(listing.id)) {
          this.named.add(listing.id);
          void this.nameLot(listing.id, lot);
        }
        if (changed) {
          await this.refreshIndex();
          const prevPinned = (await this.repo.show()).pinnedListingId;
          await this.repo.updateShow({ pinnedListingId: listing.id });
          emit("listing", listing);
          if (prevPinned && prevPinned !== listing.id) {
            const prev = await this.repo.listing(prevPinned);
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
        })();
      },

      onViewers: (n) => {
        void this.repo.updateShow({ viewers: n }).then((next) => emit("show", next));
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

  /**
   * Close the session and leave a report behind.
   *
   * Generated once, at the end, and stored — a statement about a show that has
   * finished, whose numbers must not drift afterwards. Built from the persisted
   * chat and proposals rather than from memory, which is exactly why those are
   * persisted at all.
   */
  async finishSession(): Promise<ShowReport | null> {
    try {
      const chain = await this.audit.verify();
      const report = await buildReport(this.db, this.showId, { auditChain: chain });
      await this.db.query(
        `INSERT INTO show_reports (show_id, report) VALUES ($1, $2::jsonb)
         ON CONFLICT (show_id) DO UPDATE SET report = EXCLUDED.report, generated_at = now()`,
        [this.showId, JSON.stringify(report)],
      );
      await this.db.query("UPDATE shows SET status = 'ended' WHERE id = $1", [this.showId]);
      return report;
    } catch (e) {
      // A report that cannot be built must not stop a session ending.
      console.warn(`  could not build report for ${this.showId}: ${(e as Error).message}`);
      return null;
    }
  }

  /** The pool is process-wide now, not a file this show owns, so closing a
   *  show releases its watchers and nothing else. */
  async close(): Promise<void> {
    await this.stop();
  }
}
