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
import type { DB } from "../db/index.js";
import type { AuditEntry, AuditKind } from "../domain/types.js";

export const GENESIS = "0".repeat(64);

/** Field separator inside the hashed payload. A byte that cannot occur in any
 *  of the fields, so "ab" + "c" and "a" + "bc" can never hash the same. */
const SEP = String.fromCharCode(0);

interface Row {
  seq: number; at: string; hash: string; prev_hash: string;
  kind: string; actor_type: string; summary: string; detail: string;
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
  constructor(private d: DB) {}

  /** Append one entry. The seq is allocated and the hash computed inside a single
   *  transaction so two concurrent appends cannot interleave and fork the chain. */
  append(
    kind: AuditKind,
    actorType: AuditEntry["actorType"],
    summary: string,
    detail: Record<string, unknown> = {},
  ): AuditEntry {
    const tx = this.d.transaction((): AuditEntry => {
      const head = this.d.prepare("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1").get() as
        | { seq: number; hash: string } | undefined;
      const seq = (head?.seq ?? 0) + 1;
      const prevHash = head?.hash ?? GENESIS;
      const at = new Date().toISOString();
      const hash = hashEntry(prevHash, { seq, at, kind, actorType, summary, detail });
      this.d.prepare(
        "INSERT INTO audit (seq, at, hash, prev_hash, kind, actor_type, summary, detail) VALUES (?,?,?,?,?,?,?,?)",
      ).run(seq, at, hash, prevHash, kind, actorType, summary, JSON.stringify(detail));
      return { seq, at, hash, prevHash, kind, actorType, summary, detail };
    });
    return tx();
  }

  list(limit = 200): AuditEntry[] {
    const rows = this.d.prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT ?").all(limit) as Row[];
    return rows.reverse().map(toEntry);
  }

  height(): number {
    return (this.d.prepare("SELECT COUNT(*) AS c FROM audit").get() as { c: number }).c;
  }

  /** Walk the whole chain. Reports the first seq where it breaks, if any. */
  verify(): { ok: boolean; height: number; brokenAt?: number; reason?: string } {
    const rows = this.d.prepare("SELECT * FROM audit ORDER BY seq ASC").all() as Row[];
    let prev = GENESIS;
    for (const r of rows) {
      if (r.prev_hash !== prev) {
        return { ok: false, height: rows.length, brokenAt: r.seq, reason: "prev_hash does not match the preceding entry" };
      }
      const expect = hashEntry(prev, {
        seq: r.seq, at: r.at, kind: r.kind, actorType: r.actor_type,
        summary: r.summary, detail: JSON.parse(r.detail),
      });
      if (expect !== r.hash) {
        return { ok: false, height: rows.length, brokenAt: r.seq, reason: "entry content does not match its hash" };
      }
      prev = r.hash;
    }
    return { ok: true, height: rows.length };
  }
}
