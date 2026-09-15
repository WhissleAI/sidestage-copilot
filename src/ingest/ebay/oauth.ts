// Acting AS the seller, which needs the seller to say so.
//
// Every eBay call the product made until now was a read through an application
// token — search, categories, aspects. None of it touched anyone's account.
// Changing a price or ending a listing is different in kind: it acts as a
// person, and eBay will only issue a token for that after that person signs in
// and consents in a browser. There is no key that skips this, and there should
// not be.
//
// The flow, and where each half lives:
//
//   1. `consentUrl()`     we send them to eBay with a one-time `state`.
//   2. eBay               they sign in and approve the scopes.
//   3. `/api/ebay/callback`  eBay redirects back with a `code`; we prove the
//                            `state` was ours and exchange the code.
//   4. `ebay_accounts`    the refresh token is stored. Access tokens last two
//                         hours; refresh tokens last eighteen months, which is
//                         what lets a show that starts at 8pm still act at 11.
//
// The redirect target is eBay's "RuName", registered on the application rather
// than chosen here — which is why `EBAY_RUNAME` is configuration and its absence
// is reported as a precise instruction rather than a generic failure.

import type { Pool } from "../../db/pg.js";
import { config } from "../../config.js";
import { EbayError } from "./client.js";

const HOST = {
  sandbox: { api: "https://api.sandbox.ebay.com", auth: "https://auth.sandbox.ebay.com" },
  production: { api: "https://api.ebay.com", auth: "https://auth.ebay.com" },
} as const;

/**
 * What we ask a seller for, and nothing beyond it.
 *
 * `sell.inventory` is the one that matters: it covers the price, quantity and
 * end-listing writes the action executor makes. The readonly scopes are what
 * make importing a catalog from their real listings possible. We do not ask for
 * fulfilment or finances — the product never touches an order, and a consent
 * screen listing powers we do not use is how a seller learns not to read them.
 */
export const USER_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.inventory.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
  // Who the member is — required to honour an account-deletion notice, which
  // arrives as a userId and username and nothing else.
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
];

export interface EbayConnection {
  env: "sandbox" | "production";
  ebayUserId: string | null;
  connectedAt: string;
  /** What eBay actually granted. Can be narrower than USER_SCOPES, and that
   *  difference is the answer to "why did that write fail". */
  scopes: string[];
  /** Whether the refresh token is still good. False means reconnect. */
  valid: boolean;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export class EbayOAuth {
  constructor(
    private d: Pool,
    private creds = config.ebay,
    private fetcher: typeof fetch = fetch,
  ) {}

  private get env(): "sandbox" | "production" {
    return this.creds.env as "sandbox" | "production";
  }

  private get hosts() {
    return HOST[this.env];
  }

  /** Everything the consent flow needs, or a precise account of what is missing. */
  get blockers(): string[] {
    const out: string[] = [];
    if (!this.creds.appId || !this.creds.certId) out.push("EBAY_APP_ID / EBAY_CERT_ID are not set");
    if (!this.creds.ruName) {
      out.push(
        "EBAY_RUNAME is not set — register a redirect URL on the application in the eBay developer portal and paste its RuName here",
      );
    }
    return out;
  }

  /**
   * Start a consent round trip.
   *
   * The `state` is stored against the account that asked for it. That pinning
   * is the whole point: without it, a callback arriving at this server could
   * connect an eBay account to whichever session happened to be open.
   */
  async begin(accountId: string): Promise<{ url: string; state: string }> {
    const blockers = this.blockers;
    if (blockers.length) throw new EbayError(blockers.join("; "), 0, true);

    const state = `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    await this.d.query(
      "INSERT INTO ebay_oauth_states (state, account_id, env) VALUES ($1,$2,$3)",
      [state, accountId, this.env],
    );
    // Housekeeping rather than a job: an abandoned consent is a dead row and
    // there is no reason to keep one for longer than a person takes to sign in.
    await this.d
      .query("DELETE FROM ebay_oauth_states WHERE created_at < now() - interval '1 hour'")
      .catch(() => {});

    const params = new URLSearchParams({
      client_id: this.creds.appId,
      redirect_uri: this.creds.ruName,
      response_type: "code",
      scope: USER_SCOPES.join(" "),
      state,
    });
    return { url: `${this.hosts.auth}/oauth2/authorize?${params.toString()}`, state };
  }

  /**
   * Finish the round trip: prove the state was ours, then exchange the code.
   *
   * An unknown state is not an error to explain away — it is either a stale tab
   * or a callback nobody here asked for, and both are refused.
   */
  async complete(code: string, state: string): Promise<EbayConnection> {
    const row = (
      await this.d.query<{ account_id: string; env: string }>(
        "DELETE FROM ebay_oauth_states WHERE state = $1 RETURNING account_id, env",
        [state],
      )
    ).rows[0];
    if (!row) throw new EbayError("that consent link is stale or was not started here", 400, true);

    const body = await this.token({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.creds.ruName,
    });
    if (!body.refresh_token) {
      throw new EbayError("eBay returned no refresh token — the grant cannot be kept", 400, true);
    }

    const scopes = USER_SCOPES;
    // The identity behind the grant. Best effort: a connection that works is
    // worth more than one refused because the identity call hiccuped — but
    // without it a deletion notice for this member cannot be matched.
    const who = body.access_token ? await this.identity(body.access_token).catch(() => null) : null;
    await this.d.query(
      `INSERT INTO ebay_accounts
         (account_id, env, access_token, access_expires, refresh_token, refresh_expires, scopes,
          ebay_user_id, ebay_username)
       VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval, $5, now() + ($6 || ' seconds')::interval, $7, $8, $9)
       ON CONFLICT (account_id, env) DO UPDATE SET
         access_token = EXCLUDED.access_token, access_expires = EXCLUDED.access_expires,
         refresh_token = EXCLUDED.refresh_token, refresh_expires = EXCLUDED.refresh_expires,
         scopes = EXCLUDED.scopes, connected_at = now(),
         ebay_user_id = COALESCE(EXCLUDED.ebay_user_id, ebay_accounts.ebay_user_id),
         ebay_username = COALESCE(EXCLUDED.ebay_username, ebay_accounts.ebay_username)`,
      [
        row.account_id, row.env, body.access_token,
        String(body.expires_in ?? 7200), body.refresh_token,
        String(body.refresh_token_expires_in ?? 47304000), scopes.join(" "),
        who?.userId ?? null, who?.username ?? null,
      ],
    );

    return {
      env: row.env as "sandbox" | "production",
      ebayUserId: who?.userId ?? null,
      connectedAt: new Date().toISOString(),
      scopes,
      valid: true,
    };
  }

  /**
   * A usable access token for this seller, refreshed if it has aged out.
   *
   * Returns null rather than throwing when there is no connection at all: "this
   * seller has not connected eBay" is an ordinary state the write path checks
   * for, not an exception.
   */
  async userToken(accountId: string): Promise<string | null> {
    const row = (
      await this.d.query<{
        access_token: string; access_expires: string; refresh_token: string;
        refresh_expires: string | null;
      }>(
        `SELECT access_token, access_expires, refresh_token, refresh_expires
           FROM ebay_accounts WHERE account_id = $1 AND env = $2`,
        [accountId, this.env],
      )
    ).rows[0];
    if (!row) return null;

    // A minute of headroom: a token that expires mid-request is a failed write
    // that looks like a permissions problem.
    if (new Date(row.access_expires).getTime() - 60_000 > Date.now()) return row.access_token;

    if (row.refresh_expires && new Date(row.refresh_expires).getTime() < Date.now()) {
      throw new EbayError("this eBay connection has expired — reconnect to act again", 401, true);
    }

    const body = await this.token({
      grant_type: "refresh_token",
      refresh_token: row.refresh_token,
      scope: USER_SCOPES.join(" "),
    });
    await this.d.query(
      `UPDATE ebay_accounts
          SET access_token = $3, access_expires = now() + ($4 || ' seconds')::interval
        WHERE account_id = $1 AND env = $2`,
      [accountId, this.env, body.access_token, String(body.expires_in ?? 7200)],
    );
    return body.access_token ?? null;
  }

  async connection(accountId: string): Promise<EbayConnection | null> {
    const row = (
      await this.d.query<{
        env: string; ebay_user_id: string | null; connected_at: string;
        scopes: string; refresh_expires: string | null;
      }>(
        `SELECT env, ebay_user_id, connected_at, scopes, refresh_expires
           FROM ebay_accounts WHERE account_id = $1 AND env = $2`,
        [accountId, this.env],
      )
    ).rows[0];
    if (!row) return null;
    return {
      env: row.env as "sandbox" | "production",
      ebayUserId: row.ebay_user_id,
      connectedAt: row.connected_at,
      scopes: row.scopes.split(" ").filter(Boolean),
      valid: !row.refresh_expires || new Date(row.refresh_expires).getTime() > Date.now(),
    };
  }

  /** `GET /commerce/identity/v1/user/` — the member's id and username. */
  private async identity(accessToken: string): Promise<{ userId: string | null; username: string | null }> {
    const res = await this.fetcher(`${this.hosts.api}/commerce/identity/v1/user/`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) throw new EbayError(`identity ${res.status}`, res.status, false);
    const j = (await res.json()) as { userId?: unknown; username?: unknown };
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return { userId: str(j.userId), username: str(j.username) };
  }

  async disconnect(accountId: string): Promise<void> {
    await this.d.query("DELETE FROM ebay_accounts WHERE account_id = $1 AND env = $2", [
      accountId,
      this.env,
    ]);
  }

  private async token(fields: Record<string, string>): Promise<TokenResponse> {
    const basic = Buffer.from(`${this.creds.appId}:${this.creds.certId}`).toString("base64");
    const res = await this.fetcher(`${this.hosts.api}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams(fields).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !body.access_token) {
      // `invalid_grant` on an authorisation code almost always means the
      // redirect_uri differed from the one the code was issued against — say
      // which value we sent, because eBay's message does not.
      const said = body.error_description || body.error || `${res.status}`;
      throw new EbayError(
        `eBay refused the ${fields.grant_type} exchange — ${said} (redirect_uri "${this.creds.ruName || "unset"}")`,
        res.status,
        true,
      );
    }
    return body;
  }
}
