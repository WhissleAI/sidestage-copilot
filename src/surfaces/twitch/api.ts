// Helix, small enough to read in one sitting.
//
// This is not a Twitch SDK. It is the six calls the Twitch surface actually
// makes, plus the two token grants that make them possible, and nothing else —
// the same posture `ingest/ebay/client.ts` takes toward the Sell API.
//
// The part worth knowing before reading further is that Twitch issues two
// different tokens and they are not interchangeable:
//
//   APP token (client credentials).  Mints from the id and secret alone.
//     Reads public things: who a channel is, what it is playing. It cannot
//     read chat, cut a clip, run a poll or say a word, and the failure when
//     you try is a 401 that does not mention which kind of token it wanted.
//
//   USER token (refresh grant).  Acts AS the bot account. Everything this
//     surface does that a viewer would notice needs one. It lasts about four
//     hours, which is shorter than a long stream, so it is refreshed on demand
//     with a minute of headroom rather than at open().
//
// Twitch rotates the refresh token on some grants and not others. When it
// returns a new one, `onRefreshToken` is how the caller persists it — the
// OAuth store does; a process holding TWITCH_BOT_REFRESH_TOKEN from the
// environment cannot, and says so once rather than silently drifting toward a
// token that no longer works.

import { SurfaceUnavailable } from "../types.js";

const ID = "https://id.twitch.tv";
const HELIX = "https://api.twitch.tv/helix";

export interface TwitchCreds {
  clientId: string;
  clientSecret: string;
  /** The bot account's refresh token — the only thing that mints a user token
   *  without a browser. See `oauth.ts` for where operators get one. */
  botRefreshToken: string;
}

/**
 * Which variable is missing, in the order an operator would set them.
 *
 * Returns the FIRST one rather than a list on purpose: the consent flow issues
 * the refresh token, and there is no point telling someone their refresh token
 * is missing when they have not registered an application yet.
 */
export function missingTwitchKey(c: Partial<TwitchCreds> | undefined): string | null {
  if (!c?.clientId) return "TWITCH_CLIENT_ID";
  if (!c.clientSecret) return "TWITCH_CLIENT_SECRET";
  if (!c.botRefreshToken) return "TWITCH_BOT_REFRESH_TOKEN";
  return null;
}

/** The typed refusal the adapter's `open()` throws, naming the variable. */
export function requireTwitchCreds(c: Partial<TwitchCreds> | undefined): TwitchCreds {
  const missing = missingTwitchKey(c);
  if (missing) throw new SurfaceUnavailable("twitch", `twitch: ${missing} is not set`, missing);
  return c as TwitchCreds;
}

export class TwitchApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "TwitchApiError";
  }
}

export interface TwitchUser { id: string; login: string; displayName: string }
export interface TwitchStream { id: string; title: string; gameName: string; startedAt: string }
/** A stream as the DISCOVERY reads list them — the same row, plus who is
 *  running it and how many people are there, which `stream()` has no caller
 *  for and a grid of candidates cannot do without. */
export interface TwitchLiveStream extends TwitchStream {
  userId: string;
  userLogin: string;
  userName: string;
  viewerCount: number | null;
  gameId: string;
}
export interface TwitchCategory { id: string; name: string }
export interface TwitchClip { id: string; editUrl: string; url: string }
export interface TwitchPoll { id: string; title: string; status: string }
export interface TwitchSentMessage { messageId: string; isSent: boolean; dropReason: string | null }

interface TokenBody {
  access_token?: string; refresh_token?: string; expires_in?: number;
  status?: number; message?: string;
}

export interface TwitchApiOpts {
  fetcher?: typeof fetch;
  /** Called when Twitch rotates the refresh token, so the caller can store the
   *  new one. Without it the rotation is announced and dropped. */
  onRefreshToken?(next: string): void | Promise<void>;
}

export class TwitchApi {
  private readonly fetcher: typeof fetch;
  private readonly onRefreshToken?: TwitchApiOpts["onRefreshToken"];

  private refreshToken: string;
  private user: { token: string; expires: number } | null = null;
  private app: { token: string; expires: number } | null = null;
  /** login → user, because the id of a channel does not change and every call
   *  below is keyed by id while every human names a channel by login. */
  private users = new Map<string, TwitchUser>();
  private warnedRotation = false;

  constructor(private readonly creds: TwitchCreds, opts: TwitchApiOpts = {}) {
    this.fetcher = opts.fetcher ?? fetch;
    this.onRefreshToken = opts.onRefreshToken;
    this.refreshToken = creds.botRefreshToken;
  }

  // ── tokens ────────────────────────────────────────────────────────────────

  /** A usable user token, refreshed when it is within a minute of expiring.
   *  A token that dies mid-request reads as a permissions problem, which is the
   *  most expensive kind of error to debug on someone else's platform. */
  async userToken(): Promise<string> {
    if (this.user && this.user.expires - 60_000 > Date.now()) return this.user.token;
    const body = await this.token({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
    });
    if (!body.access_token) {
      throw new TwitchApiError(401, "twitch refused the refresh grant — reconnect the bot account");
    }
    if (body.refresh_token && body.refresh_token !== this.refreshToken) {
      this.refreshToken = body.refresh_token;
      if (this.onRefreshToken) await this.onRefreshToken(body.refresh_token);
      else if (!this.warnedRotation) {
        this.warnedRotation = true;
        console.warn(
          "  twitch: the refresh token rotated and nothing is storing it — TWITCH_BOT_REFRESH_TOKEN in the environment will stop working",
        );
      }
    }
    this.user = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 14_400) * 1000 };
    return this.user.token;
  }

  async appToken(): Promise<string> {
    if (this.app && this.app.expires - 60_000 > Date.now()) return this.app.token;
    const body = await this.token({
      grant_type: "client_credentials",
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
    });
    if (!body.access_token) throw new TwitchApiError(401, "twitch refused the client-credentials grant");
    this.app = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 5_000_000) * 1000 };
    return this.app.token;
  }

  private async token(fields: Record<string, string>): Promise<TokenBody> {
    const res = await this.fetcher(`${ID}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as TokenBody;
    if (!res.ok) {
      // Twitch's token errors are one line and usually exact ("Invalid refresh
      // token"); pass it through rather than replacing it with our own guess.
      throw new TwitchApiError(res.status, `twitch ${fields.grant_type} failed: ${body.message || res.status}`);
    }
    return body;
  }

  // ── the call ──────────────────────────────────────────────────────────────

  private async call<T>(
    path: string,
    init: RequestInit & { as?: "user" | "app" } = {},
  ): Promise<T> {
    const { as = "user", ...rest } = init;
    const token = as === "app" ? await this.appToken() : await this.userToken();
    const res = await this.fetcher(`${HELIX}${path}`, {
      ...rest,
      headers: {
        Authorization: `Bearer ${token}`,
        "Client-Id": this.creds.clientId,
        "Content-Type": "application/json",
        ...(rest.headers as Record<string, string> | undefined),
      },
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      // A Helix error is `{error, status, message}`; the message is the half a
      // human can act on ("The broadcaster is not streaming").
      let said = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { message?: string; error?: string };
        said = j.message || j.error || said;
      } catch {
        /* not JSON */
      }
      throw new TwitchApiError(res.status, `twitch ${path.split("?")[0]} ${res.status}: ${said}`);
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  /** The bot account behind the user token. Its id is half of every chat
   *  subscription's condition and the sender of every message we send. */
  async self(): Promise<TwitchUser> {
    const cached = this.users.get("");
    if (cached) return cached;
    const u = first(await this.call<{ data?: RawUser[] }>("/users"));
    if (!u) throw new TwitchApiError(401, "twitch returned no user for this token");
    const out = toUser(u);
    this.users.set("", out);
    this.users.set(out.login, out);
    return out;
  }

  async userByLogin(login: string): Promise<TwitchUser | null> {
    const key = login.toLowerCase();
    const cached = this.users.get(key);
    if (cached) return cached;
    const u = first(await this.call<{ data?: RawUser[] }>(`/users?login=${encodeURIComponent(key)}`));
    if (!u) return null;
    const out = toUser(u);
    this.users.set(key, out);
    return out;
  }

  /** The live stream, or null when the channel is offline. Null is the answer
   *  to "can this be clipped", which is why it is a read and not an assumption. */
  async stream(broadcasterId: string): Promise<TwitchStream | null> {
    const s = first(
      await this.call<{ data?: RawStream[] }>(`/streams?user_id=${encodeURIComponent(broadcasterId)}`),
    );
    return s ? { id: s.id, title: s.title ?? "", gameName: s.game_name ?? "", startedAt: s.started_at ?? "" } : null;
  }

  /** The channel's own title and category, which exist whether or not it is
   *  live — an offline channel still has a name to show in the console. */
  async channel(broadcasterId: string): Promise<{ title: string; gameName: string } | null> {
    const c = first(
      await this.call<{ data?: { title?: string; game_name?: string }[] }>(
        `/channels?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
      ),
    );
    return c ? { title: c.title ?? "", gameName: c.game_name ?? "" } : null;
  }

  // ── discovery ─────────────────────────────────────────────────────────────
  //
  // Both of these run on the APP token, and that is the whole point. Listing
  // what is live on Twitch and naming a category need no user, no consent and
  // no bot account — which is why the claim that this surface had "a discovery
  // page behind an app review" was wrong, and why Discover could have been
  // reading Twitch since the day the client id was set.

  /**
   * Twitch's own name for a thing, so a stream can be found by category rather
   * than only by whatever the streamer typed in their title.
   *
   * `search/categories` is a prefix/substring search over game and category
   * names: "pokemon" finds "Pokémon Trading Card Game" and "Pokémon Scarlet",
   * and the ids are what `/streams` filters on.
   */
  async searchCategories(query: string, limit = 5): Promise<TwitchCategory[]> {
    const q = new URLSearchParams({ query, first: String(Math.min(100, Math.max(1, limit))) });
    const body = await this.call<{ data?: { id: string; name?: string }[] }>(
      `/search/categories?${q}`,
      { as: "app" },
    );
    return (body.data ?? []).map((c) => ({ id: c.id, name: c.name ?? "" }));
  }

  /**
   * Live streams, optionally narrowed to categories.
   *
   * With no `gameIds` this is Twitch's front page, ordered by audience, which
   * is only useful as a haystack to match titles against. With them it is the
   * live rooms for the things the operator sells.
   *
   * Helix takes repeated `game_id` parameters, up to 100 of them, so a handful
   * of interests costs ONE request rather than one apiece. `viewerCount` is
   * carried through as null when Twitch omits it rather than as 0 — nobody
   * measured zero.
   */
  async liveStreams(opts: { gameIds?: string[]; limit?: number } = {}): Promise<TwitchLiveStream[]> {
    const q = new URLSearchParams({ first: String(Math.min(100, Math.max(1, opts.limit ?? 40))) });
    for (const id of (opts.gameIds ?? []).slice(0, 100)) q.append("game_id", id);
    const body = await this.call<{ data?: RawLiveStream[] }>(`/streams?${q}`, { as: "app" });
    return (body.data ?? []).map((s) => ({
      id: s.id,
      title: s.title ?? "",
      gameName: s.game_name ?? "",
      gameId: s.game_id ?? "",
      startedAt: s.started_at ?? "",
      userId: s.user_id ?? "",
      userLogin: (s.user_login ?? "").toLowerCase(),
      userName: s.user_name || s.user_login || "",
      viewerCount: typeof s.viewer_count === "number" ? s.viewer_count : null,
    }));
  }

  /** The most recent polls, newest first. Used to refuse a second poll rather
   *  than discover from a 400 that one is already running. */
  async polls(broadcasterId: string): Promise<TwitchPoll[]> {
    const body = await this.call<{ data?: RawPoll[] }>(
      `/polls?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
    );
    return (body.data ?? []).map((p) => ({ id: p.id, title: p.title ?? "", status: p.status ?? "" }));
  }

  // ── writes ────────────────────────────────────────────────────────────────

  async createClip(broadcasterId: string): Promise<TwitchClip> {
    const c = first(
      await this.call<{ data?: { id: string; edit_url?: string }[] }>(
        `/clips?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
        { method: "POST" },
      ),
    );
    if (!c) throw new TwitchApiError(502, "twitch accepted the clip and named none");
    // Twitch returns the edit URL and leaves the public one to be composed. A
    // clip takes a few seconds to render, so this URL 404s briefly — that is
    // the platform's behaviour, not a failed write.
    return { id: c.id, editUrl: c.edit_url ?? "", url: `https://clips.twitch.tv/${c.id}` };
  }

  /** A stream marker: a timestamp in the broadcaster's own VOD, which is what
   *  "mark this" means on Twitch. Needs the channel to be live. */
  async createMarker(broadcasterId: string, description: string): Promise<{ id: string; positionSeconds: number }> {
    const m = first(
      await this.call<{ data?: { id: string; position_seconds?: number }[] }>("/streams/markers", {
        method: "POST",
        body: JSON.stringify({ user_id: broadcasterId, description: description.slice(0, 140) }),
      }),
    );
    if (!m) throw new TwitchApiError(502, "twitch accepted the marker and named none");
    return { id: m.id, positionSeconds: m.position_seconds ?? 0 };
  }

  async createPoll(
    broadcasterId: string,
    poll: { title: string; choices: string[]; durationSeconds: number },
  ): Promise<TwitchPoll> {
    const p = first(
      await this.call<{ data?: RawPoll[] }>("/polls", {
        method: "POST",
        body: JSON.stringify({
          broadcaster_id: broadcasterId,
          title: poll.title,
          choices: poll.choices.map((title) => ({ title })),
          duration: poll.durationSeconds,
        }),
      }),
    );
    if (!p) throw new TwitchApiError(502, "twitch accepted the poll and named none");
    return { id: p.id, title: p.title ?? poll.title, status: p.status ?? "ACTIVE" };
  }

  /**
   * End a running poll.
   *
   * `ARCHIVED` rather than `TERMINATED`: terminating ends the poll and leaves
   * the result on screen, which is the right thing when a poll has run its
   * course and the wrong thing when someone is undoing a poll that should
   * never have been started.
   */
  async endPoll(broadcasterId: string, pollId: string, status: "ARCHIVED" | "TERMINATED" = "ARCHIVED"): Promise<TwitchPoll> {
    const p = first(
      await this.call<{ data?: RawPoll[] }>("/polls", {
        method: "PATCH",
        body: JSON.stringify({ broadcaster_id: broadcasterId, id: pollId, status }),
      }),
    );
    return { id: pollId, title: p?.title ?? "", status: p?.status ?? status };
  }

  /** A highlighted line in chat. The closest thing Helix gives a bot to
   *  pinning — see the note on `pin_message` in actions.ts. */
  async announce(broadcasterId: string, moderatorId: string, message: string): Promise<void> {
    await this.call<void>(
      `/chat/announcements?broadcaster_id=${encodeURIComponent(broadcasterId)}&moderator_id=${encodeURIComponent(moderatorId)}`,
      { method: "POST", body: JSON.stringify({ message: message.slice(0, 500) }) },
    );
  }

  async shoutout(broadcasterId: string, moderatorId: string, toBroadcasterId: string): Promise<void> {
    const q = new URLSearchParams({
      from_broadcaster_id: broadcasterId,
      to_broadcaster_id: toBroadcasterId,
      moderator_id: moderatorId,
    });
    await this.call<void>(`/chat/shoutouts?${q}`, { method: "POST" });
  }

  /**
   * Say something in chat.
   *
   * Returns Twitch's own message id, which is the only reason a posted reply is
   * undoable at all: `deleteMessage` takes exactly this id. `isSent` false with
   * a `dropReason` is a message AutoMod held — a 200 that did not reach anybody,
   * and reporting it as sent would be the worst available answer.
   */
  async sendMessage(
    broadcasterId: string,
    senderId: string,
    message: string,
    replyToMessageId?: string,
  ): Promise<TwitchSentMessage> {
    const body = await this.call<{ data?: RawSent[] }>("/chat/messages", {
      method: "POST",
      body: JSON.stringify({
        broadcaster_id: broadcasterId,
        sender_id: senderId,
        message: message.slice(0, 500),
        ...(replyToMessageId ? { reply_parent_message_id: replyToMessageId } : {}),
      }),
    });
    const d = first(body);
    if (!d) throw new TwitchApiError(502, "twitch accepted the message and named none");
    return {
      messageId: d.message_id ?? "",
      isSent: d.is_sent !== false,
      dropReason: d.drop_reason?.message ?? d.drop_reason?.code ?? null,
    };
  }

  async deleteMessage(broadcasterId: string, moderatorId: string, messageId: string): Promise<void> {
    const q = new URLSearchParams({
      broadcaster_id: broadcasterId,
      moderator_id: moderatorId,
      message_id: messageId,
    });
    await this.call<void>(`/moderation/chat?${q}`, { method: "DELETE" });
  }

  /** Subscribe this EventSub websocket session to a channel's chat. Separated
   *  from `chat.ts` because it is an ordinary Helix POST and belongs with the
   *  rest of them. */
  async subscribeChat(sessionId: string, broadcasterId: string, botUserId: string): Promise<string> {
    const body = await this.call<{ data?: { id: string }[] }>("/eventsub/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        type: "channel.chat.message",
        version: "1",
        condition: { broadcaster_user_id: broadcasterId, user_id: botUserId },
        transport: { method: "websocket", session_id: sessionId },
      }),
    });
    return first(body)?.id ?? "";
  }
}

interface RawUser { id: string; login?: string; display_name?: string }
interface RawStream { id: string; title?: string; game_name?: string; started_at?: string }
interface RawLiveStream extends RawStream {
  game_id?: string; user_id?: string; user_login?: string; user_name?: string; viewer_count?: number;
}
interface RawPoll { id: string; title?: string; status?: string }
interface RawSent { message_id?: string; is_sent?: boolean; drop_reason?: { code?: string; message?: string } }

const first = <T>(body: { data?: T[] } | undefined): T | undefined => body?.data?.[0];
const toUser = (u: RawUser): TwitchUser => ({
  id: u.id,
  login: (u.login ?? "").toLowerCase(),
  displayName: u.display_name || u.login || u.id,
});
