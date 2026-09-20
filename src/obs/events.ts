// A session's own memory of what happened to it.
//
// `log()` answers "what is this process doing"; this answers "why did THAT
// show stop answering, last Tuesday". Both, from one call: the line goes to
// stdout where an operator is watching now, and the row goes to Postgres where
// an incident is read from afterwards.
//
// Fire-and-forget by construction — a buyer's question must never wait on an
// observability write — but NOT silent. A write that fails logs, once per kind
// per process, and is counted. The whole point of this file is that continuing
// stops being indistinguishable from succeeding.

import type { Pool } from "../db/pg.js";
import { log, errText, type Level } from "./log.js";

export interface SessionEvent {
  showId?: string | null;
  kind: string;
  level?: Level;
  /** Counts and identifiers. Never message text, drafts, transcript or tokens. */
  detail?: Record<string, unknown>;
}

/**
 * The pool, supplied once at boot.
 *
 * A module-level handle rather than an argument on forty call sites: the sites
 * that most need to record something — a watcher's give-up, a swallowed
 * `.catch`, a bridge disconnect — are exactly the ones with no database handle
 * in scope, and threading one through them is how this ends up unwritten
 * again.
 */
let pool: Pool | null = null;
let dropped = 0;
const complained = new Set<string>();

export function useEventStore(p: Pool | null): void {
  pool = p;
}

/** How many events never reached Postgres. Reported by /health. */
export function droppedEvents(): number {
  return dropped;
}

/** Test seam: forget the handle and the complaint set between rigs. */
export function resetEventStore(): void {
  pool = null;
  dropped = 0;
  complained.clear();
}

/**
 * Record one thing that happened. Never throws, never awaits the caller.
 *
 * Returns the insert promise so a test — and only a test — can wait for it.
 */
export function recordEvent(e: SessionEvent): Promise<void> {
  const level = e.level ?? "info";
  log(level, e.kind, { showId: e.showId ?? undefined, ...(e.detail ?? {}) });
  const p = pool;
  if (!p) return Promise.resolve();
  return p
    .query("INSERT INTO session_events (show_id, kind, level, detail) VALUES ($1,$2,$3,$4::jsonb)", [
      e.showId ?? null,
      e.kind,
      level,
      JSON.stringify(e.detail ?? {}),
    ])
    .then(() => undefined)
    .catch((err) => {
      dropped++;
      // Once per kind: a Postgres that is down would otherwise turn one
      // incident into a second one made of log lines.
      if (!complained.has(e.kind)) {
        complained.add(e.kind);
        log("error", "session_event.write_failed", { kind: e.kind, dropped, err: errText(err) });
      }
    });
}

/** The recent history of one show, newest first — what an incident is read on. */
export async function showEvents(
  p: Pool,
  showId: string,
  limit = 200,
): Promise<{ at: string; kind: string; level: string; detail: Record<string, unknown> }[]> {
  const { rows } = await p.query<{ at: string; kind: string; level: string; detail: Record<string, unknown> }>(
    "SELECT at, kind, level, detail FROM session_events WHERE show_id = $1 ORDER BY at DESC, seq DESC LIMIT $2",
    [showId, Math.min(1000, Math.max(1, limit))],
  );
  return rows;
}
