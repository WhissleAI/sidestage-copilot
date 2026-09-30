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
  AutonomyLevel, ChatMessage, Evidence, GuardName, Metrics, ReplyDelivery, ReplyProposal,
} from "../domain/types.js";
import type { Repo } from "../domain/repo.js";
import type { LlmPort } from "../llm/types.js";
import { LlmError } from "../llm/types.js";
import { Composer } from "../compose/composer.js";
import type { Persona } from "../persona/store.js";
import { styleRef, type StyleRef } from "../persona/voice.js";
import { Retriever } from "../retrieval/retriever.js";
import type { ResearchService } from "../research/research.js";
import type { GuardInput } from "../guardrails/types.js";
import { capabilitiesOf } from "../surfaces/types.js";
import { runChain, emptyGuardBlocks } from "../guardrails/chain.js";
import { admit, classify, classifySpeechAct, RATE_CAP_REASON, RateLimiter } from "../ingest/classify.js";
import type { IncomingMessage } from "../ingest/sources.js";
import { ShowContextEngine } from "../ingest/showContext.js";
import type { ThreadContext } from "../ingest/threadContext.js";
import { hostFacts } from "../retrieval/hostFacts.js";
import { toEvidence, type RetrievalResult } from "../retrieval/retriever.js";
import type { Fact } from "../retrieval/facts.js";
import { LatencyTracker, SpanTimer } from "../latency/spans.js";
import { cacheKey, ReplyCache } from "../latency/cache.js";
import { decideAction, decideReply } from "../autonomy/ladder.js";
import { ActionExecutor } from "../actions/executor.js";
import { ActionProposer } from "../actions/proposer.js";
import type { AuditLog } from "../actions/audit.js";
import { isOverBudget } from "../llm/budget.js";
import { answeredRate } from "../shows/metrics.js";
import { recordEvent } from "../obs/events.js";
import { logSwallowed, logWarn, errText } from "../obs/log.js";

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
  /**
   * The owner's persona and their voice corpus, looked up per draft so an edit
   * made mid-show reaches the next reply — the same contract `policyFor` has.
   *
   * Absent for a show with no owner, and null for an owner who has not written
   * one; in both cases nothing below runs and the prompt is the prompt that
   * shipped before personas existed.
   */
  persona?: () => Promise<{ persona: Persona; voice: Fact[] } | null>;
  llm: LlmPort;
  retriever: Retriever;
  /** Comps and market position. Called on the reply path for the questions that
   *  are ABOUT the market — see `researchEvidence`. */
  research: ResearchService;
  executor: ActionExecutor;
  proposer: ActionProposer;
  showContext: ShowContextEngine;
  /**
   * The RULES OF THE ROOM this message was written in, as constraints.
   *
   * A second input beside the retriever, and deliberately not part of it.
   * `GuardInput.community` used to be `retrieved.facts.filter(community)`, and
   * the retriever's index is the seller's listings and policies — so no
   * producer of a community fact (a subreddit's rules, a sponsor's "do not
   * claim") had any route to the guard chain at all, and `communityRuleGuard`
   * returned n/a on every real watch. A rule is not grounding to be ranked
   * against a question: it is in force whether or not it resembles what was
   * asked. The surface adapter answers this from what it has already fetched
   * (src/surfaces/types.ts, `constraintsFor`); absent on a surface with no
   * rooms, which is every live-commerce surface.
   */
  constraints?: (m: ChatMessage) => Fact[];
  /**
   * The branch above the message being answered, on an asynchronous surface.
   *
   * `ShowContextEngine` answers "what is happening right now", which is exactly
   * right for a live show and empty in a subreddit. This is its counterpart:
   * the opening post and the path down to the comment. Supplied by the surface
   * (`SurfaceAdapter.threadFor`), absent where a conversation is not a tree,
   * and never a reason to lose a reply — a thread that cannot be read is a
   * draft composed without it, not an error.
   */
  thread?: (m: ChatMessage, rules: Fact[]) => Promise<ThreadContext | null>;
  audit: AuditLog;
  events: PipelineEvents;
  /**
   * Put a reply in front of the person who asked.
   *
   * The seam, and nothing wires one today — which is the honest state of this
   * product and the reason `send` records rather than delivers. eBay Live
   * publishes no chat-post API (that absence is why the surface is scraped at
   * all), Whatnot and TikTok would need us to drive the seller's own browser,
   * and Reddit is draft-only in code as a product commitment. The one real
   * delivery mechanism in the build is Twitch's `post_reply`, which runs
   * through the action executor — preflight, the rooms posting switch, the
   * audit chain and the undo window — and has never been connected to the
   * console's Send button.
   *
   * Supplying this is the whole of "this surface can deliver". Until one is,
   * every reply is recorded as delivered by a human, because it is.
   */
  deliver?: ReplyDeliverer;
}

/**
 * The constraints in force on this reply, from both doors.
 *
 * The per-room input is the one that matters and is checked first; anything
 * with `corpus: "community"` that also came back from retrieval is kept, so a
 * surface that does ground in a community corpus (Twitch's sponsor
 * prohibitions, once they are indexed) is not silently dropped. Deduped by
 * `factId`, because a rule enforced twice reads as two rules.
 */
/** The thread as a client sees it: the same branch, with the rules rendered
 *  the way every other cited thing reaches the console and nothing an index
 *  needs. */
function threadView(t: ThreadContext): ReplyProposal["thread"] {
  return {
    threadId: t.threadId,
    ancestors: t.ancestors,
    room: t.room,
    rules: t.rules.map((f) => toEvidence(f, 0)),
    summary: t.summary,
  };
}

function constraintsOf(fromRoom: Fact[], retrieved: Fact[]): Fact[] {
  const out: Fact[] = [];
  const seen = new Set<string>();
  for (const f of [...fromRoom, ...retrieved]) {
    if (f.corpus !== "community" || seen.has(f.factId)) continue;
    seen.add(f.factId);
    out.push(f);
  }
  return out;
}

/** @see PipelineDeps.deliver */
export type ReplyDeliverer = (m: {
  proposalId: string; to: string; text: string;
}) => Promise<void>;

/** Said the same way in the firehose, in the report and in the audit entry. */
const BUDGET_REASON = "this show reached its spend cap — the copilot stopped drafting";

/** Why a backlog message was not drafted against: it predates the console. */
const HISTORIC_REASON = "asked before you attached";

/** The guards said no at the moment of sending. Not an error in the system. */
export class SendRefused extends Error {}

export class Pipeline {
  private composer: Composer;
  private cache = new ReplyCache();
  private latency: LatencyTracker;
  private rate: RateLimiter;
  private proposals = new Map<string, ReplyProposal>();
  /** What each proposal was grounded in, kept so an operator's EDIT of the
   *  draft can be guarded against the same facts before it is sent. */
  private grounding = new Map<string, { facts: GuardInput["facts"]; slots: GuardInput["slots"]; evidenceQuality: number }>();
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
    proposals: 0, sent: 0, delivered: 0, handedOff: 0, autoSent: 0, dismissed: 0, blocked: 0,
    admitted: 0, guardBlocks: emptyGuardBlocks(),
  };

  constructor(private d: PipelineDeps) {
    this.composer = new Composer(d.llm);
    this.latency = new LatencyTracker(config.latencyBudgetMs);
    this.rate = new RateLimiter(config.proposalsPerMin);
  }

  // ── entry point ───────────────────────────────────────────────────────────
  /**
   * @param opts.force  Draft for this message even though the admission gate
   *   would have dropped it. The operator asked for it explicitly — the gate is
   *   right about nearly everything and wrong about some, and without this it
   *   is unarguable rather than merely strict. The override is recorded on the
   *   message so a gate miss stays visible in the report.
   */
  /**
   * `historic` — said before we attached.
   *
   * Recorded, classified and shown in the ticker like anything else, and never
   * drafted against. Exactly what `L0_OBSERVE` already does, for the same
   * reason: answering an hour-old question is worse than not answering it.
   */
  async ingest(
    incoming: IncomingMessage,
    opts: { force?: boolean; historic?: boolean } = {},
  ): Promise<ChatMessage> {
    const timer = new SpanTimer();
    const intent = classify(incoming.text);
    // The second axis: what KIND of utterance this is, on the same vocabulary
    // Whissle measures the host's audio on. Both are shown to the operator.
    const speechAct = classifySpeechAct(incoming.text);
    timer.mark("classify");

    const show = await this.d.repo.show();
    const level = show.autonomyLevel;
    const observing = level === "L0_OBSERVE";
    // The spend cap is the hardest gate there is: it outranks the operator's
    // own override, because "answer this one anyway" is a request to spend and
    // the cap is the seller's standing answer to that request.
    const capped = isOverBudget(this.d.repo.showId);
    // The limiter goes in as a THUNK, not as a value: `admit` draws the token
    // at the last gate rather than the caller drawing it at the first, so a
    // greeting or a "W" no longer costs a proposal the seller could have had.
    const natural = admit(
      incoming.text,
      intent,
      () => !observing && !opts.historic && this.rate.tryAdmit(),
      speechAct,
    );
    const decision = capped
      ? { admitted: false, reason: BUDGET_REASON }
      : opts.force
        ? { admitted: true, reason: undefined }
        : natural;
    timer.mark("admit");

    const msg: ChatMessage = {
      id: incoming.externalId || `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      author: incoming.author,
      text: incoming.text,
      // The platform's own timestamp when it sent one. A comment written four
      // minutes ago is four minutes old in the queue, not new — on a live show
      // the two are the same number and this reads exactly as it did.
      at: incoming.at || new Date().toISOString(),
      // Carried, not interpreted. Everything that makes this message part of a
      // CONVERSATION rather than a line in a firehose (src/ingest/sources.ts).
      ...(incoming.threadId ? { threadId: incoming.threadId } : {}),
      ...(incoming.parentId ? { parentId: incoming.parentId } : {}),
      ...(incoming.room ? { room: incoming.room } : {}),
      ...(incoming.url ? { url: incoming.url } : {}),
      intent,
      speechAct,
      admitted: decision.admitted,
      ...(decision.reason
        ? {
            dropReason: capped
              ? BUDGET_REASON
              : observing
                ? "autonomy is L0 — observing only"
                : // A backlog message reaches the limiter thunk with `historic`
                  // already false-ing it, so the gate reports the cap — which is
                  // not what happened. Attach mid-show and every real question
                  // in the backlog read "proposal rate cap reached": a cap the
                  // seller never hit, on a console whose whole claim is that it
                  // says where a thing came from. Worse than noise — a seller
                  // reading it goes and raises a cap that was never the problem.
                  opts.historic && decision.reason === RATE_CAP_REASON
                  ? HISTORIC_REASON
                  : decision.reason,
          }
        : {}),
      ...(!capped && opts.force && !natural.admitted
        ? { dropReason: `answered anyway — the gate said: ${natural.reason ?? "dropped"}` }
        : {}),
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
  private async researchGrounding(
    msg: ChatMessage,
    already: Fact[],
    pinnedId: string | null,
  ): Promise<{ fact: Fact; score: number }[]> {
    const wants =
      msg.intent === "comparison" ||
      /\b(good (?:price|deal)|worth it|going for|market value|overpriced|fair price|too much)\b/i.test(msg.text);
    if (!wants) return [];

    // A buyer is waiting on this one; the market lookup gets the short budget.
    const card = await this.d.research.run(msg.text, pinnedId, { caller: "reply" });
    const seen = new Set(already.map((f) => f.factId));
    // The score is research's, not re-derived here: an asking-price median and
    // a sold-comp median are weighted differently and that judgement belongs
    // where the basis is known.
    return (card.facts ?? [])
      .filter((f) => !seen.has(f.factId))
      .map((fact) => ({ fact, score: card.evidence.find((e) => e.factId === fact.factId)?.score ?? 0.8 }));
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
      // Carried from the first frame the console renders, so a card never
      // offers a Send button for a second and then takes it away.
      delivery: this.deliveryFor(show.source),
      spans: timer.result(config.latencyBudgetMs, false),
      createdAt: new Date().toISOString(),
    };
    this.proposals.set(proposal.id, proposal);
    // A regenerate replaces a proposal; counting it again would inflate the
    // answered-rate denominator with work the seller already saw.
    if (!previous) this.counters.proposals++;
    this.d.events.onProposal(proposal);

    // 1. retrieve (local, no network)
    // A listing was written since the index was built, and whichever path did
    // it did not rebuild. Rather than ground this reply on a catalog that is
    // provably behind the database, catch up first — the cost is one rebuild on
    // the rare draft that follows a missed refresh, against a copilot that
    // abstains on questions its own lineup answers.
    if (this.d.retriever.stale) await this.d.retriever.rebuild();
    const r = this.d.retriever.retrieve(msg.text, { pinnedId: show.pinnedListingId });
    // The copilot declining to answer a buyer, with the reason it declined.
    //
    // Only on abstention, so this is quiet on a healthy show and loud on the
    // one failure an operator cannot otherwise explain. `indexedFacts` is the
    // field that separates "we looked and found nothing" from "there was
    // nothing to look at" — the distinction that took a database copy and six
    // wrong hypotheses to recover the last time it mattered.
    if (r.abstain) {
      logWarn("retrieval.abstained", {
        showId: this.d.repo.showId,
        question: msg.text.slice(0, 120),
        ...r.why,
        listingIds: r.slots.listingIds.length,
        fields: r.slots.fields.join(","),
      });
    }
    this.addHostFacts(msg.text, r);
    // "Is that a good price?" and "how does it compare to the other one?" are
    // market questions, and the comps that answer them were already on disk —
    // the reply path just never asked.
    //
    // Onto BOTH sides. `r.evidence` is the operator's citation chips;
    // `r.facts` is what the composer is given, what `buildContextBlock`
    // renders as GROUNDING FACTS and what becomes `factById` for the guards.
    // Pushing only the first is what made the card show a "Market · asking
    // now" chip beside a reply saying the host would cover it: the model was
    // never told the median, and a reply that cited one anyway would have been
    // blocked for citing an id that resolves to nothing.
    for (const { fact, score } of await this.researchGrounding(msg, r.facts, show.pinnedListingId)) {
      r.facts.push(fact);
      r.evidence.push(toEvidence(fact, score));
    }
    timer.mark("retrieve");

    // The rules of the room, from the surface rather than from retrieval.
    // Read ONCE per draft and used for the guard chain, the cache key and the
    // card, so the three cannot disagree about what was in force.
    const roomRules = constraintsOf(this.d.constraints?.(msg) ?? [], r.facts);

    // 2. cache, keyed on the versions of every listing the grounding touched.
    //    A regenerate deliberately skips it: the seller is asking for something
    //    OTHER than the answer we already have.
    //
    //    The rules are part of the key. A cached verdict is a statement about a
    //    draft in a ROOM — a profile watch answers in several — and a rule
    //    edited by a moderator makes every answer written under the old one
    //    unreachable rather than merely stale.
    const key = cacheKey({ question: msg.text, facts: [...r.evidence, ...roomRules] });
    // A message in a THREAD is never answered from the cache.
    //
    // The cache exists for a live firehose, where "how much" is the same
    // question the twentieth time somebody types it. In a tree it is not: the
    // same words under two different branches are two different questions, and
    // reusing an answer composed for one of them would hand a buyer a reply
    // written about a conversation they are not in. A subreddit is polled once
    // a minute, so what this costs is nothing.
    const threaded = Boolean(msg.threadId);
    const hit = previous || threaded ? null : this.cache.get(key);
    if (hit) {
      proposal = await this.finish(proposal, {
        ...hit, spans: timer.result(config.latencyBudgetMs, true),
      }, msg);
      return;
    }

    // The conversation this answers. Fetched before the composer is called and
    // never allowed to fail the draft: a branch we could not read costs the
    // reply its context, which is a worse answer, not no answer.
    const thread = await this.threadOf(msg, roomRules);

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

      // The voice corpus is NOT merged into `r.facts`. A style reference that
      // sat among the grounding facts would be citable, and a claim citing one
      // would pass the grounding guard with a provenance chip pointing at a
      // sentence about a different item on a different day.
      const p = await this.persona();
      const { draft, contextBlock } = await this.composer.draft(
        {
          show,
          pinned: show.pinnedListingId ? await this.d.repo.listing(show.pinnedListingId) : null,
          context: this.d.showContext.current(),
          thread,
          seller: this.d.seller?.() ?? null,
          persona: p?.persona ?? null,
          styleRef: p ? styleRef(msg.text, p.voice) : null,
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
          asker: msg.author,
          facts: r.facts,
          factById: new Map(r.facts.map((f) => [f.factId, f])),
          currentListings: new Map(listings.map((l) => [l.id, l])),
          slots: r.slots,
          policies,
          surface: capabilitiesOf(show.source),
          community: roomRules,
        };
      };
      this.grounding.set(proposal.id, { facts: r.facts, slots: r.slots, evidenceQuality: r.evidence[0]?.score ?? 0 });
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
        // From the FIRST draft: a repair rewrites the words, not the manner it
        // was asked to write them in.
        ...(draft.styleRef ? { styleRef: draft.styleRef } : {}),
        /**
         * A reply that cites nothing has no provenance to show.
         *
         * `r.evidence` is what RETRIEVAL found, not what the draft used. A
         * deflection cites nothing and still carried the chips, so the live
         * console showed
         *
         *   "The host will cover that shortly, bigmike."
         *   [Catalog · the seller's own stock]   ✓ grounding   0.10
         *
         * — a provenance chip and a green tick on a reply containing not one
         * word from the catalog. `guards.ts` already names this combination
         * the worst available, "unverified and presented as verified", and the
         * comment above `researchGrounding` records the same symptom being
         * chased once before ("a Market · asking now chip beside a reply
         * saying the host would cover it"). That fix was for one trigger; this
         * is the general case.
         *
         * Narrow on purpose: zero claims means zero chips. A reply that cites
         * two of three retrieved facts still shows all three, which is looser
         * than ideal but at least relates to what it said. Only the empty case
         * asserts provenance for content that has none.
         *
         * `r.evidence` itself is untouched — the cache key, `evidenceQuality`
         * and the `abstained` signal all read it and all mean "what we had".
         */
        evidence: finalDraft.claims.length ? r.evidence : [],
        groundless: r.evidence.length === 0,
        // The rules that were in force, beside the evidence rather than among
        // it: a constraint is not a citation, and `abstained` counts evidence.
        ...(roomRules.length ? { rules: roomRules.map((f) => toEvidence(f, 0)) } : {}),
        ...(thread ? { thread: threadView(thread) } : {}),
        guards: chain.guards,
        verdict: chain.verdict,
        confidence: chain.confidence,
        repaired,
      };
      if (!threaded) this.cache.set(key, result);
      // AWAITED. `finish` is what writes the proposal and emits it; dropping its
      // promise made `draft` resolve before the write had happened, with three
      // consequences that all point the same way:
      //
      //   · `stop()` could not wait for it. `pump` tracks DRAFTS in `pending`
      //     and `stop` awaits those — but a draft that has already resolved is
      //     not waiting for anything, so the write raced the teardown. That is
      //     precisely the failure `stop()`'s own note describes: "the draft
      //     comes back to a closed database and throws from a promise nobody
      //     awaits".
      //   · the fan-out bound was wrong. `inflight--` ran while the write was
      //     still going, so `replyConcurrency` counted composition only.
      //   · a failure lost its session. An unhandled rejection is caught by the
      //     process handler, which records the event with NO showId by design —
      //     so the most consequential failure on the reply path landed on
      //     nobody's timeline. Awaited, it is caught by the retry/report path
      //     below, which knows which show it is.
      //
      // The other call site (the abstain path above) already awaited it.
      await this.finish(proposal, { ...result, spans: timer.result(config.latencyBudgetMs, false) }, msg);
      this.evict();
    } catch (e) {
      // The gateway's shared LLM pool 429s a burst. Back off and retry rather
      // than dropping a buyer's question on the floor.
      if (e instanceof LlmError && e.isRateLimited && attempt < 3) {
        await sleep(350 * 2 ** attempt + Math.random() * 250);
        // The retry replaces THIS proposal; counting it again inflated the
        // answered-rate denominator by one per 429.
        return this.draft(msg, attempt + 1, previous ?? proposal.id);
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

  /** The branch above this message, or null. Never throws: see `thread` on
   *  `PipelineDeps`. */
  private async threadOf(msg: ChatMessage, rules: Fact[]): Promise<ThreadContext | null> {
    if (!this.d.thread) return null;
    try {
      return await this.d.thread(msg, rules);
    } catch (e) {
      console.warn(`[pipeline] thread unavailable for ${msg.id}: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * What accepting a reply on this show actually DOES.
   *
   * Two conditions, and both are required. The surface has to declare that a
   * reply can be delivered here at all — `capabilitiesOf(...).delivery` — and
   * this process has to hold a path that does it. Declaring the capability is
   * not having it, and the gap between those two is exactly the defect this
   * function exists to close: eBay Live declared `delivery: "api"`, the console
   * rendered a primary Send from it, `send` marked the proposal sent, the audit
   * recorded `reply_sent` and the answered-rate counted it — and no code
   * anywhere posted a single character to eBay.
   *
   * Read on every decision that could claim a delivery, never cached: wiring a
   * deliverer mid-show should change the next answer, not the next restart.
   */
  private deliveryFor(source: string | null | undefined): ReplyDelivery {
    return capabilitiesOf(source).delivery === "api" && this.d.deliver ? "api" : "human";
  }

  /** The owner's persona, or null — and never a reason to fail a draft. A
   *  persona lookup that throws would cost a buyer their answer over a voice
   *  setting, so the reply is written in the default voice instead. */
  private async persona(): Promise<{ persona: Persona; voice: Fact[] } | null> {
    if (!this.d.persona) return null;
    try {
      return await this.d.persona();
    } catch (e) {
      console.warn(`[pipeline] persona unavailable: ${(e as Error).message}`);
      return null;
    }
  }

  /** Apply the autonomy ladder, record metrics, emit. */
  private async finish(
    base: ReplyProposal,
    r: {
      answer: string; claims: ReplyProposal["claims"]; evidence: Evidence[];
      /**
       * Retrieval came back with nothing — which is what the autonomy ladder
       * means by "abstained", and is NOT the same question as whether the card
       * has a chip to show. It used to read `evidence.length === 0`, so the
       * moment `evidence` became the cited set rather than the retrieved one,
       * every deflection started reading as an abstention and the ladder sent
       * it to review. One field, two meanings; this is the other one.
       */
      groundless: boolean;
      guards: ReplyProposal["guards"]; verdict: ReplyProposal["verdict"];
      confidence: number; repaired: boolean; spans: ReplyProposal["spans"];
      styleRef?: StyleRef;
      rules?: Evidence[];
      thread?: ReplyProposal["thread"];
    },
    msg: ChatMessage,
  ): Promise<ReplyProposal> {
    const show = await this.d.repo.show();
    const delivery = this.deliveryFor(show.source);
    const disposition = decideReply({
      level: show.autonomyLevel, intent: msg.intent, verdict: r.verdict,
      confidence: r.confidence, abstained: r.groundless,
      delivery,
    });

    // An auto-send that cannot reach a deliverer is not an auto-send. The
    // ladder already refuses the disposition unless one is wired, so this is
    // the second lock rather than the first: if delivery throws, the reply
    // goes to the operator with the reason rather than being filed as sent.
    let autoSendFailed: string | null = null;
    if (disposition.kind === "auto_send") {
      try {
        await this.d.deliver!({ proposalId: base.id, to: msg.author, text: r.answer });
      } catch (e) {
        autoSendFailed = (e as Error).message;
      }
    }

    const status: ReplyProposal["status"] =
      disposition.kind === "auto_send" ? (autoSendFailed ? "needs_review" : "auto_sent")
      : disposition.kind === "blocked" ? "blocked"
      : disposition.kind === "needs_review" ? "needs_review"
      : disposition.kind === "drop" ? "dismissed"
      : "ready";

    // `r.answer` is the composer's field name; the wire field is `draft`. Map it
    // explicitly rather than spreading — a silent spread mismatch here is exactly
    // how the console ended up rendering empty cards.
    const { answer, ...rest } = r;
    const proposal: ReplyProposal = {
...base, ...rest, draft: answer, status, delivery,
      ...(status === "auto_sent" ? { sentText: answer, sentAt: new Date().toISOString() } : {}),
    };

    for (const g of r.guards) {
      if (g.verdict === "block") this.counters.guardBlocks[g.guard as GuardName]++;
    }
    if (status === "blocked") {
      this.counters.blocked++;
      await this.record("reply_blocked", "copilot", `blocked reply to ${msg.author}: ${msg.text.slice(0, 80)}`, {
        proposalId: proposal.id,
        guards: r.guards.filter((g) => g.verdict === "block"),
        draft: r.answer,
      }, false);
    }
    if (status === "auto_sent") {
      this.counters.autoSent++;
      this.counters.sent++;
      // Only reachable with a deliverer wired, and only after it returned.
      this.counters.delivered++;
      // Required: an auto-send happens with no human in the loop, so the ledger
      // is the only record that it did.
      await this.record("reply_sent", "copilot", `auto-sent to ${msg.author}`, {
        proposalId: proposal.id, text: r.answer, confidence: r.confidence, delivery,
      }, true);
    }

    this.latency.record(r.spans.totalMs, r.spans.cacheHit);
    this.proposals.set(proposal.id, proposal);
    this.d.events.onProposal(proposal);
    void this.emitMetrics();
    return proposal;
  }

  // ── operator commands ─────────────────────────────────────────────────────
  /**
   * Accept a reply — the last moment the guards can act, so they do.
   *
   * Two rules, and the second is what makes the first liveable.
   *
   *  1. A blocked draft is never sent AS IT STANDS, whatever the client asks.
   *     The console hides the button, but a keystroke or a curl is not the
   *     console, so the refusal lives here.
   *
   *  2. An EDITED draft is a NEW draft, and is judged on its own text rather
   *     than on the verdict the text it replaced earned. It is re-guarded
   *     against the facts the original was grounded in and the listings as they
   *     stand now; if the edit clears, it sends, and if it does not, the refusal
   *     names the guard. This is the path the held card's own copy promises —
   *     "edit it and send, the edit is checked again" — and for as long as rule
   *     1 fired before the re-guard, that sentence was false: a held reply could
   *     only ever be dismissed, however thoroughly the operator fixed it.
   *
   * The edit is checked as HUMAN-authored text (`authoredBy: "human"`), so the
   * guards that protect the buyer all run and the one that audits the model's
   * citation discipline does not — the operator was never handed a fact list to
   * cite from. See `runChain`'s `authoredBy` and MODEL_ONLY_GUARDS.
   *
   * What was actually checked is what the audit records.
   *
   * WHO SENDS IT is decided here and nowhere else. On a surface with a wired
   * delivery path this hands the text to it and records a delivery; on every
   * other surface it records that the reply was composed, guarded, audited and
   * handed to the operator — which is the whole truth of what happened, and is
   * worth recording honestly rather than dressing up as a send. The proposal
   * carries `delivery` so the console can say the same thing the audit does.
   */
  async send(id: string, text?: string, actor = "seller"): Promise<ReplyProposal> {
    const p = this.proposals.get(id);
    if (!p) throw new Error(`proposal ${id} not found`);
    // Already gone. A double-clicked button, a retried request or a second
    // operator hands back what was sent rather than sending it again: the
    // audit is a hash-chained record of what this copilot and this seller
    // actually did, and a duplicate `reply_sent` in it is a second thing that
    // never happened. `FollowUpInbox.markSent` has been idempotent since it was
    // written (`sent_at = COALESCE(sent_at, now())`); this is the other half of
    // the same queue behaving the same way.
    if (p.status === "sent" || p.status === "auto_sent") return p;
    const sentText = (text ?? p.draft).trim();
    const edited = text !== undefined && sentText !== p.draft.trim();
    const wasBlocked = p.status === "blocked" || p.verdict === "block";
    if (wasBlocked && !edited) {
      const why = p.guards.filter((g) => g.verdict === "block").map((g) => `${g.guard}: ${g.reason ?? "blocked"}`).join("; ");
      throw new SendRefused(`this reply was blocked and cannot be sent unedited — ${why || "a guard blocked it"}`);
    }
    let guards = p.guards;
    let verdict = p.verdict;
    if (edited) {
      const g = this.grounding.get(id);
      const [listings, policies, show] = await Promise.all([
        this.d.repo.listings(), this.d.repo.policies(), this.d.repo.show(),
      ]);
      const chain = runChain(
        {
          // The operator's own sentence, carrying no claims because they made
          // none: they are asserting this on their own authority, not citing
          // our evidence set. `claim_grounding` is skipped for exactly that
          // reason rather than being fed an empty claim list and asked to
          // pretend — which is what used to reject every substantive edit.
          draft: { answer: sentText, claims: [], parsedOk: true, raw: sentText },
          question: p.message.text,
          facts: g?.facts ?? [],
          factById: new Map((g?.facts ?? []).map((f) => [f.factId, f])),
          currentListings: new Map(listings.map((l) => [l.id, l])),
          slots: g?.slots ?? ({} as GuardInput["slots"]),
          policies,
          surface: capabilitiesOf(show.source),
          // An EDIT is checked against the room's rules too. The operator
          // rewriting a draft is the likeliest moment for a rule to be broken,
          // because the guards have already passed once.
          community: constraintsOf(this.d.constraints?.(p.message) ?? [], g?.facts ?? []),
        },
        { evidenceQuality: g?.evidenceQuality ?? 0, authoredBy: "human" },
      );
      if (chain.verdict === "block") {
        const why = chain.failures.filter((f) => chain.guards.some((x) => x.guard === f.guard && x.verdict === "block"))
          .map((f) => `${f.guard}: ${f.reason}`).join("; ");
        throw new SendRefused(`your edit was blocked — ${why}`);
      }
      guards = chain.guards;
      verdict = chain.verdict;
    }
    const source = (await this.d.repo.show()).source;
    const delivery = this.deliveryFor(source);
    // A delivery that throws is not a send. The operator keeps a usable draft
    // and hears why, rather than reading "sent" over a reply that is not.
    if (delivery === "api") {
      await this.d.deliver!({ proposalId: id, to: p.message.author, text: sentText })
        .catch((e: Error) => { throw new SendRefused(`not delivered — ${e.message}`); });
    }

    const next: ReplyProposal = {
      ...p, status: "sent", sentText, guards, verdict, delivery,
      sentAt: new Date().toISOString(),
    };
    this.proposals.set(id, next);
    this.counters.sent++;
    if (delivery === "api") this.counters.delivered++;
    else this.counters.handedOff++;
    // Awaited, and allowed to fail the send: the seller must not be told a reply
    // went out if the ledger does not say so.
    await this.record(
      "reply_sent",
      actor,
      delivery === "api"
        ? `delivered to ${p.message.author}`
        : `answer for ${p.message.author} approved and recorded — ${source ?? "this surface"} has no reply API, so ${actor === "seller" ? "the seller" : actor} posts it`,
      {
        proposalId: id, text: sentText, edited, delivery,
        // A held reply that an edit cleared is the one case where what went
        // out is not what the guards first saw. The audit says so explicitly
        // rather than leaving a reader to infer it from a changed verdict.
        ...(wasBlocked ? { clearedBlockByEdit: true } : {}),
        verdictAtSend: verdict, guardsAtSend: guards.map((g) => `${g.guard}:${g.verdict}`),
      },
      true,
    );
    this.d.events.onProposal(next);
    void this.emitMetrics();
    return next;
  }

  /**
   * An audit write on the reply path, awaited, with its failure handled.
   *
   * These three appends — `reply_blocked`, the auto-send and the seller's send —
   * were the only ones in the codebase whose promise was DROPPED. Every action
   * write (`executor.ts`, five of them) and the autonomy change are awaited. The
   * asymmetry cost three separate things:
   *
   *  a crash        `append` is async and there was no `unhandledRejection`
   *                 handler, so Node's default since v15 applies: throw. A failed INSERT
   *                 on this path — Postgres restarting, a lock timeout, the
   *                 container stopping mid-write — took the whole backend down.
   *  a silent loss  if it did not crash: the proposal marked sent, the counter
   *                 incremented, the seller told it went, and no ledger entry.
   *                 The ledger exists to answer what this copilot and this
   *                 seller actually did.
   *  a flaky test   `room-rules.test.ts` slept 100 ms hoping the write landed,
   *                 and under parallel load it sometimes had not.
   *
   * `reply_sent` is required: see `send`, which lets the failure through. A
   * failed `reply_blocked` write is recorded and swallowed, because losing the
   * log of a block must not also lose the block.
   */
  private async record(
    kind: "reply_blocked" | "reply_sent",
    actor: string,
    summary: string,
    detail: Record<string, unknown>,
    required: boolean,
  ): Promise<void> {
    try {
      await this.d.audit.append(kind, actor, summary, detail);
    } catch (e) {
      const err = errText(e);
      logWarn("audit.append_failed", { kind, showId: this.d.repo.showId, required, err });
      void recordEvent({
        showId: this.d.repo.showId,
        kind: "audit.append_failed",
        level: "error",
        detail: { auditKind: kind, required, err },
      });
      if (required) throw e;
    }
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

  /**
   * What would it say, if a buyer asked this right now?
   *
   * The same retrieval, the same composer, the same six guards, against the
   * catalog as it stands — and nothing is sent, queued, cached or counted. A
   * guardrail edit used to be testable only on a live buyer, which is the worst
   * possible place to discover that a regex blocks every reply.
   */
  async dryRun(question: string): Promise<{
    question: string;
    answer: string;
    evidence: Evidence[];
    guards: ReplyProposal["guards"];
    verdict: ReplyProposal["verdict"];
    confidence: number;
    abstained: boolean;
    latencyMs: number;
  }> {
    const started = Date.now();
    const show = await this.d.repo.show();
    const r = this.d.retriever.retrieve(question, { pinnedId: show.pinnedListingId });
    this.addHostFacts(question, r);

    const p = await this.persona();
    const { draft } = await this.composer.draft(
      {
        show,
        pinned: show.pinnedListingId ? await this.d.repo.listing(show.pinnedListingId) : null,
        context: this.d.showContext.current(),
        seller: this.d.seller?.() ?? null,
        persona: p?.persona ?? null,
        styleRef: p ? styleRef(question, p.voice) : null,
        facts: r.facts,
        abstain: r.abstain,
        viaAnaphora: r.slots.viaAnaphora,
      },
      "dry-run",
      question,
    );

    const [listings, policies] = await Promise.all([this.d.repo.listings(), this.d.repo.policies()]);
    const chain = runChain(
      {
        draft,
        question,
        facts: r.facts,
        factById: new Map(r.facts.map((f) => [f.factId, f])),
        currentListings: new Map(listings.map((l) => [l.id, l])),
        slots: r.slots,
        policies,
        surface: capabilitiesOf(show.source),
        community: r.facts.filter((f) => f.corpus === "community"),
      },
      { evidenceQuality: r.evidence[0]?.score ?? 0, abstained: r.abstain },
    );

    return {
      question,
      answer: draft.answer,
      evidence: r.evidence,
      guards: chain.guards,
      verdict: chain.verdict,
      confidence: chain.confidence,
      abstained: r.abstain,
      latencyMs: Date.now() - started,
    };
  }

  /** Keep the working set bounded: a long show asks thousands of questions
   *  and every one of them used to live in memory (and in every `hello`).
   *  Settled proposals beyond the newest 400 are dropped; the record in
   *  Postgres is the durable copy. */
  /**
   * What the host just said, as citable evidence beside the catalog's facts.
   * Only utterances that share a content word or a number with the question,
   * from the last two minutes, never more than three. A question the catalog
   * could not ground but the host just answered is no longer an abstention.
   */
  private addHostFacts(question: string, r: RetrievalResult): void {
    const segs = this.d.showContext.recent(120_000);
    if (!segs.length) return;
    const hf = hostFacts(question, segs);
    if (!hf.length) return;
    for (const f of hf) {
      if (r.facts.some((x) => x.factId === f.factId)) continue;
      r.facts.push(f);
      r.evidence.push(toEvidence(f, 0.6));
    }
    if (r.abstain) {
      r.abstain = false;
      r.mode = "hybrid";
    }
  }

  private evict(): void {
    if (this.proposals.size <= 400) return;
    const settled = [...this.proposals.values()]
      .filter((p) => p.status === "sent" || p.status === "auto_sent" || p.status === "dismissed" || p.status === "blocked")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const p of settled.slice(0, this.proposals.size - 400)) {
      this.proposals.delete(p.id);
      this.grounding.delete(p.id);
    }
    if (this.seenActionKeys.size > 2000) this.seenActionKeys = new Set([...this.seenActionKeys].slice(-1000));
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
        // The ladder decided to act without asking. A swallowed failure here
        // is the worst kind this file can produce: the seller is told the
        // copilot is acting on their behalf, the listing does not change, and
        // nothing anywhere says the commit refused. Still swallowed — one
        // failed action must not stop the loop evaluating the next — but no
        // longer silent.
        await this.d.executor.approve(action.id, "copilot").catch((e) => {
          logSwallowed("action.auto_commit_failed", e, {
            showId: this.d.repo.showId, actionId: action.id, kind: p.kind,
          });
          void recordEvent({
            showId: this.d.repo.showId,
            kind: "action.auto_commit_failed",
            level: "error",
            detail: { actionId: action.id, action: p.kind, why: errText(e) },
          });
        });
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
      delivered: c.delivered,
      handedOff: c.handedOff,
      autoSent: c.autoSent,
      dismissed: c.dismissed,
      blocked: c.blocked,
      guardBlocks: { ...c.guardBlocks },
      latency: this.latency.percentiles(),
      cacheHitRate: this.latency.cacheHitRate,
      // Answered means the buyer's question left this queue with an approved
      // answer on it — delivered by us where we can, handed to the operator
      // where we cannot. It has never meant anything stronger than that: on
      // every surface in this build the `sent` here is `handedOff`. Reading it
      // as "replies buyers received" is the misreading `delivered` exists to
      // make impossible.
      //
      // The console's live figure and the report's stored one are the same
      // function over the same counts (src/shows/metrics.ts), so the header a
      // seller watches during the show cannot disagree with the report they
      // read after it.
      answeredRate: answeredRate({ sent: c.sent, questionsAsked: c.admitted }),
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
