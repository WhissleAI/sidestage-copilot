// Chat ingestion, behind a port.
//
// The copilot core does not care where buyer messages come from, so the adapter
// boundary is small on purpose: a source emits `{author, text}` and says when it
// stops. `SimulatedShowSource` drives the demo, the evals and the bench from the
// deterministic script. `TwitchChatSource` reads a real public live chat over
// anonymous IRC-over-WebSocket, which is what proves the pipeline survives a real
// firehose rather than a tidy fixture.
//
// A marketplace adapter (eBay Live, Whatnot) would implement the same interface;
// the difference is authentication, not shape.

import { config } from "../config.js";
import { buildScript, HOST_TRANSCRIPT, rng, type ScriptedMessage } from "./script.js";

export interface IncomingMessage {
  author: string;
  text: string;
  /** Platform-native id when the source has one, so replays de-duplicate. */
  externalId?: string;
}

export interface ChatSource {
  readonly name: string;
  onMessage(cb: (m: IncomingMessage) => void): void;
  start(): Promise<void>;
  stop(): void;
}

/** The scripted show. Deterministic given a seed. */
export class SimulatedShowSource implements ChatSource {
  readonly name = "simulated";
  private cb: ((m: IncomingMessage) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private i = 0;
  private script: ScriptedMessage[];
  private rand: () => number;

  constructor(opts: { count?: number; seed?: number; hypeRatio?: number } = {}) {
    this.script = buildScript(opts.count ?? 400, opts.seed ?? 42, opts.hypeRatio ?? 0.55);
    this.rand = rng((opts.seed ?? 42) + 1);
  }

  onMessage(cb: (m: IncomingMessage) => void): void {
    this.cb = cb;
  }

  async start(): Promise<void> {
    const tick = () => {
      const m = this.script[this.i % this.script.length];
      this.i++;
      this.cb?.({ ...m, externalId: `sim_${this.i}` });
      const span = config.simulateMaxMs - config.simulateMinMs;
      this.timer = setTimeout(tick, config.simulateMinMs + this.rand() * span);
    };
    this.timer = setTimeout(tick, 400);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * A real public live chat, read anonymously over Twitch's IRC-over-WebSocket
 * (`justinfan` guest login). Read-only by construction: this class has no code
 * path that sends a PRIVMSG. Replying into a public chat you do not own is both
 * against platform terms and not something a seller copilot should ever do
 * unasked — see docs/TDD.md §8.
 */
export class TwitchChatSource implements ChatSource {
  readonly name = "twitch";
  private ws: WebSocket | null = null;
  private cb: ((m: IncomingMessage) => void) | null = null;
  private statusCb: ((s: { connected: boolean; detail: string }) => void) | null = null;
  private stopped = false;

  constructor(public channel: string) {
    this.channel = channel.replace(/^#/, "").toLowerCase().trim();
  }

  onMessage(cb: (m: IncomingMessage) => void): void {
    this.cb = cb;
  }

  onStatus(cb: (s: { connected: boolean; detail: string }) => void): void {
    this.statusCb = cb;
  }

  async start(): Promise<void> {
    if (!this.channel) throw new Error("a Twitch channel name is required");
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    this.ws = ws;

    ws.onopen = () => {
      ws.send("CAP REQ :twitch.tv/tags");
      ws.send(`NICK justinfan${Math.floor(Math.random() * 90000) + 10000}`);
      ws.send(`JOIN #${this.channel}`);
      this.statusCb?.({ connected: true, detail: `joined #${this.channel}` });
    };

    ws.onmessage = (ev) => {
      for (const line of String(ev.data).split("\r\n")) {
        if (!line) continue;
        if (line.startsWith("PING")) {
          ws.send("PONG :tmi.twitch.tv");
          continue;
        }
        const m = parsePrivmsg(line);
        if (m) this.cb?.(m);
      }
    };

    ws.onclose = () => {
      this.statusCb?.({ connected: false, detail: "disconnected" });
      if (!this.stopped) setTimeout(() => void this.start(), 3000);
    };

    ws.onerror = () => this.statusCb?.({ connected: false, detail: "socket error" });
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }
}

/** Parse one IRC line into a message. Returns null for anything that is not a
 *  chat PRIVMSG (JOIN, NOTICE, the welcome burst). */
export function parsePrivmsg(line: string): IncomingMessage | null {
  let tags = "";
  let rest = line;
  if (line.startsWith("@")) {
    const sp = line.indexOf(" ");
    tags = line.slice(1, sp);
    rest = line.slice(sp + 1);
  }
  const m = rest.match(/^:([^!]+)![^ ]+ PRIVMSG #[^ ]+ :(.*)$/);
  if (!m) return null;

  const tag = new Map<string, string>();
  for (const kv of tags.split(";")) {
    const eq = kv.indexOf("=");
    if (eq > 0) tag.set(kv.slice(0, eq), kv.slice(eq + 1));
  }
  return {
    author: tag.get("display-name") || m[1],
    text: m[2].trim(),
    externalId: tag.get("id") || undefined,
  };
}

/** The host's own speech, for the rolling show context. Replays the scripted
 *  transcript; the real path is a Whissle listen-only voice session. */
export class ScriptedHostAudio {
  private cb: ((text: string) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private i = 0;

  onSegment(cb: (text: string) => void): void {
    this.cb = cb;
  }

  start(everyMs = 11_000): void {
    const tick = () => {
      this.cb?.(HOST_TRANSCRIPT[this.i % HOST_TRANSCRIPT.length]);
      this.i++;
      this.timer = setTimeout(tick, everyMs);
    };
    this.timer = setTimeout(tick, 1500);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
