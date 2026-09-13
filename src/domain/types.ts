// The wire contract. These types are the SAME shapes the operator console
// consumes in `src/lib/types.ts` — the frontend copy is generated from this one.
// Money is always integer CENTS; timestamps are always ISO-8601 strings.

export type AutonomyLevel =
  | "L0_OBSERVE" | "L1_SUGGEST" | "L2_ONE_TAP" | "L3_AUTO_REPLY" | "L4_AUTO_ACT";

export type ChatIntent =
  | "price_question" | "availability" | "sizing" | "shipping" | "returns"
  | "authenticity" | "comparison" | "discount_request" | "hype" | "other";

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
  intent: ChatIntent | null;
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
  | "autonomy_changed";

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

export interface ShowContext {
  currentTopic: string;
  listingInFocus: string | null;
  recentPoints: string[];
  tone: string | null;
  updatedAt: string;
}

export interface Comp {
  title: string;
  soldPriceCents: number;
  soldAt: string;
  condition: string;
  size: string;
}

export interface ResearchCard {
  query: string;
  listingId: string | null;
  headline: string;
  comps: Comp[];
  medianCents: number;
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
