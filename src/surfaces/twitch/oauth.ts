// Getting the refresh token without anybody pasting a refresh token.
//
// `TWITCH_BOT_REFRESH_TOKEN` is a working answer and a bad instruction. The
// only ways to produce one by hand are a CLI that wants your client secret or a
// third-party site that offers to mint one for you, and the second is somebody
// else holding a token that can talk in your chat. Neither belongs in a setup
// guide, so this is the consent round trip instead: the operator clicks a link,
// approves the scopes on Twitch's own page, and the token never passes through
// a human's clipboard.
//
// The shape is `ingest/ebay/oauth.ts`, deliberately and almost line for line —
// a one-time `state` pinned to the account that asked for it, an exchange that
// refuses a state it did not issue, and the refresh token sealed at rest. That
// file's reasoning is the reasoning here; what differs is Twitch's:
//
//   THE REDIRECT IS A URL, NOT A NAME. eBay redirects to an "RuName" registered
//   on the application. Twitch redirects to a literal URL that must match the
//   registered one byte for byte at both ends of the exchange, which is why
//   TWITCH_REDIRECT_URI is configuration and is sent on the exchange too.
//
//   THE REFRESH TOKEN ROTATES. Twitch may return a new one on any refresh. It
//   is written back here; a process reading the token out of the environment
//   cannot write anything back, which is the other reason this flow exists.

import type { Pool } from "../../db/pg.js";
import { config } from "../../config.js";
import { openToken, sealToken } from "../../ingest/ebay/seal.js";
import { TwitchApi, TwitchApiError } from "./api.js";

const ID = "https://id.twitch.tv";

/**
 * What we ask the bot account for, and nothing beyond it.
 *
 * Every scope below is spent by a call in `api.ts`. A consent screen listing
 * powers we never use is how an operator learns not to read them — and on
 * Twitch the powers are alarming in a way eBay's are not, because they are
 * powers over a live audience.
 */
export const TWITCH_SCOPES = [
  "user:read:chat",                    // EventSub channel.chat.message — the read path
  "user:write:chat",                   // POST /chat/messages — post_reply
  "user:bot",                          // lets the account act as a chat bot at all
  "channel:bot",                       // …in a channel that has authorised it
  "clips:edit",                        // POST /clips — create_clip
  "channel:manage:broadcast",          // POST /streams/markers — mark_highlight
  "channel:manage:polls",              // POST/PATCH /polls — run_poll and its undo
  "channel:read:polls",                // GET /polls — refusing a second concurrent poll
  "moderator:manage:announcements",    // POST /chat/announcements — pin_message
  "moderator:manage:shoutouts",        // POST /chat/shoutouts — shoutout
  "moderator:manage:chat_messages",    // DELETE /moderation/chat — undoing a post_reply
  // chat:read and chat:edit are the IRC fallback's scopes (chat.ts). Asked for
  // here so that switching transports is a constant, not a reconsent.
  "chat:read",
  "chat:edit",
];

export interface TwitchConnection {
  twitchUserId: string | null;
  twitchLogin: string | null;
  connectedAt: string;
  scopes: string[];
  valid: boolean;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string[] | string;
  message?: string;
}

export class TwitchOAuth {
  constructor(
    private d: Pool,
    private creds = config.twitch,
    private fetcher: typeof fetch = fetch,
  ) {}

  /** Everything the consent flow needs, or a precise account of what is missing. */
  get blockers(): string[] {
    const out: string[] = [];
    if (!this.creds.clientId || !this.creds.clientSecret) {
      out.push("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are not set — register an application at dev.twitch.tv/console");
    }
    if (!this.creds.redirectUri) {
      out.push(
        "TWITCH_REDIRECT_URI is not set — add this server's /api/twitch/callback URL to the application's OAuth Redirect URLs and paste the same value here",
      );
    }
    return out;
  }

  /**
   * Start a consent round trip.
   *
   * `force_verify` is on: without it Twitch silently reuses whichever account
   * the operator's browser is already signed into, which is how somebody
   * connects their personal account while trying to connect the bot.
   */
  async begin(accountId: string): Promise<{ url: string; state: string }> {
    const blockers = this.blockers;
    if (blockers.length) throw new TwitchApiError(400, blockers.join("; "));

    const state = `tw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    await this.d.query("INSERT INTO twitch_oauth_states (state, account_id) VALUES ($1,$2)", [state, accountId]);
    // An abandoned consent is a dead row, and there is no reason to keep one
    // for longer than a person takes to sign in.
    await this.d
      .query("DELETE FROM twitch_oauth_states WHERE created_at < now() - interval '1 hour'")
      .catch(() => {});

    const params = new URLSearchParams({
      client_id: this.creds.clientId,
      redirect_uri: this.creds.redirectUri,
      response_type: "code",
      scope: TWITCH_SCOPES.join(" "),
      force_verify: "true",
      state,
    });
    return { url: `${ID}/oauth2/authorize?${params}`, state };
  }

  /**
   * Finish the round trip: prove the state was ours, then exchange the code.
   *
   * An unknown state is either a stale tab or a callback nobody here asked for,
   * and both are refused rather than explained away.
   */
  async complete(code: string, state: string): Promise<TwitchConnection> {
    const row = (
      await this.d.query<{ account_id: string }>(
        "DELETE FROM twitch_oauth_states WHERE state = $1 RETURNING account_id",
        [state],
      )
    ).rows[0];
    if (!row) throw new TwitchApiError(400, "that consent link is stale or was not started here");

    const body = await this.token({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.creds.redirectUri,
    });
    if (!body.refresh_token) {
      throw new TwitchApiError(400, "twitch returned no refresh token — the grant cannot be kept");
    }

    const scopes = Array.isArray(body.scope) ? body.scope : String(body.scope || "").split(" ").filter(Boolean);
    // Who the grant belongs to. Best effort: a connection that works is worth
    // more than one refused because the identity call hiccuped — but without it
    // the console cannot say which account is about to talk in chat.
    const who = body.access_token ? await this.identity(body.access_token).catch(() => null) : null;

    await this.d.query(
      `INSERT INTO twitch_accounts
         (account_id, twitch_user_id, twitch_login, access_token, access_expires, refresh_token, scopes)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval, $6, $7)
       ON CONFLICT (account_id) DO UPDATE SET
         twitch_user_id = COALESCE(EXCLUDED.twitch_user_id, twitch_accounts.twitch_user_id),
         twitch_login   = COALESCE(EXCLUDED.twitch_login, twitch_accounts.twitch_login),
         access_token = EXCLUDED.access_token, access_expires = EXCLUDED.access_expires,
         refresh_token = EXCLUDED.refresh_token, scopes = EXCLUDED.scopes, connected_at = now()`,
      [
        row.account_id, who?.id ?? null, who?.login ?? null,
        sealToken(body.access_token), String(body.expires_in ?? 14_400),
        sealToken(body.refresh_token), scopes.join(" "),
      ],
    );

    return {
      twitchUserId: who?.id ?? null,
      twitchLogin: who?.login ?? null,
      connectedAt: new Date().toISOString(),
      scopes,
      valid: true,
    };
  }

  /**
   * A usable access token for this operator's bot account.
   *
   * Null rather than an exception when there is no connection at all: "this
   * operator has not connected Twitch" is an ordinary state the attach path
   * checks for, not a failure.
   */
  async userToken(accountId: string): Promise<string | null> {
    const row = (
      await this.d.query<{ access_token: string; access_expires: string; refresh_token: string }>(
        "SELECT access_token, access_expires, refresh_token FROM twitch_accounts WHERE account_id = $1",
        [accountId],
      )
    ).rows[0];
    if (!row) return null;

    // A minute of headroom: a token that expires mid-request is a failed write
    // that looks like a permissions problem.
    if (new Date(row.access_expires).getTime() - 60_000 > Date.now()) return openToken(row.access_token);

    const body = await this.token({
      grant_type: "refresh_token",
      refresh_token: openToken(row.refresh_token) ?? "",
    });
    await this.d.query(
      `UPDATE twitch_accounts
          SET access_token = $2, access_expires = now() + ($3 || ' seconds')::interval,
              refresh_token = COALESCE($4, refresh_token)
        WHERE account_id = $1`,
      [
        accountId, sealToken(body.access_token), String(body.expires_in ?? 14_400),
        // Twitch rotates this on some grants. Storing the new one is the whole
        // reason a connection outlives the first four hours.
        body.refresh_token ? sealToken(body.refresh_token) : null,
      ],
    );
    return body.access_token ?? null;
  }

  /** The credentials a `TwitchApi` needs for this operator, or null when they
   *  have not connected. The refresh token is handed over opened, and rotations
   *  are written straight back. */
  async apiFor(accountId: string): Promise<TwitchApi | null> {
    const row = (
      await this.d.query<{ refresh_token: string }>(
        "SELECT refresh_token FROM twitch_accounts WHERE account_id = $1",
        [accountId],
      )
    ).rows[0];
    if (!row) return null;
    return new TwitchApi(
      {
        clientId: this.creds.clientId,
        clientSecret: this.creds.clientSecret,
        botRefreshToken: openToken(row.refresh_token) ?? "",
      },
      {
        fetcher: this.fetcher,
        onRefreshToken: async (next) => {
          await this.d.query("UPDATE twitch_accounts SET refresh_token = $2 WHERE account_id = $1", [
            accountId, sealToken(next),
          ]);
        },
      },
    );
  }

  async connection(accountId: string): Promise<TwitchConnection | null> {
    const row = (
      await this.d.query<{
        twitch_user_id: string | null; twitch_login: string | null;
        connected_at: string; scopes: string;
      }>(
        "SELECT twitch_user_id, twitch_login, connected_at, scopes FROM twitch_accounts WHERE account_id = $1",
        [accountId],
      )
    ).rows[0];
    if (!row) return null;
    return {
      twitchUserId: row.twitch_user_id,
      twitchLogin: row.twitch_login,
      connectedAt: new Date(row.connected_at).toISOString(),
      scopes: row.scopes.split(" ").filter(Boolean),
      // Twitch refresh tokens do not carry an expiry; they die when the user
      // revokes them or the secret is rotated, and the first refused refresh is
      // how we find out. A row that exists is a connection worth trying.
      valid: true,
    };
  }

  async disconnect(accountId: string): Promise<void> {
    await this.d.query("DELETE FROM twitch_accounts WHERE account_id = $1", [accountId]);
  }

  private async identity(accessToken: string): Promise<{ id: string; login: string } | null> {
    const res = await this.fetcher("https://api.twitch.tv/helix/users", {
      headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": this.creds.clientId },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { id?: string; login?: string }[] };
    const u = j.data?.[0];
    return u?.id ? { id: u.id, login: (u.login ?? "").toLowerCase() } : null;
  }

  private async token(fields: Record<string, string>): Promise<TokenResponse> {
    const res = await this.fetcher(`${ID}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...fields,
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !body.access_token) {
      // Twitch says "Invalid authorization code" for a redirect_uri mismatch as
      // often as for a genuinely bad code, so name the value we sent — that is
      // the difference between a two-minute fix and an afternoon.
      throw new TwitchApiError(
        res.status,
        `twitch refused the ${fields.grant_type} exchange — ${body.message || res.status} (redirect_uri "${this.creds.redirectUri || "unset"}")`,
      );
    }
    return body;
  }
}
