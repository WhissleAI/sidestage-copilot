// One watched show = one ShowRuntime.
//
// A runtime owns its own pipeline, retriever, executor and audit chain, and
// every row it writes carries its `show_id` in Postgres. The tenancy boundary
// is two-fold: a runtime never queries across shows, and every show carries the
// `owner_account_id` of the account that attached it — the API answers 404 to
// anyone else, so a missed filter cannot leak one seller's catalog into
// another's reply. Attaching a third show cannot slow or corrupt the two
// already running, and a show that ends is dropped by closing one handle.

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
import { EbayMarketplace } from "../actions/marketplace/ebay.js";
import { EbayOAuth } from "../ingest/ebay/oauth.js";
import type { MarketplaceAdapter } from "../actions/marketplace/port.js";
import type { RemoteListing } from "../actions/marketplace/port.js";
import { ResearchService } from "../research/research.js";
import { enrichLot, needsIdentity } from "../ingest/enrichLot.js";
import { SessionRecord, buildReport, type ShowReport } from "./sessionRecord.js";
import { SessionSignals } from "./signals.js";
import { concludeShow } from "./conclusion.js";
import { WhissleSessions } from "../llm/sessions.js";
import { ShowContextEngine } from "../ingest/showContext.js";
import { Pipeline } from "../pipeline/pipeline.js";
import { WhissleClient } from "../llm/whissle.js";
import { meter } from "../llm/meter.js";
import { policy, policyScope, type SellerGuardrailPolicy } from "../guardrails/policy.js";
import type { Persona } from "../persona/store.js";
import type { Fact } from "../retrieval/facts.js";
import { spendWindow } from "../llm/billing.js";
import type { AutonomyLevel, ShowState } from "../domain/types.js";
import type { SurfaceConnection, SurfaceId } from "../surfaces/types.js";
import { get as surfaceAdapter } from "../surfaces/registry.js";
import { SimulatedShowSource, ScriptedHostAudio, type ChatSource } from "../ingest/sources.js";

export interface RuntimeEvents {
  emit(showId: string, event: string, data: unknown): void;
}

export interface ShowRuntimeOpts {
  showId: string;
  title: string;
  sellerHandle: string;
  source: SurfaceId;
  externalId?: string | null;
  readOnly?: boolean;
  /** The account that attached this show. Every read and write of the show
   *  is scoped to it; a show with no owner is visible to nobody. */
  ownerAccountId?: string | null;
  events: RuntimeEvents;
  /** Use this database instead of a per-show file (the seeded demo show). */
  dbPath?: string;
  /** The owner's merged guard settings, looked up per call so a change made
   *  mid-show applies to the next draft. Watcher-driven work (a buyer's
   *  comment arriving from eBay) runs inside this policy; request-driven
   *  work runs inside the caller's. */
  policyFor?: () => Promise<SellerGuardrailPolicy>;
  /** The owner's persona and voice corpus, for the composer. Same contract as
   *  `policyFor`: looked up per draft, so an edit reaches the next reply. */
  personaFor?: () => Promise<{ persona: Persona; voice: Fact[] } | null>;
  /** The watcher decided the show is over. The registry finishes the session. */
  onEnded?: (showId: string, why: string) => void;
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
  /** The show's signals — utterances, frames, audio — persisted. */
  readonly signals: SessionSignals;
  readonly showContext: ShowContextEngine;
  readonly pipeline: Pipeline;
  readonly market: MockMarketplace;
  /**
   * Where this show's writes actually land.
   *
   * A stored per-show choice, not an inference from whether a connection
   * happens to exist — an operator has to know, before approving a markdown,
   * whether it hits a mock or a listing real buyers are looking at. Connecting
   * eBay grants the capability; the show has to be switched to it.
   */
  private adapter: MarketplaceAdapter;

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

  /** The open connection to whichever surface this show is on. */
  private watcher: SurfaceConnection | null = null;
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

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.db = pgPool();
    this.repo = new Repo(this.db, o.showId);
    this.retriever = new Retriever(this.repo);
    this.audit = new AuditLog(this.db, o.showId);
    this.market = new MockMarketplace([]);
    this.adapter = this.market;

    const emit = (event: string, data: unknown) => o.events.emit(this.showId, event, data);

    // The executor holds a stable reference, so the adapter is routed through
    // this object rather than swapped out from under it mid-show.
    const routed: MarketplaceAdapter = {
      get name() { return self.adapter.name; },
      get: (id) => self.adapter.get(id),
      reserve: (i) => self.adapter.reserve(i),
      apply: (r) => self.adapter.apply(r),
      confirm: (r) => self.adapter.confirm(r),
      cancel: (r) => self.adapter.cancel(r),
      compensate: (r, b) => self.adapter.compensate(r, b),
    };

    this.executor = new ActionExecutor(this.db, this.repo, routed, this.audit, {
      // The seller's setting, not an environment variable — they are the one
      // who decides how long a committed write stays one keystroke from undo.
      undoWindowS: policy().automation.undoWindowS,
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
    this.signals = new SessionSignals(this.db);

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
      persona: this.o.personaFor,
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
  /** Timers waiting to name a lot; cleared on stop so a detached show cannot
   *  wake up and write to a closed pool. */
  private nameTimers = new Set<NodeJS.Timeout>();

  /** Run watcher-driven work inside the owner's guard policy (see policy.ts). */
  private async underOwnerPolicy<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.o.policyFor) return fn();
    let p: SellerGuardrailPolicy | null = null;
    try { p = await this.o.policyFor(); } catch { p = null; }
    return p ? policyScope.run(p, fn) : fn();
  }

  private async nameLot(listingId: string, lot: { title: string; priceCents: number }): Promise<void> {
    await new Promise<void>((r) => {
      const t = setTimeout(() => { this.nameTimers.delete(t); r(); }, NAME_AFTER_MS);
      this.nameTimers.add(t);
    });
    if (!this.started) return;
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
      // The row exists, so this is a RE-attach — a new session on a show that
      // ended. It goes back on air with a fresh clock. A row already `live`
      // (resume after a restart) keeps its clock; that is the WHERE clause.
      // Left as it was, the Shows list said "0 on air" under a live strip that
      // said LIVE, and a restart never resumed the show because it was
      // "ended".
      await this.db.query(
        "UPDATE shows SET status = 'live', started_at = $2 WHERE id = $1 AND status = 'ended'",
        [this.showId, new Date().toISOString()],
      );
    } catch {
      await this.repo.createShow({
        id: this.o.showId,
        title: this.o.title,
        sellerHandle: this.o.sellerHandle,
        source: this.o.source,
        externalId: this.o.externalId ?? null,
        readOnly: this.o.readOnly ?? false,
        ownerAccountId: this.o.ownerAccountId ?? null,
        // Where a new show starts is a seller setting. L4 can never be it:
        // bounded auto-acting only ever runs against a mock marketplace.
        autonomyLevel: policy().automation.startingRung,
        undoWindowS: policy().automation.undoWindowS,
      });
    }

    await this.refreshIndex();

    // A show that was writing to eBay before a restart must not quietly come
    // back writing to a mock — that is the same action reported as done with a
    // different thing actually happening.
    const stored = (
      await this.db.query<{ write_target: string }>(
        "SELECT write_target FROM shows WHERE id = $1",
        [this.showId],
      )
    ).rows[0]?.write_target;
    if (stored === "ebay") {
      await this.setWriteTarget("ebay").catch((e) => {
        console.warn(`  ${this.showId}: staying on the mock marketplace — ${(e as Error).message}`);
      });
    }

    const remote: RemoteListing[] = this.lotRows.map((l) => ({
      id: l.id, priceCents: l.priceCents, qty: l.qty, state: l.state, pinned: l.pinned, version: l.version,
    }));
    this.market.reset(remote);
  }

  private lotRows: ListingWithDescription[] = [];

  /**
   * Point this show's writes at eBay, or back at the mock.
   *
   * Refuses to arm eBay without a live connection for the show's owner, because
   * the alternative is an operator approving a markdown that fails at the last
   * step with an auth error — after the audit entry says it was approved.
   */
  async setWriteTarget(target: "mock" | "ebay"): Promise<"mock" | "ebay"> {
    if (target === "mock") {
      this.adapter = this.market;
      await this.db.query("UPDATE shows SET write_target = 'mock' WHERE id = $1", [this.showId]);
      return "mock";
    }

    const owner = (
      await this.db.query<{ owner_account_id: string | null }>(
        "SELECT owner_account_id FROM shows WHERE id = $1",
        [this.showId],
      )
    ).rows[0]?.owner_account_id;
    if (!owner) throw new Error("this show has no owner account — claim the console first");

    const auth = new EbayOAuth(this.db);
    const token = await auth.userToken(owner);
    if (!token) throw new Error("no eBay account is connected — connect one in Settings first");

    this.adapter = new EbayMarketplace(
      async (listingId) => {
        const l = await this.repo.listing(listingId);
        return l
          ? {
              id: l.id, sku: l.sku, priceCents: l.priceCents, qty: l.qty,
              version: l.version, state: l.state, pinned: l.pinned,
            }
          : null;
      },
      () => auth.userToken(owner),
    );
    await this.db.query("UPDATE shows SET write_target = 'ebay' WHERE id = $1", [this.showId]);
    return "ebay";
  }

  /** What the operator is actually about to write to. */
  get writeTarget(): "mock" | "ebay" {
    return this.adapter.name === "ebay" ? "ebay" : "mock";
  }

  /** Rebuild the retrieval index and the caches derived from the same snapshot. */
  /** Public because a lot the operator just renamed has to be searchable by
   *  that name before the next question arrives. */
  async refreshIndex(): Promise<void> {
    await this.retriever.rebuild();
    this.lotRows = await this.repo.listings();
    this.lots = this.lotRows.map((l) => ({ id: l.id, title: `${l.title} size ${l.size}` }));

    // Warm the market cache for the lots about to be asked about — the pinned
    // one first, then the front of the queue. eBay is slow enough that fetching
    // on demand means never having an answer in time; fetching ahead means
    // nearly always having one. Fire-and-forget: a live show does not wait on
    // comparables, it just has better ones a minute later.
    const pinnedFirst = [...this.lotRows].sort((a, b) =>
      a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1,
    );
    void this.research.warm(pinnedFirst).catch(() => {});
  }

  show(): Promise<ShowState> {
    return this.repo.show();
  }

  /** Point this show at the agent belonging to the catalog it just loaded. */
  useAgent(agentId: string): void {
    this.llm.setAgent(agentId);
  }

  /** Who this show belongs to. Null only for rows written before ownership
   *  existed; those are nobody's and stay invisible until re-attached. */
  private ownerCache: string | null | undefined;
  get ownerAccountId(): string | null {
    return this.ownerCache ?? this.o.ownerAccountId ?? null;
  }
  async loadOwner(): Promise<string | null> {
    const r = await this.db.query<{ owner_account_id: string | null }>(
      "SELECT owner_account_id FROM shows WHERE id = $1", [this.showId],
    );
    this.ownerCache = r.rows[0]?.owner_account_id ?? this.o.ownerAccountId ?? null;
    return this.ownerCache;
  }

  get externalId(): string | null {
    return this.o.externalId ?? null;
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
    const [show, all, actions, audit, metrics, chat] = await Promise.all([
      this.repo.show(), this.repo.listings(), this.executor.list(),
      this.audit.list(200), this.pipeline.metrics(),
      // Chat is the one thing the runtime does not hold in memory — it is
      // emitted and forgotten. A console opened an hour into a show would show
      // an empty firehose until the next buyer typed.
      this.record.recentChat(60).catch(() => []),
    ]);
    const listings = all.filter((l) => l.state !== "ended" || l.id === show.pinnedListingId);
    return {
      seller: this.seller,
      catalogId: this.catalogId,
      agentId: this.llm.agentId,
      show,
      listings,
      chat,
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

    if (this.o.source !== "simulated" && this.o.externalId) {
      await this.openSurface(this.o.source, this.o.externalId);
    } else if (config.simulate) {
      this.simSource = new SimulatedShowSource();
      this.simSource.onMessage((m) => this.pipeline.ingest(m));
      void this.simSource.start();
      this.hostAudio = new ScriptedHostAudio();
      this.hostAudio.onSegment((t) => this.showContext.push(t));
      this.hostAudio.start();
    }
  }

  /**
   * Open the show's surface and wire its events into this runtime.
   *
   * Every callback below is the one the eBay Live watcher has always called,
   * under the name every surface answers to (src/surfaces/types.ts). The
   * adapter does the renaming; the watcher itself is untouched, which is what
   * keeps the reference surface behaving exactly as it did.
   */
  private async openSurface(surface: SurfaceId, eventId: string): Promise<void> {
    const emit = (event: string, data: unknown) => this.o.events.emit(this.showId, event, data);
    const adapter = surfaceAdapter(surface);
    if (!adapter) throw new Error(`no adapter is registered for surface "${surface}"`);

    this.watcher = await adapter.open({ externalId: eventId }, {
      onStatus: (s) => emit("source", { source: surface, eventId, ...s }),

      onTitle: (title) => {
        // Attaching by id alone gives the show a placeholder name; the page knows
        // what it is actually called.
        void this.repo.updateShow({ title }).then((next) => emit("show", next));
      },

      onMessage: (c) => {
        // Straight into the same pipeline the simulated source feeds. eBay's own
        // per-comment UUID becomes the message id, so a re-attach cannot replay
        // a comment that was already answered.
        if (!this.started) return;
        void this.underOwnerPolicy(() => this.pipeline.ingest({ author: c.author, text: c.text, externalId: c.id }));
      },

      onEnded: (why) => {
        emit("source", { source: surface, eventId, connected: false, detail: `ended — ${why}` });
        this.o.onEnded?.(this.showId, why);
      },

      onItem: (lot) => {
        if (!lot.title || !this.started) return;
        void (async () => {
        // The live lot becomes a versioned listing. When the price moves, the
        // version bumps — which is exactly the input the staleness guard and the
        // version-keyed reply cache were built for, now driven by a real auction
        // rather than a scripted markdown.
        const { listing, changed, created } = await this.repo.upsertObservedLot({
          title: lot.title,
          priceCents: lot.priceCents ?? 0,
          soldOut: lot.soldOut ?? false,
          highBidder: (lot.meta?.highBidder as string | null) ?? null,
        });

        // eBay names lots "#007 - As seen on eBay LIVE", which tells a buyer's
        // question nothing to match against. Ask the show what it is, ONCE per
        // lot, from the host's speech and the camera — the two places the
        // identity actually exists.
        if (created && needsIdentity(lot.title) && !this.named.has(listing.id)) {
          this.named.add(listing.id);
          void this.nameLot(listing.id, { title: lot.title, priceCents: lot.priceCents ?? 0 });
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
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const t of this.nameTimers) clearTimeout(t);
    this.nameTimers.clear();
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
      const listen = (
        await this.db.query<{ listen_room: string | null; listen_started_at: string | null }>(
          "SELECT listen_room, listen_started_at FROM shows WHERE id = $1", [this.showId],
        )
      ).rows[0];
      const sessions = new WhissleSessions(config.whissle.base, config.whissle.apiKey);
      const report = await buildReport(this.db, this.showId, {
        auditChain: chain,
        signals: this.signals,
        // Only when the bridge ever opened a session: without one there is
        // nothing on the gateway to match, and "window" matching would pick up
        // someone else's call.
        platform: listen?.listen_started_at
          ? () => sessions.voiceSessionFor({
              agentId: this.llm.agentId,
              room: listen.listen_room,
              since: listen.listen_started_at,
            })
          : undefined,
        conclude: this.llm.agentId ? (e) => concludeShow(this.llm, e) : undefined,
      });
      await this.db.query(
        `INSERT INTO show_reports (show_id, report) VALUES ($1, $2::jsonb)
         ON CONFLICT (show_id) DO UPDATE SET report = EXCLUDED.report, generated_at = now()`,
        [this.showId, JSON.stringify(report)],
      );
      await this.db.query("UPDATE shows SET status = 'ended' WHERE id = $1", [this.showId]);
      await this.recordCost(report).catch(() => {});
      return report;
    } catch (e) {
      // A report that cannot be built must not stop a session ending — but the
      // show still has to end, or it stays `live` forever in a list that says
      // so. The failure is loud because the report is the most useful artefact
      // the session produces, and losing one silently is how it stays broken.
      console.error(`  REPORT FAILED for ${this.showId}: ${(e as Error).message}`);
      await this.db
        .query("UPDATE shows SET status = 'ended' WHERE id = $1", [this.showId])
        .catch(() => {});
      return null;
    }
  }

  /**
   * What this show cost, written down before the process forgets it.
   *
   * The meter and the wallet-delta window are both in memory: a restart zeroed
   * them and nothing in Postgres recorded spend, so the Cost page could answer
   * "right now" and nothing about last week. The call counts are exact — this
   * app makes the calls — and the dollar figure is a bound, because the wallet
   * is workspace-wide. The row keeps them apart so the caveat survives.
   */
  private async recordCost(report: ShowReport): Promise<void> {
    const snap = meter.snapshot();
    const mine = snap.byShow[this.showId];
    if (!mine) return;

    // The spend window is keyed by show and opened when the session attached.
    // A wallet we could not read leaves this null — which is "unknown", and
    // must never render as zero.
    const spent = spendWindow.lastKnown(this.showId);

    await this.db.query(
      `INSERT INTO show_costs
         (show_id, opened_at, duration_min, calls, failures, context_chars, by_door, wallet_delta_usd, answered, account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
       ON CONFLICT (show_id) DO UPDATE SET
         closed_at = now(), duration_min = EXCLUDED.duration_min, calls = EXCLUDED.calls,
         failures = EXCLUDED.failures, context_chars = EXCLUDED.context_chars,
         by_door = EXCLUDED.by_door, wallet_delta_usd = EXCLUDED.wallet_delta_usd,
         answered = EXCLUDED.answered, account_id = COALESCE(EXCLUDED.account_id, show_costs.account_id)`,
      [
        this.showId,
        report.startedAt,
        Math.round(report.durationMin),
        mine.calls,
        mine.failures,
        mine.contextChars,
        JSON.stringify(mine.byDoor),
        spent,
        report.engagement.answered,
        this.ownerAccountId,
      ],
    );
  }

  /** The pool is process-wide now, not a file this show owns, so closing a
   *  show releases its watchers and nothing else. */
  async close(): Promise<void> {
    await this.stop();
  }
}
