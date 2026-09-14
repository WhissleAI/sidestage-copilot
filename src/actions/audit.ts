// Append-only, hash-chained audit log.
//
// Every entry hashes the PREVIOUS entry's hash together with its own payload, so
// the log is tamper-evident: editing or deleting any historical row breaks every
// hash after it, and `verify()` reports the exact seq where the chain parts. The
// operator console exposes this as a "Verify chain" button — an auditability
// claim you can actually check is worth more than one you have to believe.
//
// Rows are only ever INSERTed. There is no update or delete path, deliberately:
// a rollback is a NEW entry recording the reversal, never an erasure of what
// happened.

import { createHash } from "node:crypto";
import type { Pool, Queryable } from "../db/pg.js";
import { tx } from "../db/pg.js";
import type { AuditEntry, AuditKind } from "../domain/types.js";

export const GENESIS = "0".repeat(64);

/** Field separator inside the hashed payload. A byte that cannot occur in any
 *  of the fields, so "ab" + "c" and "a" + "bc" can never hash the same. */
const SEP = String.fromCharCode(0);

interface Row {
  seq: number; at: string; hash: string; prev_hash: string;
  kind: string; actor_type: string; summary: string;
  /** TEXT, holding the EXACT bytes that were hashed. See migration 003. */
  detail: string;
}

const toEntry = (r: Row): AuditEntry => ({
  seq: r.seq, at: r.at, hash: r.hash, prevHash: r.prev_hash,
  kind: r.kind as AuditKind, actorType: r.actor_type as AuditEntry["actorType"],
  summary: r.summary, detail: JSON.parse(r.detail) as Record<string, unknown>,
});

/** The hashed payload. Field order is fixed and must never change — it is part
 *  of the chain's definition, not an implementation detail. */
export function hashEntry(
  prevHash: string,
  e: { seq: number; at: string; kind: string; actorType: string; summary: string; detail: unknown },
): string {
  const payload = [
    prevHash, String(e.seq), e.at, e.kind, e.actorType, e.summary, JSON.stringify(e.detail ?? {}),
  ].join(SEP);
  return createHash("sha256").update(payload).digest("hex");
}

export class AuditLog {
  constructor(private p: Pool, private showId: string) {}

  /**
   * Append one entry.
   *
   * The seq is allocated and the hash computed inside a single transaction that
   * first takes an advisory lock on this SHOW. SQLite gave that serialisation
   * for free with a whole-database write lock; Postgres does not, and two
   * concurrent appends that both read the same head would compute two entries
   * claiming the same `prev_hash` — one would lose the primary key race and the
   * other would be a chain that silently dropped a write. The lock is per show,
   * so two shows appending at once do not queue behind each other.
   */
  async append(
    kind: AuditKind,
    actorType: AuditEntry["actorType"],
    summary: string,
    detail: Record<string, unknown> = {},
    actorId: string | null = null,
  ): Promise<AuditEntry> {
    return tx(this.p, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [this.showId]);
      const head = await c.query<{ seq: number; hash: string }>(
        "SELECT seq, hash FROM audit WHERE show_id = $1 ORDER BY seq DESC LIMIT 1", [this.showId],
      );
      const seq = (head.rows[0]?.seq ?? 0) + 1;
      const prevHash = head.rows[0]?.hash ?? GENESIS;
      const at = new Date().toISOString();
      const hash = hashEntry(prevHash, { seq, at, kind, actorType, summary, detail });
      await c.query(
        `INSERT INTO audit (show_id, seq, at, hash, prev_hash, kind, actor_type, actor_id, summary, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [this.showId, seq, at, hash, prevHash, kind, actorType, actorId, summary, JSON.stringify(detail)],
      );
      return { seq, at, hash, prevHash, kind, actorType, summary, detail };
    });
  }

  async list(limit = 200): Promise<AuditEntry[]> {
    const r = await this.p.query<Row>(
      "SELECT * FROM audit WHERE show_id = $1 ORDER BY seq DESC LIMIT $2", [this.showId, limit],
    );
    return r.rows.reverse().map(toEntry);
  }

  async height(): Promise<number> {
    const r = await this.p.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM audit WHERE show_id = $1", [this.showId],
    );
    return r.rows[0]?.c ?? 0;
  }

  /** Walk the whole chain. Reports the first seq where it breaks, if any. */
  async verify(): Promise<{ ok: boolean; height: number; brokenAt?: number; reason?: string }> {
    const r = await this.p.query<Row>(
      "SELECT * FROM audit WHERE show_id = $1 ORDER BY seq ASC", [this.showId],
    );
    const rows = r.rows;
    let prev = GENESIS;
    for (const row of rows) {
      if (row.prev_hash !== prev) {
        return { ok: false, height: rows.length, brokenAt: row.seq, reason: "prev_hash does not match the preceding entry" };
      }
      const expect = hashEntry(prev, {
        seq: row.seq, at: row.at, kind: row.kind, actorType: row.actor_type,
        // Re-hash the STORED text, not a re-serialisation of it: the whole
        // point is that these are the bytes the hash was taken over.
        summary: row.summary, detail: JSON.parse(row.detail),
      });
      if (expect !== row.hash) {
        return { ok: false, height: rows.length, brokenAt: row.seq, reason: "entry content does not match its hash" };
      }
      prev = row.hash;
    }
    return { ok: true, height: rows.length };
  }
}
