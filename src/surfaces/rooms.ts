// The rooms an operator watches, and whether we may speak in any of them.
//
// Every read in here is scoped by `account_id` the way `Repo` is scoped by show
// id: the argument is bound into the statement rather than left to a call site
// to remember. Rooms are the list of places one seller's copilot is allowed to
// open its mouth, which makes a missed filter the most expensive kind.

import type { Pool } from "../db/pg.js";
import type { SurfaceId } from "./types.js";

export interface SurfaceRoom {
  surface: SurfaceId;
  room: string;
  /** A HUMAN turned this on. Default false, everywhere, always. */
  posting: boolean;
  /** What we must say about who is talking, when we post here. */
  disclosure: string | null;
  addedAt: string;
}

interface Row {
  surface: string; room: string; posting: boolean;
  disclosure: string | null; added_at: string;
}

const toRoom = (r: Row): SurfaceRoom => ({
  surface: r.surface as SurfaceId,
  room: r.room,
  posting: r.posting,
  disclosure: r.disclosure,
  addedAt: new Date(r.added_at).toISOString(),
});

export class SurfaceRooms {
  constructor(private d: Pool) {}

  async list(accountId: string, surface: SurfaceId): Promise<SurfaceRoom[]> {
    const r = await this.d.query<Row>(
      `SELECT surface, room, posting, disclosure, added_at FROM surface_rooms
        WHERE account_id = $1 AND surface = $2 ORDER BY added_at`,
      [accountId, surface],
    );
    return r.rows.map(toRoom);
  }

  /**
   * Add a room, or change one.
   *
   * `posting` defaults to false on an INSERT and is only ever changed by a call
   * that says so explicitly — an update that omits it leaves it alone. Adding a
   * room to the watch list is not the same decision as agreeing to speak in it,
   * and a partial update that silently reset the switch either way would be
   * making one of those decisions on the operator's behalf.
   */
  async upsert(
    accountId: string,
    surface: SurfaceId,
    room: string,
    patch: { posting?: boolean; disclosure?: string | null } = {},
  ): Promise<SurfaceRoom> {
    const r = await this.d.query<Row>(
      `INSERT INTO surface_rooms (account_id, surface, room, posting, disclosure)
       VALUES ($1, $2, $3, COALESCE($4, FALSE), $5)
       ON CONFLICT (account_id, surface, room) DO UPDATE SET
         posting = COALESCE($4, surface_rooms.posting),
         disclosure = COALESCE($5, surface_rooms.disclosure)
       RETURNING surface, room, posting, disclosure, added_at`,
      [accountId, surface, room, patch.posting ?? null, patch.disclosure ?? null],
    );
    return toRoom(r.rows[0]!);
  }

  async remove(accountId: string, surface: SurfaceId, room: string): Promise<boolean> {
    const r = await this.d.query(
      "DELETE FROM surface_rooms WHERE account_id = $1 AND surface = $2 AND room = $3",
      [accountId, surface, room],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * What preflight asks before a `post_reply`.
   *
   * A room with no row answers `false`, not "unknown". Preflight has exactly
   * one safe reading of a missing row and this is where it is written down,
   * rather than left to each caller to get right.
   */
  async posting(accountId: string, surface: SurfaceId, room: string): Promise<{ room: string; enabled: boolean }> {
    const r = await this.d.query<{ posting: boolean }>(
      "SELECT posting FROM surface_rooms WHERE account_id = $1 AND surface = $2 AND room = $3",
      [accountId, surface, room],
    );
    return { room, enabled: r.rows[0]?.posting ?? false };
  }
}
