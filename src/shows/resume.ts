// What to do about a session the database still calls `live` after a restart.
//
// A monitored session lives in TWO places: the row in Postgres, and a watcher
// in this process. Only the first survives a restart, so every boot inherits
// rows claiming to be on air that nothing is watching.
//
// The sweep that reconciled them read
//
//     ... FROM shows WHERE status = 'live' AND source = 'ebaylive'
//
// so it reconciled one surface out of seven. A Whatnot, TikTok, Twitch, Reddit
// or simulated session interrupted by a deploy stayed `live` for ever: not in
// the Now band (built from live runtimes, not rows), not in the Behind band
// (which requires `ended` or a report), no report, no cost row, no follow-ups,
// never counted by Analytics — and it kept its agent for ever, because the
// collector only retires agents of shows that ended. It simply vanished.
//
// Two decisions, kept apart because only the first is a judgement call:
//
//   `planResume`      — reopen this row, finish it, or leave it alone. Pure,
//                       over the row, so the rule can be argued with in a test.
//   `finishStranded`  — finish it the way a detach would: an end time, a report
//                       (or the recorded reason there is none), a cost row.
//
// Finishing is the default, and it is not a consolation prize. For an async
// surface there was never a session to reopen, and for a live one whose event
// is over, reopening a browser page costs a page and finds nothing. What the
// operator needs is the session to STOP claiming to be on air and to leave
// behind what it measured.

import type { Pool } from "../db/pg.js";
import { resolve as resolveSurface } from "../surfaces/registry.js";
import { openReplayRuntime } from "./replay.js";

/** An eBay Live show is a couple of hours. Nothing older than this is worth a
 *  browser page: the event is over and the page would find an ended show. */
export const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * How recently written a row has to be before this sweep leaves it alone.
 *
 * `created_at`, not `started_at`: a session's clock can be hours old while its
 * ROW was written a moment ago, and what matters here is whether some other
 * process might still be holding it. A boot that has only just happened cannot
 * tell "orphaned by the crash I am recovering from" from "being set up right
 * now by somebody else", and finishing somebody else's live session is a much
 * worse mistake than leaving one live until the next boot notices.
 */
export const RECENT_ROW_MS = 10 * 60 * 1000;

export interface LiveRow {
  id: string;
  source: string;
  external_id: string | null;
  started_at: string;
  /** When the ROW was written. Absent on a caller that does not read it, which
   *  is treated as "old enough to reconcile". */
  created_at?: Date | string | null;
}

export type ResumePlan =
  | { action: "resume"; showId: string; externalId: string }
  | { action: "finish"; showId: string; why: string }
  | { action: "leave"; showId: string; why: string };

/**
 * Resume this row, finish it, or leave it alone.
 *
 * A row is resumed only when its own surface can be reopened from the id the
 * row recorded — `resolve()` must hand back the SAME adapter the session ran
 * on. That equality check is the whole of the safety here: resolution is
 * first-match over every registered adapter and one of them accepts a bare
 * word, so resolving a Whatnot slug would cheerfully return Twitch and the
 * sweep would reattach the wrong surface to somebody's session.
 */
export function planResume(row: LiveRow, now = Date.now()): ResumePlan {
  const reopenable = canReopen(row, now);
  if (reopenable) return { action: "resume", showId: row.id, externalId: row.external_id! };

  const written = row.created_at ? new Date(row.created_at).getTime() : 0;
  if (written && now - written < RECENT_ROW_MS) {
    return { action: "leave", showId: row.id, why: "written moments ago — not ours to finish yet" };
  }
  return { action: "finish", showId: row.id, why: whyNotReopenable(row, now) };
}

function canReopen(row: LiveRow, now: number): boolean {
  if (!row.external_id) return false;
  if (now - new Date(row.started_at).getTime() > RESUME_WINDOW_MS) return false;
  return resolveSurface(row.external_id)?.adapter.id === row.source;
}

function whyNotReopenable(row: LiveRow, now: number): string {
  if (!row.external_id) return "no external id to reconnect with";
  const age = now - new Date(row.started_at).getTime();
  if (age > RESUME_WINDOW_MS) return `started ${Math.round(age / 3_600_000)}h ago`;
  return `nothing on ${row.source} can be reopened from the id this session recorded`;
}

/**
 * Finish a session nothing is watching, the way a detach would.
 *
 * `finishSession` over a replay runtime, so the session gets the same end time,
 * the same report and the same cost row a clean close would have produced —
 * and, when the report cannot be built, the same recorded reason (migration
 * 025) rather than a row that is merely no longer `live`.
 *
 * The fallback matters more than the happy path: whatever goes wrong here, the
 * row must stop claiming to be on air, or the next boot inherits it again.
 */
export async function finishStranded(d: Pool, showId: string, why: string): Promise<boolean> {
  let rt;
  try {
    rt = await openReplayRuntime(showId);
  } catch (e) {
    console.warn(`  ${showId}: could not reopen to finish (${why}) — ${(e as Error).message}`);
    await markEnded(d, showId);
    return false;
  }
  try {
    const report = await rt.finishSession();
    console.log(`  ${showId}: finished after a restart (${why})${report ? "" : " — without a report"}`);
    return report != null;
  } catch (e) {
    console.warn(`  ${showId}: finishing failed — ${(e as Error).message}`);
    await markEnded(d, showId);
    return false;
  } finally {
    await rt.close().catch(() => {});
  }
}

async function markEnded(d: Pool, showId: string): Promise<void> {
  await d
    .query(
      "UPDATE shows SET status = 'ended', ended_at = COALESCE(ended_at, now()) WHERE id = $1",
      [showId],
    )
    .catch((e) => console.warn(`  ${showId}: still says live — ${(e as Error).message}`));
}
