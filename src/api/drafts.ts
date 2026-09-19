// The drafts queue: everything waiting on the operator, across every surface
// that cannot deliver.
//
// ── why this file exists ────────────────────────────────────────────────────
//
// A draft-only surface has no console, because it has no session to sit in
// front of. What it has is a queue, and until now that queue was two queues in
// two shapes in two places: the follow-up inbox is a table
// (`src/surfaces/dm/drafts.ts`), and a Reddit draft is a `ReplyProposal` in a
// live runtime's pipeline, in memory. The Drafts page read `/api/followups`,
// which is one of them — so a Reddit draft written three minutes ago was
// reachable only through the console of a session the page never links to, and
// the "drafts waiting for you" count on home was counting something the
// destination it links to could not show.
//
// A count on home that disagrees with the list it links to is worse than no
// count, so the count and the list are built from ONE definition of waiting:
//
//   · which sessions contribute — the ones on air whose surface is `async`,
//     read off the same registry list, with the same tenancy filter;
//   · which of their proposals are waiting — `isWaiting`, which is also what
//     `ShowSummary.awaiting` is counted with (src/shows/registry.ts), so the
//     two cannot drift;
//   · the follow-up inbox's `draft` rows, which are the `dm` surface.
//
// `queueCounts` (src/api/home.ts) then turns the same entries into the same
// `{ total, bySurface }` for both endpoints, in the same order, so
// `GET /api/drafts` → `waiting` is deep-equal to `GET /api/home` →
// `now.drafts` rather than merely equal by arithmetic.
//
// ── nothing here sends anything ─────────────────────────────────────────────
//
// This module reads. Marking a draft sent records a human's claim that they
// pasted it somewhere themselves, which is the whole product on these surfaces
// — see docs/SURFACES.md. There is no delivery path on any surface in here and
// adding one to Reddit would have to get past the adapter's `delivery`
// constant, the missing `post_reply` in its action list, and preflight.

import { capabilitiesOf, type SurfaceId } from "../surfaces/types.js";
import { queueCounts, type DraftQueues } from "./home.js";
import type {
  Evidence, GuardResult, ProposalStatus, ReplyProposal, Verdict,
} from "../domain/types.js";
import type { ShowSummary } from "../shows/registry.js";
import type { FollowUpRow } from "../surfaces/dm/drafts.js";

/**
 * Where a draft is in the operator's hands.
 *
 * `open` is the only one that counts as waiting: it is the number home shows
 * and the number the page's first section holds. `blocked` is carried rather
 * than hidden — a guard held it, there is nothing to send, and an operator who
 * cannot see that concludes the copilot simply did not answer.
 */
export type DraftStatus = "open" | "sent" | "dismissed" | "blocked";

/**
 * What the operator calls the place this came from.
 *
 * The two kinds are genuinely different things and the queue must not pretend
 * otherwise: a Reddit draft comes out of a ROOM that is still being watched, a
 * follow-up comes out of a SESSION that ended hours ago. `label` is what a
 * person would say out loud — `r/mechmarket`, or the session's title. `id` is
 * the machine's name for the same thing, kept beside it rather than instead of
 * it, because the old queue showed `ebay_47tK1SX0VsiHEXN1` where the other one
 * showed `r/mechmarket`.
 */
export interface DraftOrigin {
  kind: "room" | "session";
  id: string;
  label: string;
}

/**
 * One rule of the room, and what it did to this draft.
 *
 * Two effects, not three. `would_block` — "the rule an earlier draft tripped
 * and this one clears" — cannot happen in this system and is not reported:
 * `runChain` never returns `revise` (guardrails/chain.ts says so in a comment
 * and in code), so the pipeline's single repair pass is unreachable, so there
 * is never an earlier draft for a rule to have tripped. A field the UI reads
 * and the server can never set is a promise the UI is making on our behalf.
 */
export interface AppliedRule {
  factId: string;
  label: string;
  text: string;
  effect: "applied" | "blocked";
  /** The guard's own words, on the rule that held it. Null on the others. */
  reason: string | null;
}

/**
 * A reply we wrote and will not send.
 *
 * `surface` is the discriminator. Everything after `sentAt` is optional
 * because the two sources genuinely know different amounts: a follow-up is a
 * draft the guards ALREADY cleared and the table keeps no evidence beside it,
 * while a Reddit draft carries its citations, its guard row and the rules that
 * were in force. A field that is absent must be drawn as absent — a follow-up
 * rendered with `confidence: 0` would be a measurement nobody made.
 */
export interface SurfaceDraft {
  id: string;
  surface: SurfaceId;
  origin: DraftOrigin;
  /** `origin.label`, flat, because that is what the card prints. */
  room: string;
  /** The session this draft belongs to: a live watch, or the show a follow-up
   *  came out of. Present on both so a client never has to guess. */
  sessionId: string;
  question: { author: string; text: string; at: string; url: string | null };
  draft: string;
  createdAt: string;
  status: DraftStatus;
  sentAt: string | null;
  evidence?: Evidence[];
  guards?: GuardResult[];
  verdict?: Verdict;
  confidence?: number;
  rules?: AppliedRule[];
  styleRef?: { factId: string; text: string; label: string };
}

export interface DraftsQueue {
  /** Deep-equal to `/api/home` → `now.drafts`, by construction. */
  waiting: DraftQueues;
  drafts: SurfaceDraft[];
}

/**
 * Waiting on a human.
 *
 * One definition, imported by `ShowRegistry.list` for `ShowSummary.awaiting`
 * and by this queue for `status: "open"`. They were the same two statuses in
 * two places before, which is exactly the kind of agreement that survives
 * until somebody adds a third status.
 */
export const isWaiting = (p: { status: ProposalStatus }): boolean =>
  p.status === "ready" || p.status === "needs_review";

const STATUS: Partial<Record<ProposalStatus, DraftStatus>> = {
  ready: "open",
  needs_review: "open",
  blocked: "blocked",
  sent: "sent",
  auto_sent: "sent",
  dismissed: "dismissed",
  // `drafting` is deliberately absent: a proposal the model is still writing is
  // not yet a draft, and putting an empty card in the queue is how the console
  // used to render blank rows.
};

/**
 * Host handles that are not a name.
 *
 * `ShowRegistry.attach` falls back to a literal "eBay Live seller" when a
 * target carries no handle, which is fine on a stream and is not the name of a
 * room. A Reddit thread link without its subreddit is exactly that case.
 */
const PLACEHOLDER_HANDLES = new Set(["ebay live seller", "seller", ""]);

/** What an operator calls the room a live async session is watching. */
export function originOfSession(s: ShowSummary): DraftOrigin {
  const handle = (s.sellerHandle ?? "").trim();
  const named = PLACEHOLDER_HANDLES.has(handle.toLowerCase()) ? "" : handle;
  return {
    kind: "room",
    id: s.externalId ?? s.showId,
    // The handle is the room as the adapter parsed it — `r/mechmarket`. Falling
    // back to the title rather than to the id: "Reddit t3_1abc2d" is at least a
    // sentence, and the id is already right there in `origin.id`.
    label: named || s.title || s.externalId || s.showId,
  };
}

/**
 * The rules of the room, as they applied to THIS draft.
 *
 * Read off the proposal, never recomputed. The community facts the guard chain
 * saw are the ones retrieval put in `evidence` (`corpus: "community"`), and the
 * one that held it is named by `communityRuleGuard` in `detail.expected`. A
 * blocking factId we cannot find among the evidence is left unmatched rather
 * than invented: the guard row is returned beside this and says the rest.
 */
export function rulesOf(p: ReplyProposal): AppliedRule[] {
  const held = p.guards.find((g) => g.guard === "community_rule" && g.verdict === "block");
  const heldId = held?.detail?.expected ?? null;
  return p.evidence
    .filter((e) => e.corpus === "community")
    .map((e) => ({
      factId: e.factId,
      label: e.label,
      text: e.text,
      effect: (e.factId === heldId ? "blocked" : "applied") as AppliedRule["effect"],
      reason: e.factId === heldId ? held?.reason ?? null : null,
    }));
}

/** Every draft one live async session is holding, newest first. */
export function draftsFromSession(s: ShowSummary, proposals: ReplyProposal[]): SurfaceDraft[] {
  const origin = originOfSession(s);
  const out: SurfaceDraft[] = [];
  for (const p of proposals) {
    const status = STATUS[p.status];
    if (!status) continue;
    const rules = rulesOf(p);
    out.push({
      id: p.id,
      surface: s.source,
      origin,
      room: origin.label,
      sessionId: s.showId,
      question: {
        author: p.message.author,
        text: p.message.text,
        at: p.message.at,
        // The poller has the permalink and the runtime drops it on the way into
        // the pipeline (`onMessage` keeps id, author and text). Null is the
        // honest answer until that is carried through; a link we guessed at
        // would open the wrong comment.
        url: null,
      },
      draft: p.sentText ?? p.draft,
      createdAt: p.createdAt,
      status,
      sentAt: null,
      evidence: p.evidence,
      guards: p.guards,
      verdict: p.verdict,
      confidence: p.confidence,
      ...(rules.length ? { rules } : {}),
      ...(p.styleRef ? { styleRef: p.styleRef } : {}),
    });
  }
  return out;
}

/** One row of the follow-up inbox, as a draft. */
export function draftFromFollowUp(row: FollowUpRow, sessionTitle: string | null): SurfaceDraft {
  const origin: DraftOrigin = {
    kind: "session",
    id: row.showId,
    // The session it came out of, BY TITLE. This used to be the show id, so a
    // follow-up showed `ebay_47tK1SX0VsiHEXN1` in the same slot a Reddit draft
    // shows `r/mechmarket`. The id is the fallback only when the show row is
    // gone — a deleted session's follow-ups outlive it.
    label: sessionTitle?.trim() || row.showId,
  };
  return {
    id: row.id,
    surface: "dm",
    origin,
    room: origin.label,
    sessionId: row.showId,
    question: { author: row.buyer, text: row.question, at: row.createdAt, url: null },
    draft: row.draft,
    createdAt: row.createdAt,
    status: row.status === "draft" ? "open" : row.status,
    sentAt: row.sentAt,
    // No evidence, no guards, no confidence: a blocked follow-up is never
    // stored, so the row is a draft the chain already cleared and the table
    // keeps nothing else. Absent, not zero.
  };
}

export interface QueueInput {
  /** Sessions on air, in registry order. Filtered to async surfaces here. */
  sessions: { summary: ShowSummary; proposals: ReplyProposal[] }[];
  /** The account's inbox, with the title of the session each row came out of. */
  followups: { row: FollowUpRow; sessionTitle: string | null }[];
}

/**
 * The whole queue for one operator.
 *
 * The order of `waiting.bySurface` is the order `nowBand` builds it in — async
 * sessions in registry order, then `dm` — because the two are compared for
 * equality by a test and by anyone reading both payloads, and two orderings of
 * the same numbers is the kind of disagreement that costs an afternoon.
 */
export function draftQueue(i: QueueInput): DraftsQueue {
  const live = i.sessions.filter(
    (s) => s.summary.status === "live" && capabilitiesOf(s.summary.source).tempo === "async",
  );

  const bySession = live.map((s) => ({
    surface: s.summary.source,
    drafts: draftsFromSession(s.summary, s.proposals),
  }));
  const inbox = i.followups.map((f) => draftFromFollowUp(f.row, f.sessionTitle));

  const entries = [
    ...bySession.map((s) => ({
      surface: s.surface,
      count: s.drafts.filter((d) => d.status === "open").length,
    })),
    { surface: "dm" as SurfaceId, count: inbox.filter((d) => d.status === "open").length },
  ];

  const drafts = [...bySession.flatMap((s) => s.drafts), ...inbox].sort(
    (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
  );

  return { waiting: queueCounts(entries), drafts };
}
