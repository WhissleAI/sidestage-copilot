// eBay's Marketplace Account Deletion notifications — the price of a
// production keyset.
//
// eBay keeps production keys disabled until the application can be told that a
// member has closed their account, so that everything held about them can be
// deleted. The contract, from the developer portal's "Alerts & Notifications":
//
//   GET  <endpoint>?challenge_code=X   → 200 {"challengeResponse": hex}
//        where hex = sha256(challengeCode + verificationToken + endpointUrl)
//   POST <endpoint>  {metadata:{topic:"MARKETPLACE_ACCOUNT_DELETION"},
//                     notification:{notificationId, data:{username,userId,eiasToken}}}
//        → 200 within seconds; then delete what we hold about that member.
//
// The verification token is ours (32–80 chars, set in the portal and in the
// environment); the endpoint URL in the hash must be byte-for-byte the one
// registered, which is why it is configuration rather than derived from the
// request — a proxy that rewrites the host would silently break the hash.
//
// What we hold about a member: the OAuth connection (tokens, identity) and the
// catalog imported from their listings. The connection goes here, by identity;
// the catalog file is named for OUR account, not the eBay member, and is
// removed when the seller deletes their own data.

import { createHash } from "node:crypto";
import type { Pool } from "../../db/pg.js";

export interface DeletionConfig {
  verificationToken: string;
  endpointUrl: string;
}

export function challengeResponse(challengeCode: string, cfg: DeletionConfig): string {
  return createHash("sha256")
    .update(challengeCode)
    .update(cfg.verificationToken)
    .update(cfg.endpointUrl)
    .digest("hex");
}

export interface DeletionNotice {
  notificationId: string | null;
  userId: string | null;
  username: string | null;
}

/** Pull the identity out of eBay's envelope; null when it is not a deletion notice. */
export function parseNotice(body: unknown): DeletionNotice | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { metadata?: { topic?: unknown }; notification?: { notificationId?: unknown; data?: Record<string, unknown> } };
  if (b.metadata?.topic !== "MARKETPLACE_ACCOUNT_DELETION") return null;
  const d = b.notification?.data ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    notificationId: str(b.notification?.notificationId),
    userId: str(d["userId"]),
    username: str(d["username"]),
  };
}

/** Delete every connection held for that member and keep a record that we did. */
export async function honourDeletion(d: Pool, n: DeletionNotice): Promise<number> {
  let removed = 0;
  if (n.userId || n.username) {
    const r = await d.query(
      `DELETE FROM ebay_accounts
        WHERE ($1::text IS NOT NULL AND ebay_user_id = $1)
           OR ($2::text IS NOT NULL AND lower(ebay_username) = lower($2))`,
      [n.userId, n.username],
    );
    removed = r.rowCount ?? 0;
  }
  await d.query(
    `INSERT INTO ebay_deletion_notices (notification_id, ebay_user_id, ebay_username, connections_removed)
     VALUES ($1,$2,$3,$4)`,
    [n.notificationId, n.userId, n.username, removed],
  );
  return removed;
}
