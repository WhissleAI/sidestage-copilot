// Accounts, sessions, and the actor every write is attributed to.
//
// Until now the app had NO auth at all: anyone who could reach port 8790 drove
// every show, approved every action and detached every session. That was
// correct for a single-operator local tool and wrong the moment it is opened on
// conference wifi — and it left the audit chain unable to answer its own
// central question. `actorType` only ever held "seller" or "system"; "who
// approved that markdown" had no answer because there was no who.
//
// The model is deliberately small: one kind, `seller`, the operator. Every
// request that changes anything carries a seller session; a request with no
// session can read the public routes and nothing else. (An earlier build had
// an unauthenticated `guest` kind for watching a show; it is gone — a show is
// scoped to the account that attached it, so there is nothing for a stranger
// to watch.)

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: string, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

/** scrypt, N=2^14 (16 MB per hash) — memory-hard, no native dependency, and
 *  the parameters travel in the hash so they can be raised later without a
 *  reset. `maxmem` is explicit: Node refuses anything past 32 MB by default. */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt}$${key.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, salt, hex] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hex) return false;
  const key = await scrypt(password, salt, 64, { ...SCRYPT, N: Number(n) || SCRYPT.N });
  const want = Buffer.from(hex, "hex");
  return key.length === want.length && timingSafeEqual(key, want);
}

export class AuthError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}
import type { Pool } from "../db/pg.js";

export type AccountKind = "seller";

export interface Account {
  id: string;
  kind: AccountKind;
  handle: string;
  displayName: string;
  email?: string | null;
}

export interface Session {
  token: string;
  account: Account;
  expiresAt: string;
}

/** How long a console session lives before it has to be re-minted. */
const SESSION_DAYS = 30;


export class Accounts {
  constructor(private d: Pool) {}


  /**
   * Register a seller. Email is the identity, the handle is derived from it
   * for the places that show a short name, and the account is a seller from
   * the first request — there is nothing to claim.
   */
  async register(email: string, password: string, displayName: string): Promise<Session> {
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new AuthError("that does not look like an email address");
    if (password.length < 8) throw new AuthError("use at least 8 characters for the password");
    const exists = await this.d.query("SELECT 1 FROM accounts WHERE lower(email) = $1", [e]);
    if (exists.rowCount) throw new AuthError("an account with that email already exists — sign in instead", 409);
    const id = `acc_${randomBytes(8).toString("hex")}`;
    const handle = e.split("@")[0]!.replace(/[^a-z0-9._-]/g, "").slice(0, 40) || "seller";
    const name = (displayName || handle).trim().slice(0, 80);
    await this.d.query(
      "INSERT INTO accounts (id, kind, handle, display_name, email, password_hash) VALUES ($1, 'seller', $2, $3, $4, $5)",
      [id, handle, name, e, await hashPassword(password)],
    );
    return this.openSession({ id, kind: "seller", handle, displayName: name, email: e });
  }

  /** One message for a wrong email and a wrong password: which one was wrong is not information to hand out. */
  async login(email: string, password: string): Promise<Session> {
    const e = email.trim().toLowerCase();
    const r = await this.d.query<AccountRow & { password_hash: string | null }>(
      "SELECT * FROM accounts WHERE lower(email) = $1", [e],
    );
    const row = r.rows[0];
    if (!row?.password_hash || !(await verifyPassword(password, row.password_hash))) {
      throw new AuthError("email or password is wrong", 401);
    }
    return this.openSession(toAccount(row));
  }

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

interface AccountRow { id: string; kind: string; handle: string; display_name: string; email?: string | null }

const toAccount = (r: AccountRow): Account => ({
  id: r.id, kind: r.kind as AccountKind, handle: r.handle, displayName: r.display_name || r.handle, email: r.email ?? null,
});

/** Can this actor change anything? Only a signed-in seller acts. */
export function canWrite(a: Account | null): boolean {
  return a?.kind === "seller";
}
