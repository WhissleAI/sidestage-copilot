// Reading a Twitch channel's chat.
//
// PRIMARY: EventSub over WebSocket, `channel.chat.message`.
// FALLBACK: IRC over TLS, behind `CHAT_TRANSPORT`.
//
// The choice is not a preference. IRC is where Twitch chat came from and it
// still works, but it is frozen: Twitch's own guidance points new work at
// EventSub, and the things this product needs are only on that side of the
// line. A chat message arrives as a structured event with typed fragments
// (emote, cheermote, mention) instead of a tag soup to re-parse, it carries the
// SAME `message_id` that `DELETE /helix/moderation/chat` takes — which is the
// only reason a posted reply is undoable at all (actions.ts) — and it
// authenticates with the same user token as every write, so a channel that can
// be read can be spoken to without a second credential that expires on its own
// schedule.
//
// IRC survives here for the case EventSub cannot serve: a websocket session is
// capped at 300 subscriptions and one chat read per session is a subscription,
// so a deployment watching hundreds of channels from one process runs out where
// an IRC connection just joins another channel. Nobody is watching hundreds of
// channels yet. The constant exists so that when somebody is, the fallback is a
// one-line change against code that was written next to the thing it replaces,
// rather than an integration invented under load.
//
// Both paths converge on `onMessage`, and both dedupe by the id Twitch gives.
// Deduping matters more than it looks: EventSub explicitly redelivers on
// reconnect, so a dropped socket during a busy stream replays messages that
// were already answered, and an answered question asked twice is the failure
// mode buyers notice first.

import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { SurfaceEvents } from "../types.js";
import type { TwitchApi } from "./api.js";

/** Which transport reads chat. EventSub unless a deployment outgrows it. */
export const CHAT_TRANSPORT: "eventsub" | "irc" = "eventsub";

export const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
const IRC_HOST = "irc.chat.twitch.tv";
const IRC_PORT = 6697;

// ── the wire, as data ────────────────────────────────────────────────────────
//
// Parsing is a pure function over a string so the frame shapes can be tested
// against recorded traffic with no socket, no token and no network. Every
// behaviour below this line is a decision made ON one of these values.

export type TwitchFrame =
  | { type: "welcome"; messageId: string; sessionId: string; keepaliveSeconds: number }
  | { type: "keepalive"; messageId: string }
  | { type: "reconnect"; messageId: string; reconnectUrl: string }
  | { type: "message"; messageId: string; chat: TwitchChatMessage }
  | { type: "revocation"; messageId: string; reason: string }
  | { type: "unknown"; messageId: string; detail: string };

export interface TwitchChatMessage {
  /** Twitch's id for the chat message itself — the one the delete endpoint
   *  takes. Distinct from the envelope's `messageId`, which identifies the
   *  DELIVERY and is what Twitch tells you to dedupe on. */
  id: string;
  channel: string;
  author: string;
  authorId: string;
  text: string;
  at: string;
  /** Set when the viewer used Twitch's reply-to, so a thread is a thread. */
  parentId?: string;
}

export function readFrame(raw: string): TwitchFrame {
  let j: EventSubEnvelope;
  try {
    j = JSON.parse(raw) as EventSubEnvelope;
  } catch {
    return { type: "unknown", messageId: "", detail: "frame was not JSON" };
  }
  const messageId = j.metadata?.message_id ?? "";
  switch (j.metadata?.message_type) {
    case "session_welcome":
      return {
        type: "welcome",
        messageId,
        sessionId: j.payload?.session?.id ?? "",
        // Twitch names its own keepalive interval in the welcome. Trusting it
        // beats a constant: the value is negotiable per connection.
        keepaliveSeconds: j.payload?.session?.keepalive_timeout_seconds ?? 10,
      };
    case "session_keepalive":
      return { type: "keepalive", messageId };
    case "session_reconnect":
      return { type: "reconnect", messageId, reconnectUrl: j.payload?.session?.reconnect_url ?? "" };
    case "revocation":
      return {
        type: "revocation",
        messageId,
        reason: j.payload?.subscription?.status ?? "revoked",
      };
    case "notification": {
      const e = j.payload?.event;
      if (j.metadata.subscription_type !== "channel.chat.message" || !e) {
        return { type: "unknown", messageId, detail: j.metadata.subscription_type ?? "notification" };
      }
      return {
        type: "message",
        messageId,
        chat: {
          id: e.message_id ?? messageId,
          channel: e.broadcaster_user_login ?? "",
          // The display name is what the channel sees; the login is what it is
          // typed as. The console shows the first and nothing reads the second.
          author: e.chatter_user_name || e.chatter_user_login || "viewer",
          authorId: e.chatter_user_id ?? "",
          text: e.message?.text ?? "",
          at: j.metadata.message_timestamp ?? new Date().toISOString(),
          ...(e.reply?.parent_message_id ? { parentId: e.reply.parent_message_id } : {}),
        },
      };
    }
    default:
      return { type: "unknown", messageId, detail: j.metadata?.message_type ?? "no message_type" };
  }
}

interface EventSubEnvelope {
  metadata?: {
    message_id?: string;
    message_type?: string;
    message_timestamp?: string;
    subscription_type?: string;
  };
  payload?: {
    session?: { id?: string; keepalive_timeout_seconds?: number; reconnect_url?: string };
    subscription?: { status?: string };
    event?: {
      broadcaster_user_login?: string;
      chatter_user_id?: string;
      chatter_user_login?: string;
      chatter_user_name?: string;
      message_id?: string;
      message?: { text?: string };
      reply?: { parent_message_id?: string };
    };
  };
}

/**
 * One IRC line, as the fallback would see it.
 *
 * Kept next to `readFrame` and tested the same way, because the whole value of
 * a documented fallback is that it is known to work on the day it is needed.
 * `@id=…;display-name=… :user!user@user.tmi.twitch.tv PRIVMSG #channel :text`
 */
export function parseIrcLine(line: string): TwitchChatMessage | { ping: string } | null {
  const l = line.trim();
  if (!l) return null;
  if (l.startsWith("PING")) return { ping: l.slice(4).trim() || ":tmi.twitch.tv" };

  const tags = new Map<string, string>();
  let rest = l;
  if (rest.startsWith("@")) {
    const cut = rest.indexOf(" ");
    for (const pair of rest.slice(1, cut).split(";")) {
      const eq = pair.indexOf("=");
      if (eq > 0) tags.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    rest = rest.slice(cut + 1);
  }
  const m = /^:([^!]+)![^ ]* PRIVMSG #([^ ]+) :([\s\S]*)$/.exec(rest);
  if (!m) return null;
  return {
    // IRC gives the same message id EventSub does, which is why the two
    // transports are interchangeable to everything downstream.
    id: tags.get("id") || `irc_${Date.now().toString(36)}`,
    channel: m[2]!,
    author: tags.get("display-name") || m[1]!,
    authorId: tags.get("user-id") || "",
    text: m[3]!,
    at: new Date(Number(tags.get("tmi-sent-ts") || Date.now())).toISOString(),
    ...(tags.get("reply-parent-msg-id") ? { parentId: tags.get("reply-parent-msg-id")! } : {}),
  };
}

// ── the socket ───────────────────────────────────────────────────────────────

/** The minimum of a websocket this module uses. Structural rather than the
 *  global type so the transport can be substituted — by a test, or by a
 *  runtime whose WebSocket is somewhere other than `globalThis`. */
export interface ChatSocket {
  send(data: string): void;
  close(): void;
  onopen(cb: () => void): void;
  onmessage(cb: (data: string) => void): void;
  onclose(cb: (reason: string) => void): void;
  onerror(cb: (err: Error) => void): void;
}

export type SocketFactory = (url: string) => ChatSocket;

export const defaultSocketFactory: SocketFactory = (url) => {
  const ws = new WebSocket(url);
  return {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onopen: (cb) => ws.addEventListener("open", () => cb()),
    onmessage: (cb) => ws.addEventListener("message", (e) => cb(String((e as MessageEvent).data))),
    onclose: (cb) => ws.addEventListener("close", (e) => cb((e as CloseEvent).reason || "closed")),
    onerror: (cb) => ws.addEventListener("error", () => cb(new Error("websocket error"))),
  };
};

export interface TwitchChatOpts {
  api: TwitchApi;
  /** The channel login, without the leading #. */
  channel: string;
  events: SurfaceEvents;
  socket?: SocketFactory;
  /** Read chat over IRC instead. See the note at the top of this file. */
  transport?: "eventsub" | "irc";
}

export class TwitchChat {
  private sock: ChatSocket | null = null;
  private irc: TLSSocket | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Envelope ids already handled. Twitch redelivers across a reconnect, and a
   *  question answered twice is what a viewer notices before anything else. */
  private seen = new Set<string>();
  private broadcasterId = "";

  constructor(private readonly o: TwitchChatOpts) {}

  async start(): Promise<void> {
    const transport = this.o.transport ?? CHAT_TRANSPORT;
    const channel = await this.o.api.userByLogin(this.o.channel);
    if (!channel) throw new Error(`twitch has no channel called "${this.o.channel}"`);
    this.broadcasterId = channel.id;
    this.o.events.onTitle?.((await this.o.api.channel(channel.id))?.title || channel.displayName);

    if (transport === "irc") return this.startIrc();
    return this.connect(EVENTSUB_URL);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.keepalive) clearTimeout(this.keepalive);
    this.sock?.close();
    this.irc?.end();
    this.sock = null;
    this.irc = null;
  }

  // ── EventSub ──────────────────────────────────────────────────────────────

  private connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const factory = this.o.socket ?? defaultSocketFactory;
      const sock = factory(url);
      let settled = false;
      const done = (e?: Error) => {
        if (settled) return;
        settled = true;
        e ? reject(e) : resolve();
      };

      sock.onmessage((raw) => void this.onFrame(raw, sock, done));
      sock.onerror((e) => done(e));
      sock.onclose((reason) => {
        this.o.events.onStatus?.({ connected: false, detail: `chat socket closed — ${reason}` });
        done(new Error(`twitch chat socket closed before the session opened — ${reason}`));
        // A close AFTER the session opened is an outage, not a failed start:
        // reconnect rather than ending the show, because Twitch cycles these
        // sockets on its own schedule and an operator should never see a
        // session end because a server went away for four seconds.
        if (!this.stopped && settled) setTimeout(() => void this.connect(EVENTSUB_URL).catch(() => {}), 2_000);
      });

      this.sock = sock;
    });
  }

  private async onFrame(raw: string, sock: ChatSocket, done: (e?: Error) => void): Promise<void> {
    const frame = readFrame(raw);
    if (frame.messageId && this.seen.has(frame.messageId)) return;
    if (frame.messageId) this.remember(frame.messageId);
    this.armKeepalive();

    switch (frame.type) {
      case "welcome": {
        // The subscription must land within ten seconds of the welcome or
        // Twitch closes the socket. It is the first thing done, and a failure
        // here is the operator's — a scope the bot account never granted —
        // so it is reported rather than retried.
        try {
          const me = await this.o.api.self();
          await this.o.api.subscribeChat(frame.sessionId, this.broadcasterId, me.id);
          this.armKeepalive(frame.keepaliveSeconds);
          this.o.events.onStatus?.({ connected: true, detail: `reading #${this.o.channel}` });
          done();
        } catch (e) {
          sock.close();
          done(e as Error);
        }
        return;
      }
      case "message":
        this.o.events.onMessage?.({
          id: frame.chat.id,
          author: frame.chat.author,
          text: frame.chat.text,
          at: frame.chat.at,
          // A Twitch reply chain is the closest thing live chat has to a
          // thread, and the async surfaces already read these two fields.
          ...(frame.chat.parentId ? { threadId: frame.chat.parentId, parentId: frame.chat.parentId } : {}),
          meta: { channel: frame.chat.channel, authorId: frame.chat.authorId },
        });
        return;
      case "reconnect":
        // Twitch hands over to a new socket and keeps the old one alive until
        // the new one welcomes. Connect first, then drop.
        if (frame.reconnectUrl) {
          const old = this.sock;
          void this.connect(frame.reconnectUrl).then(() => old?.close()).catch(() => {});
        }
        return;
      case "revocation":
        this.o.events.onEnded?.(`twitch revoked the chat subscription (${frame.reason})`);
        return;
      default:
        return;
    }
  }

  /** Twitch guarantees a keepalive inside the negotiated window. Silence past
   *  it means the socket is dead in a way `close` will not tell us about —
   *  the same dead-socket watchdog the eBay watcher needed for the same reason. */
  private armKeepalive(seconds?: number): void {
    if (seconds) this.keepaliveSeconds = seconds;
    if (this.keepalive) clearTimeout(this.keepalive);
    if (this.stopped) return;
    this.keepalive = setTimeout(() => {
      if (this.stopped) return;
      this.o.events.onStatus?.({ connected: false, detail: "no keepalive from twitch — reconnecting" });
      this.sock?.close();
    }, this.keepaliveSeconds * 1500);
  }
  private keepaliveSeconds = 10;

  /** Bounded, because a long stream is tens of thousands of messages and the
   *  only thing this set protects against is a replay across one reconnect. */
  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > 5_000) {
      for (const k of this.seen) {
        this.seen.delete(k);
        if (this.seen.size <= 4_000) break;
      }
    }
  }

  // ── IRC ───────────────────────────────────────────────────────────────────

  private async startIrc(): Promise<void> {
    const token = await this.o.api.userToken();
    const me = await this.o.api.self();
    await new Promise<void>((resolve, reject) => {
      const s = tlsConnect({ port: IRC_PORT, host: IRC_HOST, servername: IRC_HOST }, () => {
        s.write("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
        s.write(`PASS oauth:${token}\r\n`);
        s.write(`NICK ${me.login}\r\n`);
        s.write(`JOIN #${this.o.channel}\r\n`);
        this.o.events.onStatus?.({ connected: true, detail: `reading #${this.o.channel} over IRC` });
        resolve();
      });
      s.setEncoding("utf8");
      let buffer = "";
      s.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\r\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const parsed = parseIrcLine(line);
          if (!parsed) continue;
          if ("ping" in parsed) {
            s.write(`PONG ${parsed.ping}\r\n`);
            continue;
          }
          if (this.seen.has(parsed.id)) continue;
          this.remember(parsed.id);
          this.o.events.onMessage?.({
            id: parsed.id,
            author: parsed.author,
            text: parsed.text,
            at: parsed.at,
            ...(parsed.parentId ? { threadId: parsed.parentId, parentId: parsed.parentId } : {}),
            meta: { channel: parsed.channel, authorId: parsed.authorId, transport: "irc" },
          });
        }
      });
      s.on("error", reject);
      s.on("close", () => {
        this.o.events.onStatus?.({ connected: false, detail: "irc connection closed" });
      });
      this.irc = s;
    });
  }
}
