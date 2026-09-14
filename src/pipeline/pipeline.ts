// The core loop. One buyer message in, one grounded, guarded proposal out.
//
//   admit ──▶ classify ──▶ [cache?] ──▶ retrieve ──▶ compose ──▶ guard ──┬─ allow  ─▶ suggest / auto-send
//     │           │                                            ▲        ├─ revise ─▶ ONE repair pass ─┘
//     │           │                                            └────────┘
//     └─ dropped ─┴─▶ still shown in the ticker, never replied to        └─ block  ─▶ needs you
//
// Three things are deliberate about the ordering:
//
//  • The cache is consulted BEFORE the LLM and keyed on listing versions, so a
//    repeated question is answered in under a millisecond and a markdown makes
//    every stale key unreachable rather than merely expired.
//  • Guards run on the composed draft against CURRENT listing state, re-read at
//    guard time. The gap between what retrieval saw and what is true now is the
//    whole point — see `priceGuard`.
//  • The repair pass is bounded to exactly one. An unbounded repair loop is how a
//    latency budget dies, and a draft that fails twice is a draft the seller
//    should look at.
//
// Fan-out is bounded (`REPLY_CONCURRENCY`, below the gateway's shared 8-wide LLM
// semaphore) and a 429 backs off and retries rather than dropping the buyer's
// question.

import { config } from "../config.js";
import type {
  AutonomyLevel, ChatMessage, Evidence, GuardName, Metrics, ReplyProposal,
} from "../domain/types.js";
import type { Repo } from "../domain/repo.js";
import type { LlmPort } from "../llm/types.js";
import { LlmError } from "../llm/types.js";
import { Composer } from "../compose/composer.js";
import { Retriever } from "../retrieval/retriever.js";
import type { ResearchService } from "../research/research.js";
import { runChain, emptyGuardBlocks } from "../guardrails/chain.js";
import { admit, classify, classifySpeechAct, RateLimiter } from "../ingest/classify.js";
import type { IncomingMessage } from "../ingest/sources.js";
import { ShowContextEngine } from "../ingest/showContext.js";
import { LatencyTracker, SpanTimer } from "../latency/spans.js";
import { cacheKey, ReplyCache } from "../latency/cache.js";
import { decideAction, decideReply } from "../autonomy/ladder.js";
import { ActionExecutor } from "../actions/executor.js";
import { ActionProposer } from "../actions/proposer.js";
import type { AuditLog } from "../actions/audit.js";

export interface PipelineEvents {
  onChat(m: ChatMessage): void;
  onProposal(p: ReplyProposal): void;
  onMetrics(m: Metrics): void;
  onListingChanged(listingId: string): void;
}

export interface PipelineDeps {
  repo: Repo;
  /** Who is selling, and in what voice. Supplied by the chosen catalog. */
  seller?: () => { handle: string; name: string; about: string; voice: string } | null;
  llm: LlmPort;
  retriever: Retriever;
  /** Comps and market position. Called on the reply path for the questions that
   *  are ABOUT the market — see `researchEvidence`. */
  research: ResearchService;
  executor: ActionExecutor;
  proposer: ActionProposer;
  showContext: ShowContextEngine;
  audit: AuditLog;
  events: PipelineEvents;
}

export class Pipeline {
  private composer: Composer;
  private cache = new ReplyCache();
  private latency: LatencyTracker;
  private rate: RateLimiter;
  private proposals = new Map<string, ReplyProposal>();
  /** Set when the show is torn down. A draft in flight when that happens has
   *  nowhere to land: its database is about to close, and persisting into a
   *  closed handle throws from inside a promise nobody is awaiting. */
  private stopped = false;
  /** Every draft currently awaiting the gateway, so shutdown can wait for them
   *  instead of racing them to the database handle. */
  private pending = new Set<Promise<unknown>>();
  private seenActionKeys = new Set<string>();
  private queue: ChatMessage[] = [];
  private inflight = 0;
  private counters = {
    proposals: 0, sent: 0, autoSent: 0, dismissed: 0, blocked: 0,
    admitted: 0, guardBlocks: emptyGuardBlocks(),
  };

  constructor(private d: PipelineDeps) {
    this.composer = new Composer(d.llm);
    this.latency = new LatencyTracker(config.latencyBudgetMs);
    this.rate = new RateLimiter(config.proposalsPerMin);
  }

  // ── entry point ───────────────────────────────────────────────────────────
  async ingest(incoming: IncomingMessage): Promise<ChatMessage> {
    const timer = new SpanTimer();
    const intent = classify(incoming.text);
    // The second axis: what KIND of utterance this is, on the same vocabulary
    // Whissle measures the host's audio on. Both are shown to the operator.
    const speechAct = classifySpeechAct(incoming.text);
    timer.mark("classify");

    const show = await this.d.repo.show();
    const level = show.autonomyLevel;
    const observing = level === "L0_OBSERVE";
    const decision = admit(incoming.text, intent, observing ? false : this.rate.tryAdmit(), speechAct);
    timer.mark("admit");

    const msg: ChatMessage = {
      id: incoming.externalId || `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      author: incoming.author,
      text: incoming.text,
      at: new Date().toISOString(),
      intent,
      speechAct,
      admitted: decision.admitted,
      ...(decision.reason ? { dropReason: observing ? "autonomy is L0 — observing only" : decision.reason } : {}),
    };

    // Operational signals come from EVERY real question, including the ones the
    // rate cap dropped: four people asking for a discount is the signal whether
    // or not we replied to all four.
    if (intent !== "hype") {
      const resolved = this.d.retriever.retrieve(incoming.text, {
        pinnedId: show.pinnedListingId,
        mode: "structured-only",
        maxFacts: 2,
      });
      this.d.proposer.record({
        at: Date.now(),
        intent,
        listingId: resolved.slots.viaAnaphora ? null : resolved.slots.listingIds[0] ?? null,
        author: incoming.author,
      });
    }

    this.d.events.onChat(msg);

    if (decision.admitted) {
      this.counters.admitted++;
      this.queue.push(msg);
      this.pump();
    }

    // An action proposal failing must never take down chat ingestion: the reply
    // path is the product, the action rail is an enhancement.
    void this.evaluateActions().catch((e) =>
      console.warn(`[pipeline] action evaluation failed: ${(e as Error).message}`),
    );
    return msg;
  }

  // ── bounded fan-out ───────────────────────────────────────────────────────
  private pump(): void {
    while (this.inflight < config.replyConcurrency && this.queue.length) {
      const msg = this.queue.shift()!;
      this.inflight++;
      const p = this.draft(msg).finally(() => {
        this.inflight--;
        this.pending.delete(p);
        this.pump();
      });
      this.pending.add(p);
    }
  }

  /**
   * Stop accepting work and let what is in flight finish.
   *
   * A draft is one gateway round-trip long. If the show is torn down inside
   * that window the draft comes back to a closed database and throws from a
   * promise nobody awaits — an unhandled rejection on every shutdown that
   * happened to land mid-reply.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    await Promise.allSettled([...this.pending]);
  }

  // ── the reply path ────────────────────────────────────────────────────────
  /**
   * Market evidence for the questions that are actually about the market.
   *
   * Deliberately narrow. Comps belong in a reply that compares or prices, and
   * nowhere else: adding them to "does it ship to Canada" would dilute the
   * evidence set the guards check a claim against, and every extra fact is
   * budget spent in the compose prompt.
   *
   * Dedupes against what retrieval already found, so a listing's price is not
   * cited twice under two ids.
   */
  private async researchEvidence(
    msg: ChatMessage,
    already: Evidence[],
    pinnedId: string | null,
  ): Promise<Evidence[]> {
    const wants =
      msg.intent === "comparison" ||
      /\b(good (?:price|deal)|worth it|going for|market value|overpriced|fair price|too much)\b/i.test(msg.text);
    if (!wants) return [];

    const card = await this.d.research.run(msg.text, pinnedId);
    const seen = new Set(already.map((e) => e.factId));
    return card.evidence.filter((e) => !seen.has(e.factId));
  }

  private async draft(msg: ChatMessage, attempt = 0, previous?: string): Promise<void> {
    // The show is going away. Nothing this draft produces has anywhere to be
    // written or anyone to render it.
    if (this.stopped) return;
    const timer = new SpanTimer();
    const show = await this.d.repo.show();

    let proposal: ReplyProposal = {
      id: `prop_${msg.id}`,
      message: msg,
      status: "drafting",
      draft: "",
      claims: [], evidence: [], guards: [],
      verdict: "allow", confidence: 0, repaired: false,
      spans: timer.result(config.latencyBudgetMs, false),
      createdAt: new Date().toISOString(),
    };
    this.proposals.set(proposal.id, proposal);
    // A regenerate replaces a proposal; counting it again would inflate the
    // answered-rate denominator with work the seller already saw.
    if (!previous) this.counters.proposals++;
    this.d.events.onProposal(proposal);

    // 1. retrieve (local, no network)
    const r = this.d.retriever.retrieve(msg.text, { pinnedId: show.pinnedListingId });
    // "Is that a good price?" and "how does it compare to the other one?" are
    // market questions, and the comps that answer them were already on disk —
    // the reply path just never asked. Research is a local query costing
    // single-digit milliseconds and it returns Evidence in the same shape as
    // everything else, so a reply built on it stays guard-checkable.
    for (const e of await this.researchEvidence(msg, r.evidence, show.pinnedListingId)) {
      r.evidence.push(e);
    }
    timer.mark("retrieve");

    // 2. cache, keyed on the versions of every listing the grounding touched.
    //    A regenerate deliberately skips it: the seller is asking for something
    //    OTHER than the answer we already have.
    const key = cacheKey({ question: msg.text, facts: r.evidence });
    const hit = previous ? null : this.cache.get(key);
    if (hit) {
      proposal = await this.finish(proposal, {
        ...hit, spans: timer.result(config.latencyBudgetMs, true),
      }, msg);
      return;
    }

    try {
      // 3. compose
      // Stream the draft to the console while the guards wait for all of it.
      // The p95 complaint is time-to-FIRST-TOKEN — an operator staring at a
      // spinner for two seconds while a buyer waits — and that is what this
      // fixes. Time-to-SEND is unchanged and must be: a partially generated
      // reply has not been checked by anything.
      let lastPartial = "";
      const onPartial = previous ? undefined : (answerSoFar: string) => {
        if (answerSoFar === lastPartial) return;
        lastPartial = answerSoFar;
        const streaming = { ...proposal, status: "drafting" as const, draft: answerSoFar };
        this.proposals.set(proposal.id, streaming);
        this.d.events.onProposal(streaming);
      };

      const { draft, contextBlock } = await this.composer.draft(
        {
          show,
          pinned: show.pinnedListingId ? await this.d.repo.listing(show.pinnedListingId) : null,
          context: this.d.showContext.current(),
          seller: this.d.seller?.() ?? null,
          facts: r.facts,
          abstain: r.abstain,
          viaAnaphora: r.slots.viaAnaphora,
        },
        msg.author,
        msg.text,
        previous,
        onPartial,
      );
      timer.mark("compose");

      // 4. guard, against state re-read NOW
      const guardInput = async () => {
        // Re-read together, AFTER the compose hop. The gap between the state
        // retrieval saw and the state that is true now is the whole point of
        // this layer — a markdown landing during the LLM round trip is exactly
        // what the price guard exists to catch.
        const [listings, policies] = await Promise.all([
          this.d.repo.listings(), this.d.repo.policies(),
        ]);
        return {
          draft,
          question: msg.text,
          facts: r.facts,
          factById: new Map(r.facts.map((f) => [f.factId, f])),
          currentListings: new Map(listings.map((l) => [l.id, l])),
          slots: r.slots,
          policies,
        };
      };
      let chain = runChain(await guardInput(), { evidenceQuality: r.evidence[0]?.score ?? 0, abstained: r.abstain });
      timer.mark("guard");

      // 5. exactly one repair pass, and only for `revise`
      let finalDraft = draft;
      let repaired = false;
      if (chain.verdict === "revise") {
        const repairedDraft = await this.composer.repair(contextBlock, msg.author, msg.text, chain.failures);
        finalDraft = repairedDraft;
        repaired = true;
        const input = { ...(await guardInput()), draft: repairedDraft };
        chain = runChain(input, { evidenceQuality: r.evidence[0]?.score ?? 0, abstained: r.abstain });
        timer.mark("repair");
      }

      const result = {
        answer: finalDraft.answer,
        claims: finalDraft.claims,
        evidence: r.evidence,
        guards: chain.guards,
        verdict: chain.verdict,
        confidence: chain.confidence,
        repaired,
      };
      this.cache.set(key, result);
      this.finish(proposal, { ...result, spans: timer.result(config.latencyBudgetMs, false) }, msg);
    } catch (e) {
      // The gateway's shared LLM pool 429s a burst. Back off and retry rather
      // than dropping a buyer's question on the floor.
      if (e instanceof LlmError && e.isRateLimited && attempt < 3) {
        await sleep(350 * 2 ** attempt + Math.random() * 250);
        return this.draft(msg, attempt + 1, previous);
      }
      const failed: ReplyProposal = {
        ...proposal,
        status: "needs_review",
        draft: "",
        verdict: "revise",
        guards: [{ guard: "claim_grounding", verdict: "revise", reason: `drafting failed: ${(e as Error).message}` }],
        spans: timer.result(config.latencyBudgetMs, false),
      };
      this.proposals.set(failed.id, failed);
      this.d.events.onProposal(failed);
      void this.emitMetrics();
    }
  }

  /** Apply the autonomy ladder, record metrics, emit. */
  private async finish(
    base: ReplyProposal,
    r: {
      answer: string; claims: ReplyProposal["claims"]; evidence: Evidence[];
      guards: ReplyProposal["guards"]; verdict: ReplyProposal["verdict"];
      confidence: number; repaired: boolean; spans: ReplyProposal["spans"];
    },
    msg: ChatMessage,
  ): Promise<ReplyProposal> {
    const level = (await this.d.repo.show()).autonomyLevel;
    const disposition = decideReply({
      level, intent: msg.intent, verdict: r.verdict,
      confidence: r.confidence, abstained: r.evidence.length === 0,
    });

    const status: ReplyProposal["status"] =
      disposition.kind === "auto_send" ? "auto_sent"
      : disposition.kind === "blocked" ? "blocked"
      : disposition.kind === "needs_review" ? "needs_review"
      : disposition.kind === "drop" ? "dismissed"
      : "ready";

    // `r.answer` is the composer's field name; the wire field is `draft`. Map it
    // explicitly rather than spreading — a silent spread mismatch here is exactly
    // how the console ended up rendering empty cards.
    const { answer, ...rest } = r;
    const proposal: ReplyProposal = {
      ...base, ...rest, draft: answer, status,
      ...(status === "auto_sent" ? { sentText: answer } : {}),
    };

    for (const g of r.guards) {
      if (g.verdict === "block") this.counters.guardBlocks[g.guard as GuardName]++;
    }
    if (status === "blocked") {
      this.counters.blocked++;
      this.d.audit.append("reply_blocked", "copilot", `blocked reply to ${msg.author}: ${msg.text.slice(0, 80)}`, {
        proposalId: proposal.id,
        guards: r.guards.filter((g) => g.verdict === "block"),
        draft: r.answer,
      });
    }
    if (status === "auto_sent") {
      this.counters.autoSent++;
      this.counters.sent++;
      this.d.audit.append("reply_sent", "copilot", `auto-sent to ${msg.author}`, {
        proposalId: proposal.id, text: r.answer, confidence: r.confidence,
      });
    }

    this.latency.record(r.spans.totalMs, r.spans.cacheHit);
    this.proposals.set(proposal.id, proposal);
    this.d.events.onProposal(proposal);
    void this.emitMetrics();
    return proposal;
  }

  // ── operator commands ─────────────────────────────────────────────────────
  send(id: string, text?: string): ReplyProposal {
    const p = this.proposals.get(id);
    if (!p) throw new Error(`proposal ${id} not found`);
    const sentText = (text ?? p.draft).trim();
    const next: ReplyProposal = { ...p, status: "sent", sentText };
    this.proposals.set(id, next);
    this.counters.sent++;
    this.d.audit.append("reply_sent", "seller", `sent to ${p.message.author}`, {
      proposalId: id, text: sentText, edited: text !== undefined && text.trim() !== p.draft.trim(),
      verdictAtSend: p.verdict,
    });
    this.d.events.onProposal(next);
    void this.emitMetrics();
    return next;
  }

  dismiss(id: string): ReplyProposal {
    const p = this.proposals.get(id);
    if (!p) throw new Error(`proposal ${id} not found`);
    const next: ReplyProposal = { ...p, status: "dismissed" };
    this.proposals.set(id, next);
    this.counters.dismissed++;
    this.d.events.onProposal(next);
    void this.emitMetrics();
    return next;
  }

  async regenerate(id: string): Promise<ReplyProposal> {
    const p = this.proposals.get(id);
    if (!p) throw new Error(`proposal ${id} not found`);
    // Retrieval re-runs too, so a regenerate after a price move is grounded on
    // the new state rather than re-wording a stale answer.
    await this.draft(p.message, 0, p.draft || undefined);
    return this.proposals.get(id)!;
  }

  async setAutonomy(level: AutonomyLevel): Promise<void> {
    const prev = (await this.d.repo.show()).autonomyLevel;
    await this.d.repo.updateShow({ autonomyLevel: level });
    await this.d.audit.append("autonomy_changed", "seller", `autonomy ${prev} to ${level}`, { from: prev, to: level });
  }

  list(): ReplyProposal[] {
    return [...this.proposals.values()];
  }

  get(id: string): ReplyProposal | null {
    return this.proposals.get(id) ?? null;
  }

  // ── operational proposals ─────────────────────────────────────────────────
  private async evaluateActions(): Promise<void> {
    const level = (await this.d.repo.show()).autonomyLevel;
    for (const p of await this.d.proposer.evaluate()) {
      if (this.seenActionKeys.has(p.dedupeKey)) continue;
      this.seenActionKeys.add(p.dedupeKey);

      const action = await this.d.executor.propose(p.kind, p.listingId, p.params, p.summary, p.rationale);
      // `propose` is idempotent; a returned action we have already handled needs
      // no second approval pass.
      if (action.status !== "proposed" && action.status !== "preflight_failed") continue;
      const disposition = decideAction(level, p.kind, action.preflight.ok);
      if (disposition.kind === "auto_commit") {
        await this.d.executor.approve(action.id, "copilot").catch(() => {});
      }
    }
  }

  /** Emit metrics without making every caller async.
   *
   *  Metrics are telemetry for the operator's header, not part of the reply
   *  contract: a send must not wait on a COUNT to render, and a failed count
   *  must not fail the send. */
  private async emitMetrics(): Promise<void> {
    try {
      this.d.events.onMetrics(await this.metrics());
    } catch {
      /* a metrics read that fails is not a reason to fail the turn */
    }
  }

  async metrics(): Promise<Metrics> {
    const c = this.counters;
    const recent = await this.d.executor.list(500);
    return {
      proposals: c.proposals,
      sent: c.sent,
      autoSent: c.autoSent,
      dismissed: c.dismissed,
      blocked: c.blocked,
      guardBlocks: { ...c.guardBlocks },
      latency: this.latency.percentiles(),
      cacheHitRate: this.latency.cacheHitRate,
      answeredRate: c.admitted ? Number((c.sent / c.admitted).toFixed(3)) : 0,
      actionsCommitted: recent.filter((a) => a.status === "committed").length,
      actionsRolledBack: recent.filter((a) => a.status === "rolled_back").length,
    };
  }

  /** Invalidate caches after a listing write. The version-keyed cache makes old
   *  entries unreachable anyway; the retriever genuinely needs the rebuild. */
  onListingWrite(listingId: string): void {
    this.d.retriever.rebuild();
    this.d.events.onListingChanged(listingId);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
