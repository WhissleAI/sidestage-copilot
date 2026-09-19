// The three bands of the home page, as pure functions.
//
// The spine of the product used to be "your shows", which only works while
// every conversation has a session with a start and an end. An asynchronous
// surface has neither: a subreddit is watched, not opened, and the follow-up
// inbox is built out of a show that finished hours ago. So the spine is what
// needs a human now — sessions on air on ANY surface, and the queues of drafts
// waiting behind the ones that have no console to sit in front of.
//
// Everything here takes rows and returns rows. The route does the reading; this
// does the deciding, which is what lets the bands be tested with a fabricated
// session on a surface no adapter in this build can even open.

import { capabilitiesOf, type SurfaceId } from "../surfaces/types.js";
import type { ShowSummary } from "../shows/registry.js";
import type { ShowReport } from "../shows/sessionRecord.js";

/** One session on air, on any surface. */
export interface LiveSession {
  showId: string;
  surface: SurfaceId;
  title: string;
  host: string;
  startedAt: string;
  /** Drafts waiting for the operator in this session. */
  awaiting: number;
  /** Drafts the guard chain refused. */
  blocked: number;
  readOnly: boolean;
}

export interface DraftQueues {
  total: number;
  bySurface: { surface: SurfaceId; count: number }[];
}

/**
 * The drafts figure, from one place.
 *
 * Home says how many drafts are waiting and Drafts shows them; the two numbers
 * have to be the same number, and "the same number computed twice" is the
 * arrangement that lasts until one side learns about a new status. So both
 * endpoints hand their per-surface entries to this — `now.drafts` from the
 * registry's own `awaiting` counts, `GET /api/drafts` from the drafts it is
 * about to return — and get back a structure that is deep-equal, ORDER
 * INCLUDED, when the queue is the same.
 *
 * Order is first appearance, which the callers make meaningful by passing
 * sessions in registry order with the follow-up inbox last. A surface with
 * nothing waiting is omitted rather than listed as zero: an empty queue is not
 * a queue, and a row of zeroes reads as something to go and look at.
 */
export function queueCounts(entries: { surface: SurfaceId; count: number }[]): DraftQueues {
  const bySurface = new Map<SurfaceId, number>();
  for (const e of entries) bySurface.set(e.surface, (bySurface.get(e.surface) ?? 0) + e.count);
  const queues = [...bySurface.entries()]
    .filter(([, count]) => count > 0)
    .map(([surface, count]) => ({ surface, count }));
  return { total: queues.reduce((a, q) => a + q.count, 0), bySurface: queues };
}

export interface NowBand {
  live: LiveSession[];
  drafts: DraftQueues;
}

export interface FinishedSession {
  showId: string;
  surface: SurfaceId;
  title: string;
  /**
   * When it finished, as well as this database can say.
   *
   * `shows.ended_at` since migration 024: stamped when the session stopped,
   * whether or not a report came out of it. The chain below it is for rows
   * written before the column existed — the report's own `endedAt`, then when
   * the report was written, then the last message the session recorded, then
   * when it started. `hasReport` is how a client knows what it is holding.
   */
  endedAt: string;
  /** Null, never zero, on a session with no report: nobody counted these. */
  answered: number | null;
  blocked: number | null;
  /** The question this session was asked most and could not answer. */
  topGap: string | null;
  /**
   * Did the report generate?
   *
   * A session that ended and produced nothing is the row an operator most wants
   * to see, and an inner join to `show_reports` hid exactly those. It is a
   * state to render — "ended, no report" — not a row to drop.
   */
  hasReport: boolean;
  /**
   * Why it produced nothing, when generation was attempted and failed.
   *
   * Null when nothing was attempted — a session from before the cause was
   * recorded, or one whose report simply has not been built. The badge used to
   * say "the report never generated" with nothing to click and no reason
   * anywhere outside the container's stdout (migration 025).
   */
  reportError: string | null;
}

export interface BehindBand {
  reports: FinishedSession[];
  followups: { total: number; ready: number };
}

/** A report row as the home query reads it: the session's own columns, and the
 *  stored report beside them. */
export interface ReportRow {
  showId: string;
  title: string;
  /** `surface` since migration 018; `source` on every row written before it. */
  surface: string | null;
  source: string;
  /** Null on a session whose report never generated. */
  generatedAt: Date | string | null;
  report: ShowReport | null;
  /** When the session stopped. Null on rows older than migration 024, and on
   *  a session that has not stopped. */
  endedAt?: Date | string | null;
  /** Why the report failed, when it did. */
  reportError?: string | null;
  /** Both optional: they are only ever read when there is no report, and the
   *  fallbacks below degrade in order rather than demanding either. */
  startedAt?: Date | string | null;
  /** The newest message this session recorded, when it recorded any. */
  lastSeenAt?: Date | string | null;
}

/**
 * Sessions on air, and the drafts waiting behind the ones with no console.
 *
 * `shows` is the registry's own list — the runtimes this process is actually
 * watching — rather than rows with `status = 'live'`. A row says live because
 * some process once attached it; a runtime IS the watching, and a session whose
 * process died is not something a human can do anything about.
 */
export function nowBand(shows: ShowSummary[], followupsReady: number): NowBand {
  const onAir = shows.filter((s) => s.status === "live");

  // An asynchronous session has nobody sitting in front of it: everything it
  // writes goes to a queue. The follow-up inbox is that same queue for a show
  // that already ended, which is what the `dm` surface is.
  //
  // The entries are built in the order `GET /api/drafts` builds its own —
  // async sessions as the registry lists them, then the inbox — because
  // `queueCounts` preserves it and a test compares the two payloads whole.
  const drafts = queueCounts([
    ...onAir
      .filter((s) => capabilitiesOf(s.source).tempo === "async")
      .map((s) => ({ surface: s.source, count: s.awaiting })),
    { surface: "dm" as SurfaceId, count: followupsReady },
  ]);

  return {
    live: onAir.map((s) => ({
      showId: s.showId,
      surface: s.source,
      title: s.title,
      host: s.sellerHandle,
      startedAt: s.startedAt,
      awaiting: s.awaiting,
      blocked: s.blocked,
      readOnly: s.readOnly,
    })),
    drafts,
  };
}

/**
 * What finished, and what it left.
 *
 * Every session that FINISHED is here, whether or not a report came out of it.
 * The join used to be an inner one, so a session whose report failed to
 * generate vanished from "behind you" — and that is precisely the session an
 * operator wants to look at, because something went wrong in it. Such a row
 * carries `hasReport: false` and nulls where the report's numbers would be,
 * which a client renders as a badge rather than as a zero.
 *
 * `topGap` is READ off the report, never recomputed. The report already ranked
 * the questions its session could not answer, at the moment it had the whole
 * session in hand; a second opinion computed here would eventually disagree
 * with the report page about the same show, and the operator would have no way
 * to tell which one was lying.
 */
export function behindBand(
  rows: ReportRow[],
  followups: { total: number; ready: number },
): BehindBand {
  return {
    reports: rows.map((x) => {
      const gaps = x.report?.gaps?.unanswered ?? [];
      const top = gaps.reduce<{ question: string; asked: number } | null>(
        (best, g) => (!best || g.asked > best.asked ? g : best),
        null,
      );
      const iso = (v: Date | string | null | undefined): string | null =>
        v == null ? null : new Date(v).toISOString();
      return {
        showId: x.showId,
        // A row written before migration 018 has no `surface`, and every one of
        // them was eBay Live or the scripted show — which is what `source` says.
        surface: (x.surface || x.source || "ebaylive") as SurfaceId,
        title: x.report?.title ?? x.title,
        // The stamped end, then the report's own time, then the moment the
        // report was written, then the last thing the session heard, then when
        // it started. Each step down is a worse answer, and every step below
        // the first exists only for rows older than migration 024.
        endedAt:
          iso(x.endedAt) ??
          x.report?.endedAt ??
          iso(x.generatedAt) ??
          iso(x.lastSeenAt) ??
          iso(x.startedAt) ??
          new Date(0).toISOString(),
        // Null rather than zero: "answered 0" is a measurement, and nobody made
        // this one.
        answered: x.report?.engagement.answered ?? null,
        blocked: x.report?.safety.blocked ?? null,
        topGap: top?.question ?? null,
        hasReport: Boolean(x.report),
        // Only meaningful when there is no report; a session that failed once
        // and was regenerated has the column cleared.
        reportError: x.report ? null : x.reportError ?? null,
      };
    }),
    followups,
  };
}
