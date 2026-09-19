// Turning a follow-up into something the seller can actually send.
//
// The one decision worth writing down here is what this file does NOT contain:
// a composer. A follow-up is a reply — to a real buyer, quoting real prices,
// about real stock — and the only thing that makes it different from the reply
// that should have gone out during the show is that it is three hours late. So
// it goes through `Pipeline.dryRun`: the same retrieval, the same seller voice,
// the same six guards against the catalog AS IT STANDS NOW.
//
// That last part is the reason a second composer would have been a bug rather
// than a duplication. Between the question and the follow-up the lot has very
// likely sold, and a standalone drafter working from the show record would
// cheerfully quote a price on something that is gone — which is precisely the
// failure `priceGuard` and `availabilityGuard` exist to catch. Running the
// stale question through the live guard chain is not an extra check; it is the
// only thing that makes a three-hour-old lead safe to answer.
//
// A draft the guards BLOCK is never stored. There is no status for it in the
// table and there should not be: the whole proposition is "ready to send from
// your own account", and a row that has to be explained before it can be used
// is not that. The build result says how many were dropped and why, so the
// number is visible rather than silently missing.

import { db as pgPool, type Pool } from "../../db/pg.js";
import type { Evidence, GuardResult, Verdict } from "../../domain/types.js";
import { getCatalog } from "../../shows/catalogs.js";
import { ShowRuntime } from "../../shows/runtime.js";
import type { ShowRecord } from "../../shows/record.js";
import type { SurfaceId } from "../types.js";
import { selectFollowUps, type FollowUp } from "./followups.js";

/** What `Pipeline.dryRun` answers. Declared structurally so a test can drive
 *  this file with the real guard chain and a stubbed model — which is how the
 *  rest of the suite draws the line (test/helpers.ts). */
export interface DryRunResult {
  question: string;
  answer: string;
  evidence: Evidence[];
  guards: GuardResult[];
  verdict: Verdict;
  confidence: number;
  abstained: boolean;
  latencyMs: number;
}

export interface Drafter {
  dryRun(question: string): Promise<DryRunResult>;
}

export type FollowUpStatus = "draft" | "sent" | "dismissed";

export interface FollowUpRow {
  id: string;
  showId: string;
  accountId: string;
  buyer: string;
  question: string;
  messageId: string | null;
  draft: string;
  status: FollowUpStatus;
  createdAt: string;
  sentAt: string | null;
  dismissedAt: string | null;
}

interface Row {
  id: string; show_id: string; account_id: string; buyer: string; question: string;
  message_id: string | null; draft: string; status: string;
  created_at: string; sent_at: string | null; dismissed_at: string | null;
}

const toRow = (r: Row): FollowUpRow => ({
  id: r.id,
  showId: r.show_id,
  accountId: r.account_id,
  buyer: r.buyer,
  question: r.question,
  messageId: r.message_id,
  draft: r.draft,
  status: r.status as FollowUpStatus,
  createdAt: new Date(r.created_at).toISOString(),
  sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
  dismissedAt: r.dismissed_at ? new Date(r.dismissed_at).toISOString() : null,
});

const COLUMNS =
  "id, show_id, account_id, buyer, question, message_id, draft, status, created_at, sent_at, dismissed_at";

/** The same columns, for the one statement that joins another table. */
const QUALIFIED = COLUMNS.split(", ").map((c) => `f.${c}`).join(", ");

/**
 * The inbox itself.
 *
 * Every method takes an account id and binds it into the statement, the way
 * `Repo` binds a show id and `SurfaceRooms` binds an account. A follow-up names
 * a real person and quotes what they said in somebody's show; the filter is not
 * something a call site gets to remember.
 */
export class FollowUpInbox {
  constructor(private d: Pool) {}

  async list(accountId: string, status?: FollowUpStatus | null): Promise<FollowUpRow[]> {
    const r = await this.d.query<Row>(
      `SELECT ${COLUMNS} FROM followups
        WHERE account_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC, buyer`,
      [accountId, status ?? null],
    );
    return r.rows.map(toRow);
  }

  /**
   * The inbox as the drafts queue reads it: every row, and the TITLE of the
   * session it came out of.
   *
   * The title is the join. A follow-up's origin is the show a buyer asked in,
   * and the queue prints it beside a Reddit draft's `r/mechmarket`; printing
   * `ebay_47tK1SX0VsiHEXN1` there told the operator nothing they could act on.
   * LEFT JOIN on purpose — deleting a session does not delete the people who
   * asked in it, and a follow-up whose show row is gone still has a draft in it
   * worth sending.
   */
  async queue(accountId: string): Promise<{ row: FollowUpRow; sessionTitle: string | null }[]> {
    const r = await this.d.query<Row & { session_title: string | null }>(
      `SELECT ${QUALIFIED}, s.title AS session_title
         FROM followups f LEFT JOIN shows s ON s.id = f.show_id
        WHERE f.account_id = $1
        ORDER BY f.created_at DESC, f.buyer`,
      [accountId],
    );
    return r.rows.map((x) => ({ row: toRow(x), sessionTitle: x.session_title }));
  }

  async forShow(accountId: string, showId: string): Promise<FollowUpRow[]> {
    const r = await this.d.query<Row>(
      `SELECT ${COLUMNS} FROM followups WHERE account_id = $1 AND show_id = $2 ORDER BY created_at, buyer`,
      [accountId, showId],
    );
    return r.rows.map(toRow);
  }

  /**
   * Write one follow-up, keyed on the buyer.
   *
   * Rebuilding a show's follow-ups is a thing an operator will do — the catalog
   * changed, a lot came back in stock — and it must not produce a second row
   * for the same person. A buyer the seller has already SENT to or dismissed is
   * left exactly as they are: the decision was theirs and a rebuild is not a
   * vote to reopen it.
   */
  async save(f: Omit<FollowUpRow, "createdAt" | "sentAt" | "dismissedAt" | "status">): Promise<FollowUpRow> {
    const r = await this.d.query<Row>(
      `INSERT INTO followups (id, show_id, account_id, buyer, question, message_id, draft)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (show_id, buyer) DO UPDATE SET
         question = EXCLUDED.question,
         message_id = EXCLUDED.message_id,
         draft = CASE WHEN followups.status = 'draft' THEN EXCLUDED.draft ELSE followups.draft END
       RETURNING ${COLUMNS}`,
      [f.id, f.showId, f.accountId, f.buyer, f.question, f.messageId, f.draft],
    );
    return toRow(r.rows[0]!);
  }

  async get(accountId: string, id: string): Promise<FollowUpRow | null> {
    const r = await this.d.query<Row>(
      `SELECT ${COLUMNS} FROM followups WHERE account_id = $1 AND id = $2`,
      [accountId, id],
    );
    return r.rows[0] ? toRow(r.rows[0]) : null;
  }

  /**
   * The human sent it, from their own account. We record the fact; we never
   * send anything.
   *
   * Idempotent, and the timestamp is stamped once. A console that double-fires
   * the button, or a seller who marks the same message twice an hour apart,
   * must not move the record of when it actually went — `sent_at` is evidence,
   * and evidence that a retry can rewrite is not evidence.
   */
  async markSent(accountId: string, id: string): Promise<FollowUpRow | null> {
    const r = await this.d.query<Row>(
      `UPDATE followups SET status = 'sent', sent_at = COALESCE(sent_at, now())
        WHERE account_id = $1 AND id = $2 AND status <> 'dismissed'
        RETURNING ${COLUMNS}`,
      [accountId, id],
    );
    // Already dismissed, or not theirs, or not there at all: fall back to a
    // scoped read so the caller can tell "no such follow-up" from "that one is
    // dismissed" without a second round trip.
    return r.rows[0] ? toRow(r.rows[0]) : this.get(accountId, id);
  }

  async dismiss(accountId: string, id: string): Promise<FollowUpRow | null> {
    const r = await this.d.query<Row>(
      `UPDATE followups SET status = 'dismissed', dismissed_at = COALESCE(dismissed_at, now())
        WHERE account_id = $1 AND id = $2
        RETURNING ${COLUMNS}`,
      [accountId, id],
    );
    return r.rows[0] ? toRow(r.rows[0]) : null;
  }
}

/** What a build did, including what it refused to write down. */
export interface BuildResult {
  showId: string;
  /** Buyers the selection rule picked out of the show record. */
  selected: number;
  /** Follow-ups now in the inbox for this show (including ones from before). */
  followups: FollowUpRow[];
  /** Drafted, then dropped by the guard chain — never stored. The reason is the
   *  guard's own, so "the 517 sold an hour ago" reaches the operator as itself. */
  guardedOut: { buyer: string; question: string; guard: string; reason: string }[];
  /** Drafted, and the catalog had nothing to say. Same fate, different cause. */
  abstained: { buyer: string; question: string }[];
}

/**
 * How many follow-ups one call will draft.
 *
 * Each one is a gateway round trip, and the biggest show in this database asked
 * 187 questions. A cap keeps a single HTTP request from turning into three
 * minutes of LLM calls; the selection is ordered by worth, so the ones that
 * survive the cap are the ones most likely to close.
 */
const MAX_PER_BUILD = 50;
/** Below the gateway's shared 8-wide LLM semaphore, same reasoning as the
 *  reply path's `REPLY_CONCURRENCY`. Nothing is waiting on these. */
const CONCURRENCY = 4;

export async function buildFollowUps(
  d: Pool,
  o: { showId: string; accountId: string; record: ShowRecord; drafter: Drafter },
): Promise<BuildResult> {
  const inbox = new FollowUpInbox(d);
  const selected = selectFollowUps(o.record);
  const result: BuildResult = {
    showId: o.showId,
    selected: selected.length,
    followups: [],
    guardedOut: [],
    abstained: [],
  };

  const queue = selected.slice(0, MAX_PER_BUILD);
  // A buyer the seller already sent to or dismissed does not get re-drafted:
  // the gateway call would be spent producing a draft `save` is contracted not
  // to overwrite.
  const settled = new Set(
    (await inbox.forShow(o.accountId, o.showId)).filter((r) => r.status !== "draft").map((r) => r.buyer),
  );

  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < queue.length; i = next++) {
      const f = queue[i]!;
      if (settled.has(f.buyer)) continue;
      await draftOne(inbox, o, f, result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  result.followups = await inbox.forShow(o.accountId, o.showId);
  return result;
}

async function draftOne(
  inbox: FollowUpInbox,
  o: { showId: string; accountId: string; drafter: Drafter },
  f: FollowUp,
  result: BuildResult,
): Promise<void> {
  let run: DryRunResult;
  try {
    run = await o.drafter.dryRun(f.question);
  } catch (e) {
    // One buyer's draft failing is not a reason to lose the other twenty-eight.
    result.guardedOut.push({
      buyer: f.buyer, question: f.question,
      guard: "drafting", reason: (e as Error).message,
    });
    return;
  }

  // Asked BEFORE the verdict, because an abstention reaches the guards as an
  // empty draft and comes back blocked — which is true and useless. "The
  // catalog has nothing to say about this any more" and "a guard refused what
  // we wanted to say" are different facts about the show, and reporting the
  // first as the second sends the operator looking for a guardrail bug.
  if (run.abstained || !run.answer.trim()) {
    result.abstained.push({ buyer: f.buyer, question: f.question });
    return;
  }
  if (run.verdict === "block") {
    const blocked = run.guards.find((g) => g.verdict === "block");
    result.guardedOut.push({
      buyer: f.buyer, question: f.question,
      guard: blocked?.guard ?? "unknown", reason: blocked?.reason ?? "a guard blocked it",
    });
    return;
  }

  await inbox.save({
    id: followUpId(o.showId, f.buyer),
    showId: o.showId,
    accountId: o.accountId,
    buyer: f.buyer,
    question: f.question,
    messageId: f.messageId,
    draft: run.answer.trim(),
  });
}

/**
 * One id per (show, buyer), derived rather than random.
 *
 * The table's uniqueness is `(show_id, buyer)` and the primary key is `id`; if
 * the two disagreed, a rebuild would try to insert a fresh id against an
 * existing row and the ON CONFLICT would update a row with a different primary
 * key than the one it just named. Deriving the id makes them the same fact.
 */
export function followUpId(showId: string, buyer: string): string {
  const slug = buyer.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  return `fu_${showId}_${slug || hash(buyer)}`.slice(0, 200);
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// ── getting a drafter for a show that is over ───────────────────────────────

/**
 * The pipeline that would have answered this show, for a show that has ended.
 *
 * A finished show's `ShowRuntime` is gone — the registry drops it on detach —
 * and its catalog, its seller voice and its guard policy went with it. Rather
 * than assemble a second, subtly different composition of the same eight
 * objects, this rebuilds the real runtime in REPLAY mode: no watcher, no
 * clock reset, no status change, nothing emitted. Its listings are the show's
 * own rows, which is what makes the staleness guards mean something here.
 *
 * A show still being watched hands back its live pipeline instead. That is the
 * rare case — follow-ups are built after a show ends — but a second Repo and a
 * second retriever over the same show would be two caches of one truth.
 */
export async function openDrafter(
  shows: { has(id: string): boolean; get(id: string): { pipeline: Drafter } },
  showId: string,
): Promise<{ drafter: Drafter; close(): Promise<void> }> {
  if (shows.has(showId)) return { drafter: shows.get(showId).pipeline, close: async () => {} };

  const d = pgPool();
  const row = (
    await d.query<{
      title: string; seller_handle: string; source: string; external_id: string | null;
      owner_account_id: string | null; catalog_id: string | null; agent_id: string | null;
    }>(
      "SELECT title, seller_handle, source, external_id, owner_account_id, catalog_id, agent_id FROM shows WHERE id = $1",
      [showId],
    )
  ).rows[0];
  if (!row) throw new Error(`no show ${showId}`);

  const rt = new ShowRuntime({
    showId,
    title: row.title,
    sellerHandle: row.seller_handle,
    source: row.source as SurfaceId,
    externalId: row.external_id,
    ownerAccountId: row.owner_account_id,
    replay: true,
    events: { emit: () => {} },
  });
  await rt.init();

  // The voice. The listings came back with the show row; the seller's identity
  // lives in the catalog file, and without it the follow-up is written by a
  // generic assistant rather than by the person whose account will send it.
  const catalog = row.catalog_id ? getCatalog(row.catalog_id) : null;
  if (catalog) {
    rt.seller = catalog.seller;
    rt.catalogId = catalog.id;
  }
  // The agent that actually answered this show, preferred over the catalog
  // file's: the show row is what survives a catalog being re-imported, and it
  // is the same column `POST /:showId/timeline/describe` reads for the same
  // reason. Agent GC retires it a day after the report, which is the real
  // deadline on a follow-up — a fact worth saying out loud rather than
  // discovering as a 400 on a show from last week.
  const agentId = row.agent_id || catalog?.agentId;
  if (agentId) rt.useAgent(agentId);

  return { drafter: rt.pipeline, close: () => rt.close() };
}
