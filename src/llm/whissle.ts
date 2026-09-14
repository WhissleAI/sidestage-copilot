// Whissle gateway client — the ONLY LLM provider in this system.
//
// Two doors, for two different jobs:
//
//  • chatTurn -> POST /api/agents/{id}/chat/turn
//    The production, billable door. It routes to `services/text_turn.py::run_turn`,
//    the channel-agnostic brain: the SAME prompt, knowledge base, tools and
//    dispositions the voice path runs. That is what makes this agent omni-channel
//    — the buyer-chat replies here and a spoken reply in a voice session come out
//    of one brain, not two that drift.
//    It takes an optional per-turn `context` field, composed UNDER the agent's
//    persona + KB and never stored. That field is where this app injects the
//    retrieved facts and the live show state.
//
//  • utilityTurn -> POST /api/bench/agent-turn
//    The injected-`system` door, for internal JSON-only work (rolling show
//    context) where the seller persona would fight a "return only JSON"
//    instruction. Not customer-facing.
//
// `new_conversation: true` on every reply turn is deliberate: each buyer question
// is independent, and a reply must never inherit the previous buyer's thread.

import { config } from "../config.js";
import { LlmError, type LlmPort } from "./types.js";
import { meter, type GatewayDoor } from "./meter.js";

export interface WhissleOpts {
  apiKey: string;
  agentId: string;
  baseUrl?: string;
  /** Abort a turn that blows the latency budget rather than letting it hang. */
  timeoutMs?: number;
  /** Which show this client serves, so the meter can attribute the spend.
   *  The platform cannot: /usage/sessions returns agent_id: null for text. */
  showId?: string;
}

export class WhissleClient implements LlmPort {
  readonly name = "whissle";
  private base: string;

  constructor(private o: WhissleOpts) {
    this.base = (o.baseUrl || config.whissle.base).replace(/\/$/, "");
  }

  get agentId(): string {
    return this.o.agentId;
  }

  /**
   * Point this client at a different agent.
   *
   * Each CATALOG owns an agent — the catalog is what defines the seller's
   * persona, voice, never-say list and knowledge base, and those are stable
   * while streams come and go. So when a show loads a catalog, its client
   * switches to that catalog's agent, and two sellers monitored at the same time
   * cannot retrieve each other's inventory.
   */
  setAgent(agentId: string): void {
    this.o = { ...this.o, agentId };
  }

  async chatTurn(message: string, context: string, opts: { maxTokens?: number } = {}): Promise<string> {
    if (!this.o.agentId) throw new LlmError(400, "no Whissle agent configured for this show");
    const body = {
      message,
      context,
      new_conversation: true,
      source: "api",
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    };
    const d = await this.post<{ reply?: string }>(
      `/api/agents/${this.o.agentId}/chat/turn`, body,
      { door: "chat_turn", contextChars: message.length + context.length },
    );
    return (d.reply || "").trim();
  }

  /**
   * Stream a reply turn — gateway PR #1101, live on AWS since 2026-09-13.
   *
   * Wire contract: `open`, then (`delta` | `tool`)*, then `done`, where `done`
   * carries the byte-identical JSON body the non-streaming door returns. So the
   * authoritative answer is the one in `done`; the deltas are for the operator's
   * eyes and are DISCARDED if `done` disagrees with them.
   *
   * Falls back to the JSON door on 404 — the streaming path is new, and an
   * older gateway in front of this app should degrade to a slower reply rather
   * than no reply.
   */
  async chatTurnStream(
    message: string,
    context: string,
    onDelta: (text: string, full: string) => void,
    opts: { maxTokens?: number } = {},
  ): Promise<string> {
    if (!this.o.agentId) throw new LlmError(400, "no Whissle agent configured for this show");
    const body = {
      message,
      context,
      new_conversation: true,
      store: false,
      source: "api",
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    };

    const t0 = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 12_000);
    const done = (ok: boolean, status?: number, error?: string) =>
      meter.record({
        door: "chat_turn", ms: performance.now() - t0, ok, status, error,
        showId: this.o.showId, contextChars: message.length + context.length,
      });

    try {
      const r = await fetch(`${this.base}/api/agents/${this.o.agentId}/chat/turn/stream`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.o.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });

      if (r.status === 404) {
        // No streaming door on this gateway. Not an error worth failing a reply
        // over; take the JSON door and lose only the narration.
        clearTimeout(timer);
        return this.chatTurn(message, context, opts);
      }
      if (!r.ok || !r.body) {
        const text = await safeText(r);
        done(false, r.status, text.slice(0, 200));
        throw new LlmError(r.status, text);
      }

      let full = "";
      let final: string | null = null;
      for await (const frame of sseFrames(r.body)) {
        if (frame.event === "delta") {
          const text = String((frame.data as { text?: unknown }).text ?? "");
          if (!text) continue;
          full += text;
          // Never let a display callback take down a turn.
          try {
            onDelta(text, full);
          } catch { /* the reply matters, the narration does not */ }
        } else if (frame.event === "done") {
          final = String((frame.data as { reply?: unknown }).reply ?? "").trim();
        } else if (frame.event === "error") {
          const msg = String((frame.data as { message?: unknown }).message ?? "stream failed");
          done(false, 502, msg);
          throw new LlmError(502, msg);
        }
      }

      // `done` is the contract; the accumulated deltas are a best-effort echo of
      // it. A stream that ended without `done` did not complete, and answering
      // from a partial accumulation would hand the guards a truncated draft that
      // looks whole.
      if (final === null) {
        done(false, 502, "stream ended without a done frame");
        throw new LlmError(502, "stream ended without a done frame");
      }
      done(true, 200);
      return final;
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if ((e as Error).name === "AbortError") {
        done(false, 504, "gateway timeout");
        throw new LlmError(504, "gateway timeout");
      }
      done(false, 0, (e as Error).message);
      throw new LlmError(0, (e as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  async utilityTurn(system: string, user: string, opts: { maxTokens?: number } = {}): Promise<string> {
    const d = await this.post<{ reply?: string }>("/api/bench/agent-turn", {
      agent_id: this.o.agentId,
      system,
      messages: [{ role: "user", content: user }],
      max_tokens: opts.maxTokens ?? 500,
    }, { door: "utility_turn", contextChars: system.length + user.length });
    return (d.reply || "").trim();
  }

  /**
   * Open a LISTEN-ONLY voice session: STT + emotion/intent metadata, no LLM, no
   * TTS — the bot never speaks. The browser publishes the show's audio into the
   * returned LiveKit room and reads transcript + metadata off the data channel,
   * which feeds the rolling show context. The `wsk_` key never leaves this
   * process; the browser only ever receives the short-lived LiveKit token.
   */
  async startListenSession(): Promise<{ url: string; token: string; room: string }> {
    const d = await this.post<{ url?: string; token?: string; room?: string }>("/api/bench/voice/start", {
      agent_id: this.o.agentId,
      listen_only: true,
      metadata: true,
    }, { door: "voice_start" });
    if (!d.url || !d.token) throw new LlmError(502, `unexpected voice/start response: ${JSON.stringify(d).slice(0, 200)}`);
    return { url: d.url, token: d.token, room: d.room || "" };
  }

  /** Upload a knowledge document (the catalog / policy corpus) to the agent. */
  async uploadKb(filename: string, content: string, mime = "text/markdown"): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([content], { type: mime }), filename);
    const t0 = performance.now();
    const r = await fetch(`${this.base}/api/agents/${this.o.agentId}/kb/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.o.apiKey}` },
      body: form,
    });
    meter.record({
      door: "kb_upload", ms: performance.now() - t0, ok: r.ok, status: r.status,
      showId: this.o.showId, contextChars: content.length,
    });
    if (!r.ok) throw new LlmError(r.status, await safeText(r));
  }

  private async post<T>(
    path: string,
    body: unknown,
    m: { door: GatewayDoor; contextChars?: number } = { door: "chat_turn" },
  ): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 12_000);
    const t0 = performance.now();
    // Every call that leaves this process is counted, including the ones that
    // fail — a turn that 402s still tells the seller something about the bill.
    const done = (ok: boolean, status?: number, error?: string) =>
      meter.record({
        door: m.door, ms: performance.now() - t0, ok, status, error,
        showId: this.o.showId, contextChars: m.contextChars,
      });
    try {
      const r = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.o.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!r.ok) {
        const text = await safeText(r);
        done(false, r.status, text.slice(0, 200));
        throw new LlmError(r.status, text);
      }
      const parsed = (await r.json()) as T;
      done(true, r.status);
      return parsed;
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if ((e as Error).name === "AbortError") {
        done(false, 504, "gateway timeout");
        throw new LlmError(504, "gateway timeout");
      }
      done(false, 0, (e as Error).message);
      throw new LlmError(0, (e as Error).message);
    } finally {
      clearTimeout(t);
    }
  }
}

/**
 * Parse an SSE byte stream into `{event, data}` frames.
 *
 * Deliberately minimal and deliberately NOT a library: the only thing this has
 * to get right is that a frame ends at a blank line and may span chunk
 * boundaries — which is exactly the bug a hand-rolled `split("\n\n")` per chunk
 * introduces, silently, only under load.
 */
async function* sseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trim());
        }
        if (!data.length) continue;
        try {
          yield { event, data: JSON.parse(data.join("\n")) };
        } catch {
          /* a frame we cannot parse is a frame we cannot act on */
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "";
  }
}
