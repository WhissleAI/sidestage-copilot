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

export interface WhissleOpts {
  apiKey: string;
  agentId: string;
  baseUrl?: string;
  /** Abort a turn that blows the latency budget rather than letting it hang. */
  timeoutMs?: number;
}

export class WhissleClient implements LlmPort {
  readonly name = "whissle";
  private base: string;

  constructor(private o: WhissleOpts) {
    this.base = (o.baseUrl || config.whissle.base).replace(/\/$/, "");
  }

  async chatTurn(message: string, context: string, opts: { maxTokens?: number } = {}): Promise<string> {
    const body = {
      message,
      context,
      new_conversation: true,
      source: "api",
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    };
    const d = await this.post<{ reply?: string }>(`/api/agents/${this.o.agentId}/chat/turn`, body);
    return (d.reply || "").trim();
  }

  async utilityTurn(system: string, user: string, opts: { maxTokens?: number } = {}): Promise<string> {
    const d = await this.post<{ reply?: string }>("/api/bench/agent-turn", {
      agent_id: this.o.agentId,
      system,
      messages: [{ role: "user", content: user }],
      max_tokens: opts.maxTokens ?? 500,
    });
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
    });
    if (!d.url || !d.token) throw new LlmError(502, `unexpected voice/start response: ${JSON.stringify(d).slice(0, 200)}`);
    return { url: d.url, token: d.token, room: d.room || "" };
  }

  /** Upload a knowledge document (the catalog / policy corpus) to the agent. */
  async uploadKb(filename: string, content: string, mime = "text/markdown"): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([content], { type: mime }), filename);
    const r = await fetch(`${this.base}/api/agents/${this.o.agentId}/kb/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.o.apiKey}` },
      body: form,
    });
    if (!r.ok) throw new LlmError(r.status, await safeText(r));
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 12_000);
    try {
      const r = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.o.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!r.ok) throw new LlmError(r.status, await safeText(r));
      return (await r.json()) as T;
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if ((e as Error).name === "AbortError") throw new LlmError(504, "gateway timeout");
      throw new LlmError(0, (e as Error).message);
    } finally {
      clearTimeout(t);
    }
  }
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "";
  }
}
