// Sellers you follow, and the one honest way we can check on them.
//
// There is no public eBay Live API, no seller feed, and the seller profile page
// (`/usr/<handle>`) answers 403 to anything that is not a signed-in browser —
// headless Chromium included. So "following" cannot mean subscribing to a
// seller; there is nothing to subscribe to.
//
// What it can mean, truthfully: a short list of handles that is matched against
// the live grid every time the grid answers. The grid is best effort and is
// refused often, so following inherits that — which is why every surface that
// shows a followed seller also shows when we last managed to look. A follow
// that has not been checked in twenty minutes is a different thing from a
// seller who is off air, and conflating them is how a feature like this starts
// lying.
//
// Pasting a link stays the path that always works.

import type { Pool } from "../db/pg.js";
import { discoverLiveShows, type DiscoveredShow } from "../ingest/ebaylive/discovery.js";
import { sessionStatus } from "../ingest/ebaylive/session.js";

export interface FollowedSeller {
  handle: string;
  note: string | null;
  addedAt: string;
  /** When the live grid last answered us at all. Null means never. */
  lastCheckedAt: string | null;
  /** When we last saw this handle on it. */
  lastSeenLiveAt: string | null;
  /** Set while they are on air, from the most recent successful check. */
  live: { eventId: string; title: string; url: string; viewers: number | null } | null;
}

/** `@KicksByRae` and `kicksbyrae ` are the same seller. */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase().slice(0, 64);
}

/**
 * One discovery run, shared.
 *
 * Discovery launches a headless browser and takes the better part of a minute.
 * Every console asking for its Following tab must not each pay for one, so the
 * result is cached for a few minutes and concurrent callers wait on the same
 * promise rather than starting a second browser.
 */
const GRID_TTL_MS = 4 * 60_000;
let gridAt = 0;
let grid: DiscoveredShow[] = [];
let inFlight: Promise<DiscoveredShow[]> | null = null;
/** What the last read said when it found nothing — "signed-out" is an
 *  instruction to the operator, "blocked" is a shrug, and the cache must not
 *  flatten the first into the second. */
let lastEmptyReason: "signed-out" | "blocked" | null = null;

export async function liveGrid(opts: { force?: boolean } = {}): Promise<DiscoveredShow[]> {
  if (!opts.force && Date.now() - gridAt < GRID_TTL_MS) return grid;
  if (inFlight) return inFlight;
  inFlight = discoverLiveShows({ limit: 30 })
    .then(({ shows, reason }) => {
      // A refusal is not a result. Only a real answer moves the timestamp, so
      // the UI can distinguish "nobody is on air" from "we could not look".
      if (reason !== "ok") {
        lastEmptyReason = reason === "signed-out" ? "signed-out" : "blocked";
        if (reason === "signed-out") {
          console.warn(
            "  ebaylive: eBay has signed the discovery session out — Discover and Prepare are off until an operator " +
              "runs `npm run ebay:signin` through EBAY_DISCOVERY_PROXY and deploys the session again",
          );
        }
        return grid;
      }
      lastEmptyReason = null;
      grid = shows;
      gridAt = Date.now();
      return shows;
    })
    .catch(() => {
      // A refusal is not a result: leave the previous grid and its timestamp
      // alone so the UI can say how stale it is instead of showing an empty
      // grid as if nobody were on air.
      return grid;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}


/**
 * The grid we already have, in the shape the home surface wants.
 *
 * Same cache, same rule — it never starts a read. The reason travels with it
 * because "nobody is on air" and "sign in to eBay first" are both empty lists
 * and completely different instructions.
 */
export function cachedDiscovery(): {
  shows: DiscoveredShow[];
  reason: "ok" | "no-session" | "stale-session" | "signed-out" | "blocked" | "stale";
  session: ReturnType<typeof sessionStatus>;
} {
  const session = sessionStatus();
  const fresh = Date.now() - gridAt < GRID_TTL_MS;
  if (!session.present) return { shows: [], reason: "no-session", session };
  if (lastEmptyReason === "signed-out") return { shows: [], reason: "signed-out", session };
  if (fresh) return { shows: grid, reason: "ok", session };
  // Cached but old: hand back what we have and say it is stale rather than
  // showing an empty grid to someone whose last read found twelve shows.
  return { shows: grid, reason: grid.length ? "stale" : lastEmptyReason ?? "blocked", session };
}

/**
 * The grid we already have. Pure: it never starts a read.
 *
 * Following a seller must not take a minute. An earlier version awaited
 * `liveGrid()` from inside `list()`, so adding a handle sat on a spinner while
 * headless Chromium scrolled the eBay Live index — a page load's worth of work
 * charged to a two-word form. Refreshing is the poller's job, or the operator's
 * through "check now"; a GET neither waits for a browser nor launches one.
 */
export function cachedGrid(): { shows: DiscoveredShow[] | null; checking: boolean } {
  const fresh = Date.now() - gridAt < GRID_TTL_MS;
  return { shows: fresh ? grid : null, checking: inFlight !== null };
}

/**
 * Keep the grid warm whenever there is a session to read it with.
 *
 * Two reasons, and the second is the one that matters on a host: the Discover
 * tab is current for anyone who opens it, and the session itself stays alive —
 * eBay keeps a "stay signed in" session that is used and ends one that is not.
 * It used to run only while someone followed a seller; a hosted copilot with a
 * house session wants it always. `DISCOVERY_REFRESH_MIN` sets the cadence.
 *
 * Started by the server, not by `buildApp`, so the test suite neither drives a
 * browser nor depends on eBay answering. The first read is delayed: a process
 * that has just booted has more urgent work than a discovery scrape.
 */
export function startFollowingPoller(
  d: Pool,
  opts: { everyMs?: number; firstDelayMs?: number } = {},
): () => void {
  const every = opts.everyMs ?? Math.max(2, Number(process.env.DISCOVERY_REFRESH_MIN) || 5) * 60_000;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    if (sessionStatus().present) {
      await liveGrid({ force: true }).catch(() => {});
      return;
    }
    // No session: only a follower gives a reason to try (and learn that).
    const { rows } = await d
      .query<{ n: number }>("SELECT count(*)::int AS n FROM followed_sellers")
      .catch(() => ({ rows: [{ n: 0 }] }));
    if ((rows[0]?.n ?? 0) > 0) await liveGrid({ force: true }).catch(() => {});
  };

  const first = setTimeout(() => void tick(), opts.firstDelayMs ?? 20_000);
  const timer = setInterval(() => void tick(), every);
  // Neither timer should be the reason this process stays alive.
  first.unref?.();
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}

/** Did the grid answer at all recently? The Following tab says so out loud. */
export function gridCheckedAt(): string | null {
  return gridAt ? new Date(gridAt).toISOString() : null;
}

function handleOf(s: DiscoveredShow): string {
  return normalizeHandle(s.host || "");
}

export class Following {
  constructor(private d: Pool) {}

  async add(accountId: string, handle: string, note?: string): Promise<FollowedSeller[]> {
    const h = normalizeHandle(handle);
    if (!h) throw new Error("a handle is required");
    await this.d.query(
      `INSERT INTO followed_sellers (account_id, handle, note) VALUES ($1,$2,$3)
       ON CONFLICT (account_id, handle) DO UPDATE SET note = COALESCE(EXCLUDED.note, followed_sellers.note)`,
      [accountId, h, note ?? null],
    );
    return this.list(accountId);
  }

  async remove(accountId: string, handle: string): Promise<FollowedSeller[]> {
    await this.d.query("DELETE FROM followed_sellers WHERE account_id = $1 AND handle = $2", [
      accountId,
      normalizeHandle(handle),
    ]);
    return this.list(accountId);
  }

  /**
   * The follow list, matched against the most recent grid we have.
   *
   * `refresh` forces a new grid read; without it this is a cheap read of what
   * the last one found, which is what a page load should cost.
   */
  async list(accountId: string, opts: { refresh?: boolean } = {}): Promise<FollowedSeller[]> {
    const { rows } = await this.d.query<{
      handle: string; note: string | null; added_at: string;
      last_checked_at: string | null; last_seen_live_at: string | null;
      last_event_id: string | null; last_title: string | null;
    }>(
      `SELECT handle, note, added_at, last_checked_at, last_seen_live_at, last_event_id, last_title
         FROM followed_sellers WHERE account_id = $1 ORDER BY handle`,
      [accountId],
    );
    if (rows.length === 0) return [];

    // A read of this list is a page load. Only an explicit "check now" pays for
    // a grid read; everything else uses the last one and says how old it is.
    const shows = opts.refresh ? await liveGrid({ force: true }) : cachedGrid().shows;
    const byHandle = new Map((shows ?? []).map((s) => [handleOf(s), s]));
    const checkedAt = shows ? gridCheckedAt() : null;

    const out: FollowedSeller[] = [];
    for (const r of rows) {
      const s = byHandle.get(r.handle) ?? null;
      if (checkedAt) {
        // Record what this check saw. A miss still updates `last_checked_at`:
        // "we looked and they were not there" is information.
        void this.d
          .query(
            `UPDATE followed_sellers
                SET last_checked_at = $3,
                    last_seen_live_at = CASE WHEN $4::text IS NULL THEN last_seen_live_at ELSE $3 END,
                    last_event_id = COALESCE($4, last_event_id),
                    last_title = COALESCE($5, last_title)
              WHERE account_id = $1 AND handle = $2`,
            [accountId, r.handle, checkedAt, s?.eventId ?? null, s?.title ?? null],
          )
          .catch(() => {});
      }
      out.push({
        handle: r.handle,
        note: r.note,
        addedAt: r.added_at,
        lastCheckedAt: checkedAt ?? r.last_checked_at,
        lastSeenLiveAt: s ? (checkedAt ?? r.last_seen_live_at) : r.last_seen_live_at,
        live: s
          ? { eventId: s.eventId, title: s.title, url: s.url, viewers: s.viewers || null }
          : null,
      });
    }
    return out;
  }
}
