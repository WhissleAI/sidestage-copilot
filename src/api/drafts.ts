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

import { capabilitiesOf, SURFACE_CAPABILITIES, type SurfaceId } from "../surfaces/types.js";
import type { Queryable } from "../db/pg.js";
import { queueCounts, type DraftQueues } from "./home.js";
import type {
  Evidence, GuardResult, ProposalStatus, ReplyProposal, ThreadView, Verdict,
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
 * and this one clears" — is not reported, because nothing in the system knows
 * it. A proposal carries ONE guard row: the one the draft that reached the
 * seller earned. The repair pass rewrites the draft and re-runs the chain, and
 * the pre-repair result is not kept anywhere — so a rule that held the first
 * attempt leaves no trace to report. `rulesOf` reads the final row and can only
 * ever say `applied` or `blocked`. A field the UI reads and the server can
 * never set is a promise the UI is making on our behalf.
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
  /**
   * The conversation this answers: the opening post, then the branch down to
   * the comment, and the rules of the room.
   *
   * Absent on a follow-up, which is one buyer's question out of a show that
   * ended and has no branch above it, and on a post, which opens its own
   * thread. The card draws what it is given.
   */
  thread?: ThreadView;
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
  // The rules the guard chain was actually handed, which since the per-room
  // constraint input is where they live (`ReplyProposal.rules`). Evidence is
  // the fallback: a surface that grounds in a community corpus puts them there,
  // and so did every proposal written before rules had a field of their own.
  const rules = p.rules?.length ? p.rules : p.evidence;
  return rules
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
        // The permalink the poller sent, carried through `onMessage` and the
        // pipeline. Null when the surface gave us none — never a link we
        // assembled ourselves, which would open the wrong comment.
        url: p.message.url ?? null,
      },
      draft: p.sentText ?? p.draft,
      createdAt: p.createdAt,
      ...(p.thread ? { thread: p.thread } : {}),
      status,
      // When it actually went. Hard-coded null until `Pipeline.send` stamped
      // one, which is why the Sent list showed a time for a follow-up and a
      // blank beside a Reddit draft in the same list.
      sentAt: p.sentAt ?? null,
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

// ── the durable half ────────────────────────────────────────────────────────

/**
 * Every async draft this account has, read from the table rather than from a
 * runtime.
 *
 * The queue used to be built from live in-memory pipelines only, so a deploy, a
 * detach, or a subreddit going private emptied the Drafts page of every reply
 * written for that room — while the rows sat in `reply_proposals` the whole
 * time, written by `SessionRecord.recordProposal`. A draft is work waiting for
 * a person; it does not stop being that because the process that wrote it
 * restarted.
 *
 * Tenancy is in the statement: the account's own sessions, plus the rows that
 * predate the ownership column and belong to nobody — the same rule
 * `ShowRegistry.list` applies, so the two halves of the queue cannot disagree
 * about what an operator may see.
 *
 * `drafting` rows never reach here (`recordProposal` does not write them) and
 * the cap is a page of the newest, because a queue is a thing a person works
 * through rather than an archive.
 */
export async function persistedAsyncDrafts(
  q: Queryable,
  accountId: string,
  limit = 200,
): Promise<SurfaceDraft[]> {
  const asyncSurfaces = ASYNC_SURFACES();
  if (!asyncSurfaces.length) return [];
  const { rows } = await q.query<PersistedRow>(
    `${STORED_SELECT}
      WHERE (s.owner_account_id = $1 OR s.owner_account_id IS NULL)
        AND COALESCE(s.surface, s.source) = ANY($2)
      ORDER BY p.at DESC
      LIMIT $3`,
    [accountId, asyncSurfaces, limit],
  );
  return rows.flatMap((r) => {
    const d = toStoredDraft(r);
    return d ? [d] : [];
  });
}

/** One row of `reply_proposals`, as the card the queue renders. Null for a
 *  status that is not a draft yet — `drafting` is never written, but a row is
 *  data from a database and this is the one place that decides. */
function toStoredDraft(r: PersistedRow): SurfaceDraft | null {
  const status = STATUS[r.status as ProposalStatus];
  if (!status) return null;
  const origin = originOfSession({
    showId: r.show_id, source: r.surface as SurfaceId, sellerHandle: r.seller_handle,
    title: r.title, externalId: r.external_id,
  } as ShowSummary);
  // The room this DRAFT was written in, when the session spans several.
  const room = r.room?.trim() || origin.label;
  const rules = rulesOf({
    guards: r.guards ?? [], evidence: r.evidence ?? [], rules: r.rules ?? undefined,
  } as ReplyProposal);
  return {
    id: r.id,
    surface: r.surface as SurfaceId,
    origin: { ...origin, label: room },
    room,
    sessionId: r.show_id,
    question: { author: r.author, text: r.question, at: r.at, url: r.url ?? null },
    draft: r.sent_text ?? r.draft,
    createdAt: r.at,
    status,
    sentAt: r.sent_at ?? null,
    ...(r.thread ? { thread: r.thread } : {}),
    evidence: r.evidence ?? [],
    guards: r.guards ?? [],
    verdict: r.verdict as Verdict,
    confidence: r.confidence,
    ...(rules.length ? { rules } : {}),
  };
}

/** One stored draft, by the id the queue gave it. Scoped in the statement: a
 *  stranger's draft is not found rather than refused, which is the answer that
 *  does not confirm it exists. */
export async function storedDraft(
  q: Queryable,
  accountId: string,
  id: string,
): Promise<SurfaceDraft | null> {
  const { rows } = await q.query<PersistedRow>(
  `${STORED_SELECT}
    WHERE (s.owner_account_id = $1 OR s.owner_account_id IS NULL)
      AND COALESCE(s.surface, s.source) = ANY($2)
      AND p.id = $3
    LIMIT 1`,
  [accountId, ASYNC_SURFACES(), id],
  );
  return rows[0] ? toStoredDraft(rows[0]) : null;
}

/** The async surfaces a session can be open on. `dm` is the follow-up inbox,
 *  which is its own table and its own half of the queue. */
const ASYNC_SURFACES = (): SurfaceId[] =>
  (Object.keys(SURFACE_CAPABILITIES) as SurfaceId[]).filter(
  (id) => id !== "dm" && capabilitiesOf(id).tempo === "async",
  );

const STORED_SELECT = `SELECT p.show_id, p.id, p.author, p.question, p.draft, p.sent_text, p.status,
          p.verdict, p.confidence, p.guards, p.evidence, p.rules, p.thread,
          p.at, p.sent_at, p.url, p.room,
          s.title, s.seller_handle, s.external_id,
          COALESCE(s.surface, s.source) AS surface
     FROM reply_proposals p
     JOIN shows s ON s.id = p.show_id`;

/**
 * The operator pasted a RESTORED draft in themselves.
 *
 * The same claim `Pipeline.send` records, for a draft whose runtime is gone —
 * and the same two refusals, because they are properties of the draft rather
 * than of the process that happens to be holding it: a blocked reply cannot be
 * sent, and a moment that has already been stamped does not move. Nothing here
 * delivers anything; there is no path from this module to any surface.
 */
export async function markStoredSent(
  q: Queryable,
  accountId: string,
  id: string,
): Promise<{ draft: SurfaceDraft | null; refused?: "blocked" | "dismissed"; already?: boolean }> {
  const existing = await storedDraft(q, accountId, id);
  if (!existing) return { draft: null };
  // Already gone: hand back what was sent. The same answer `Pipeline.send`
  // gives, and for the same reason — a retried click must not write a second
  // entry into a ledger of things that happened.
  if (existing.status === "sent") return { draft: existing, already: true };
  if (existing.status === "blocked") return { draft: existing, refused: "blocked" };
  if (existing.status === "dismissed") return { draft: existing, refused: "dismissed" };
  await q.query(
  `UPDATE reply_proposals p
      SET status = 'sent',
          sent_text = COALESCE(p.sent_text, p.draft),
          sent_at = COALESCE(p.sent_at, $3),
          decided_at = COALESCE(p.decided_at, $3)
     FROM shows s
    WHERE s.id = p.show_id AND p.id = $2
      AND (s.owner_account_id = $1 OR s.owner_account_id IS NULL)
      AND p.status NOT IN ('blocked', 'dismissed')`,
  [accountId, id, new Date().toISOString()],
  );
  return { draft: await storedDraft(q, accountId, id) };
}

/** Dismiss a restored draft. Idempotent, and it never un-sends one. */
export async function dismissStored(
  q: Queryable,
  accountId: string,
  id: string,
): Promise<SurfaceDraft | null> {
  const existing = await storedDraft(q, accountId, id);
  if (!existing) return null;
  if (existing.status === "sent") return existing;
  await q.query(
  `UPDATE reply_proposals p
      SET status = 'dismissed', decided_at = COALESCE(p.decided_at, $3)
     FROM shows s
    WHERE s.id = p.show_id AND p.id = $2
      AND (s.owner_account_id = $1 OR s.owner_account_id IS NULL)
      AND p.status NOT IN ('sent', 'auto_sent')`,
  [accountId, id, new Date().toISOString()],
  );
  return storedDraft(q, accountId, id);
}

interface PersistedRow {
  show_id: string; id: string; author: string; question: string; draft: string;
  sent_text: string | null; status: string; verdict: string; confidence: number;
  guards: GuardResult[] | null; evidence: Evidence[] | null; rules: Evidence[] | null;
  thread: ThreadView | null; at: string; sent_at: string | null;
  url: string | null; room: string | null;
  title: string; seller_handle: string; external_id: string | null; surface: string;
}

export interface QueueInput {
  /** Sessions on air, in registry order. Filtered to async surfaces here. */
  sessions: { summary: ShowSummary; proposals: ReplyProposal[] }[];
  /** Async drafts read from `reply_proposals` — every room this account has
   *  written for, whether or not a runtime is holding it (`persistedAsyncDrafts`). */
  persisted?: SurfaceDraft[];
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
  // A draft held by a live runtime is the fresher copy of the same row, so the
  // durable half is everything the runtimes are not already holding — by
  // proposal id, not by session, because a re-attached room keeps the drafts
  // its previous session wrote.
  const inMemory = new Set(bySession.flatMap((s) => s.drafts).map((d) => d.id));
  const stored = (i.persisted ?? []).filter((d) => !inMemory.has(d.id));
  const inbox = i.followups.map((f) => draftFromFollowUp(f.row, f.sessionTitle));

  const entries = [
    ...bySession.map((s) => ({
      surface: s.surface,
      count: s.drafts.filter((d) => d.status === "open").length,
    })),
    ...storedEntries(stored),
    { surface: "dm" as SurfaceId, count: inbox.filter((d) => d.status === "open").length },
  ];

  const drafts = [...bySession.flatMap((s) => s.drafts), ...stored, ...inbox].sort(
    (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
  );

  return { waiting: queueCounts(entries), drafts };
}

/**
 * The per-surface counts of the durable half, in first-appearance order.
 *
 * `/api/home` and `/api/drafts` both hand these to `queueCounts`, which is what
 * keeps `now.drafts` deep-equal to `waiting` — the same function over the same
 * entries in the same order, rather than the same arithmetic done twice.
 */
export function storedEntries(stored: SurfaceDraft[]): { surface: SurfaceId; count: number }[] {
  return stored.map((d) => ({ surface: d.surface, count: d.status === "open" ? 1 : 0 }));
}
