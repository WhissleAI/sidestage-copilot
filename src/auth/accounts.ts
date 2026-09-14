// Accounts, sessions, and the actor every write is attributed to.
//
// Until now the app had NO auth at all: anyone who could reach port 8790 drove
// every show, approved every action and detached every session. That was
// correct for a single-operator local tool and wrong the moment it is opened on
// conference wifi — and it left the audit chain unable to answer its own
// central question. `actorType` only ever held "seller" or "system"; "who
// approved that markdown" had no answer because there was no who.
//
// The model is deliberately small:
//
//   guest   can WATCH a show and read proposals, but cannot send, approve or
//           act. The read-only rung below L1 Suggest.
//   seller  the operator. Everything.
//
// A guest account is minted on first contact and needs no credentials, because
// the point is to let someone open the console and see a live show working —
// not to build a sign-up flow nobody asked for.

import { randomBytes } from "node:crypto";
import type { Pool } from "../db/pg.js";

export type AccountKind = "guest" | "seller";

export interface Account {
  id: string;
  kind: AccountKind;
  handle: string;
  displayName: string;
}

export interface Session {
  token: string;
  account: Account;
  expiresAt: string;
}

/** How long a console session lives before it has to be re-minted. */
const SESSION_DAYS = 30;

const ADJECTIVES = ["swift", "quiet", "amber", "north", "clever", "brisk", "violet", "ember"];
const NOUNS = ["lark", "falcon", "otter", "heron", "marten", "ibis", "sable", "wren"];

function guestHandle(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a}-${n}-${randomBytes(2).toString("hex")}`;
}

export class Accounts {
  constructor(private d: Pool) {}

  /**
   * Mint a guest account and a session for it.
   *
   * One call, because a guest has nothing to verify. The token is the only
   * secret and it is generated here rather than derived from anything about the
   * account, so it cannot be guessed from a handle.
   */
  async createGuest(): Promise<Session> {
    const id = `acc_${randomBytes(8).toString("hex")}`;
    const handle = guestHandle();
    await this.d.query(
      "INSERT INTO accounts (id, kind, handle, display_name) VALUES ($1, 'guest', $2, $3)",
      [id, handle, handle],
    );
    return this.openSession({ id, kind: "guest", handle, displayName: handle });
  }

  /** Promote a guest to the operator role. The console's "this is my show"
   *  step; there is no password because there is nothing yet to protect. */
  async promoteToSeller(accountId: string, displayName: string): Promise<Account | null> {
    const r = await this.d.query<AccountRow>(
      "UPDATE accounts SET kind = 'seller', display_name = $2 WHERE id = $1 RETURNING *",
      [accountId, displayName],
    );
    return r.rows[0] ? toAccount(r.rows[0]) : null;
  }

  async openSession(account: Account): Promise<Session> {
    const token = `sst_${randomBytes(24).toString("hex")}`;
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
    await this.d.query(
      "INSERT INTO auth_sessions (token, account_id, expires_at) VALUES ($1, $2, $3)",
      [token, account.id, expiresAt],
    );
    return { token, account, expiresAt };
  }

  /**
   * Resolve a bearer token to an account, or null.
   *
   * Expiry is enforced in the QUERY rather than in JavaScript: a check the
   * database performs cannot be skipped by a caller that forgot to run it.
   */
  async resolve(token: string | null): Promise<Account | null> {
    if (!token) return null;
    const r = await this.d.query<AccountRow>(
      `SELECT a.* FROM auth_sessions s
       JOIN accounts a ON a.id = s.account_id
       WHERE s.token = $1 AND s.expires_at > now()`,
      [token],
    );
    if (!r.rows[0]) return null;
    // Best-effort liveness, never on the critical path of the answer.
    void this.d.query("UPDATE auth_sessions SET last_seen = now() WHERE token = $1", [token]).catch(() => {});
    return toAccount(r.rows[0]);
  }

  async endSession(token: string): Promise<void> {
    await this.d.query("DELETE FROM auth_sessions WHERE token = $1", [token]);
  }
}

interface AccountRow { id: string; kind: string; handle: string; display_name: string }

const toAccount = (r: AccountRow): Account => ({
  id: r.id, kind: r.kind as AccountKind, handle: r.handle, displayName: r.display_name || r.handle,
});

/** Can this actor change anything? A guest watches; only a seller acts. */
export function canWrite(a: Account | null): boolean {
  return a?.kind === "seller";
}
