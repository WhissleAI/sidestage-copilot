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
  endedAt: string;
  answered: number;
  blocked: number;
  /** The question this session was asked most and could not answer. */
  topGap: string | null;
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
  generatedAt: Date | string;
  report: ShowReport | null;
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
      return {
        showId: x.showId,
        // A row written before migration 018 has no `surface`, and every one of
        // them was eBay Live or the scripted show — which is what `source` says.
        surface: (x.surface || x.source || "ebaylive") as SurfaceId,
        title: x.report?.title ?? x.title,
        endedAt: x.report?.endedAt ?? new Date(x.generatedAt).toISOString(),
        answered: x.report?.engagement.answered ?? 0,
        blocked: x.report?.safety.blocked ?? 0,
        topGap: top?.question ?? null,
      };
    }),
    followups,
  };
}
