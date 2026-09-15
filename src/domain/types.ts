// The wire contract. These types are the SAME shapes the operator console
// consumes in `src/lib/types.ts` — the frontend copy is generated from this one.
// Money is always integer CENTS; timestamps are always ISO-8601 strings.

export type AutonomyLevel =
  | "L0_OBSERVE" | "L1_SUGGEST" | "L2_ONE_TAP" | "L3_AUTO_REPLY" | "L4_AUTO_ACT";

export type ChatIntent =
  | "price_question" | "availability" | "sizing" | "shipping" | "returns"
  | "authenticity" | "comparison" | "discount_request" | "hype" | "other";

/**
 * What KIND of utterance a comment is — the speech act, not the topic.
 *
 * Deliberately the same vocabulary Whissle's metadata head uses for the HOST's
 * audio, so the two are comparable on one axis: the host informing and a buyer
 * querying are the same shape of fact about a conversation, measured two
 * different ways. Without this the classifier had only a topic axis, and a
 * topic cue fires just as happily on a statement — "Offer from Lesbie 👆"
 * matched `offer` and became a discount QUESTION nobody asked.
 */
export type SpeechAct = "query" | "command" | "inform" | "greeting" | "wish" | "other";

export type GuardName = "price" | "availability" | "policy" | "claim_grounding" | "tone" | "pii";
export type Verdict = "allow" | "revise" | "block";

export interface ShowState {
  id: string;
  title: string;
  sellerHandle: string;
  startedAt: string;
  viewers: number;
  pinnedListingId: string | null;
  lotQueue: string[];
  autonomyLevel: AutonomyLevel;
  undoWindowS: number;
  /** Where buyer chat comes from. */
  source: "simulated" | "ebaylive";
  /** The eBay Live event id, when source is "ebaylive". */
  externalId: string | null;
  /** A show we do not own: every write action is refused at preflight. */
  readOnly: boolean;
  status: "live" | "ended";
}

export interface Listing {
  id: string;
  sku: string;
  title: string;
  brand: string;
  model: string;
  colorway: string;
  size: string;
  condition: "DS" | "VNDS" | "USED";
  priceCents: number;
  /** The seller's hard floor. No markdown may cross it — enforced in preflight. */
  floorPriceCents: number;
  costCents: number;
  qty: number;
  soldThisShow: number;
  views: number;
  state: "draft" | "queued" | "live" | "ended";
  pinned: boolean;
  /** Bumped on EVERY write. This is what makes stale grounding detectable:
   *  evidence carries the version it was read at, and PriceGuard compares. */
  version: number;
  imageUrl: string;
  shippingProfile: string;
  authenticated: boolean;
  certId: string | null;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  author: string;
  text: string;
  at: string;
  /** WHAT the comment is about. */
  intent: ChatIntent | null;
  /** WHAT KIND of utterance it is — same axis as the host's voice metadata. */
  speechAct: SpeechAct | null;
  /** Did it pass the relevance gate + rate cap and become a candidate for reply? */
  admitted: boolean;
  dropReason?: string;
  proposalId?: string;
}

export type EvidenceSource = "listing" | "policy" | "catalog" | "qa" | "market";

export interface Evidence {
  /** Stable, addressable id: `listing:lst_aj1_10#price`, `policy:shipping#intl`, … */
  factId: string;
  source: EvidenceSource;
  label: string;
  text: string;
  score: number;
  /** Present on listing-derived facts. The staleness key. */
  listingVersion?: number;
}

export interface GuardResult {
  guard: GuardName;
  verdict: Verdict | "n/a";
  reason?: string;
  detail?: { expected?: string; found?: string };
}

export interface Claim { text: string; factId: string; supported: boolean }

export interface SpanBreakdown {
  admitMs: number;
  classifyMs: number;
  retrieveMs: number;
  composeMs: number;
  guardMs: number;
  repairMs: number;
  totalMs: number;
  cacheHit: boolean;
  budgetMs: number;
  overBudget: boolean;
}

export type ProposalStatus =
  | "drafting" | "ready" | "needs_review" | "blocked" | "sent" | "auto_sent" | "dismissed";

export interface ReplyProposal {
  id: string;
  message: ChatMessage;
  status: ProposalStatus;
  draft: string;
  claims: Claim[];
  evidence: Evidence[];
  guards: GuardResult[];
  verdict: Verdict;
  confidence: number;
  repaired: boolean;
  spans: SpanBreakdown;
  createdAt: string;
  sentText?: string;
}

export type ActionKind =
  | "push_listing" | "swap_pinned" | "markdown_price" | "adjust_stock" | "end_listing";

export interface PreflightCheck { name: string; ok: boolean; detail: string }

export type ActionStatus =
  | "proposed" | "preflight_failed" | "approved" | "committing"
  | "committed" | "failed" | "rolled_back" | "rejected";

export interface ActionProposal {
  id: string;
  kind: ActionKind;
  listingId: string;
  listingTitle: string;
  summary: string;
  rationale: string;
  params: Record<string, unknown>;
  /** Prior-state snapshot captured at preflight — the ONLY source for rollback. */
  before: Record<string, unknown>;
  status: ActionStatus;
  preflight: { ok: boolean; checks: PreflightCheck[] };
  idempotencyKey: string;
  undoableUntil: string | null;
  error?: string;
  createdAt: string;
}

export type AuditKind =
  | "action_proposed" | "action_preflight_failed" | "action_committed"
  | "action_failed" | "action_rolled_back" | "reply_sent" | "reply_blocked"
  | "autonomy_changed"
  // The seller's own spend cap stopping the copilot. It belongs in the chain
  // for the same reason a block does: it changed what the copilot did.
  | "budget_cap_reached"
  // The operator saying a sent reply was wrong. In the chain because "who said
  // so, and when" is exactly what the chain is for — and because this is the
  // only source the accuracy number has.
  | "reply_flagged_wrong"
  // The operator naming the lot on screen. Placeholder titles are guessed from
  // speech and camera; when that guesses wrong, every answer after it is wrong,
  // and a human correction is the one input that fixes all of them at once.
  | "lot_corrected";

export interface AuditEntry {
  seq: number;
  at: string;
  hash: string;
  prevHash: string;
  kind: AuditKind;
  actorType: "copilot" | "seller" | "system";
  summary: string;
  detail: Record<string, unknown>;
}

export interface Metrics {
  proposals: number;
  sent: number;
  autoSent: number;
  dismissed: number;
  blocked: number;
  guardBlocks: Record<GuardName, number>;
  latency: { p50: number; p95: number; p99: number; budgetMs: number; breaches: number };
  cacheHitRate: number;
  answeredRate: number;
  actionsCommitted: number;
  actionsRolledBack: number;
}

/**
 * An acoustic distribution from Whissle's metadata head.
 *
 * Never a bare label. The gateway's own guidance is explicit — accuracy on
 * low-arousal states tops out around 63%, so a single label presented as fact is
 * a confident lie. Render the distribution, and render FLIPS (when the top read
 * changed) rather than a needle that twitches.
 */
export interface SignalDistribution {
  topLabel: string;
  topP: number;
  topK: { label: string; p: number }[];
  /** The top label differs from the last one this stream reported. */
  changed: boolean;
  prevLabel: string | null;
  /** How long the current top label has been on top. 0 on a flip. */
  heldMs: number | null;
  /** Running count of top-label changes this session. */
  flips: number | null;
  trusted: boolean;
}

export interface TranscriptSegment {
  showId: string;
  text: string;
  emotion: SignalDistribution | null;
  intent: SignalDistribution | null;
  speechRate: number | null;
  at: string;
  /**
   * Loudness envelope for this utterance — RMS per ~100ms, 0..1.
   *
   * Measured in the bridge off the same audio track it publishes, because the
   * transcript alone cannot show a pause, an emphasis or a room going quiet,
   * and those are exactly what an operator scanning a show reads for. Not a
   * spectrogram: we have the time-domain signal, not an FFT, and drawing bins
   * we never computed would be a picture of nothing.
   */
  levels: number[] | null;
}

/**
 * A slice of the show's loudness, independent of any utterance.
 *
 * The transcript only exists where words were recognised; the strip has to keep
 * moving through silence too, or a quiet stretch looks like a dead capture.
 */
export interface AudioLevels {
  showId: string;
  at: string;
  /** RMS per ~100ms window, 0..1. */
  levels: number[];
}

export interface ShowContext {
  currentTopic: string;
  listingInFocus: string | null;
  recentPoints: string[];
  /** The LLM's read of the host's manner, summarised from the transcript TEXT. */
  tone: string | null;
  /**
   * The host's voice right now, from Whissle's acoustic metadata head.
   *
   * Distinct from `tone` on purpose: `tone` is inferred from what was SAID,
   * this is measured from HOW it was said. Carried as a distribution and used
   * only when the head itself reports it as trusted — the gateway's own note
   * puts accuracy on low-arousal states around 63%, so a bare label presented
   * as fact would be a confident coin flip.
   */
  voice: SignalDistribution | null;
  /**
   * A one-line reading of what is ON SCREEN, from the show's video.
   *
   * Show context, never provenance. The host holding an item up answers "what's
   * that one?" and nothing else in the system can — but a frame cannot
   * establish a price, a quantity or a certificate, so this is never citable as
   * a grounding fact. See `visual` in compose/prompts.ts.
   */
  onScreen: { text: string; at: string } | null;
  updatedAt: string;
}

/**
 * What a comparable price IS, which is not a detail.
 *
 * `sold` is what someone paid. `asking` is what someone is hoping for. They
 * move differently and a seller prices against them differently — asking prices
 * skew high because the optimistic listings are the ones still sitting there.
 * eBay's sold data (Marketplace Insights) is a limited-release API this
 * application is not approved for, so live comps are asking prices, and every
 * surface that renders one says which it is looking at rather than letting a
 * field name called `soldPriceCents` decide.
 */
export type CompBasis = "sold" | "asking";

export interface Comp {
  title: string;
  /** What this comparable is priced at, on the basis named below. */
  priceCents: number;
  /** When it sold. Null for an active listing, which has not. */
  soldAt: string | null;
  condition: string;
  size: string;
  basis: CompBasis;
  /** The listing itself, when it is one we can link to. */
  url?: string;
}

export interface ResearchCard {
  query: string;
  listingId: string | null;
  headline: string;
  comps: Comp[];
  medianCents: number;
  /** What `medianCents` is a median OF. "none" when nothing was found — which
   *  is a finding, not a zero. */
  marketBasis: CompBasis | "none";
  /** Where the comps came from, said out loud on the card. */
  marketSource: "ebay-sold" | "ebay-active" | "seeded" | "checking" | "none";
  suggestion: string;
  specDiff?: { attribute: string; ours: string; theirs: string }[];
  latencyMs: number;
  evidence: Evidence[];
}

/** A policy clause — the grounding source for shipping/returns/authenticity claims. */
export interface PolicyClause {
  id: string;
  topic: "shipping" | "returns" | "authenticity" | "discount" | "tone" | "prohibited";
  title: string;
  body: string;
}
