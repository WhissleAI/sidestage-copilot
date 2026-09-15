// What the Whissle agent actually did, per turn.
//
// This is the richest source in the platform and the app has never read it.
// `/api/sessions` lists the threads an agent answered — and unlike the metering
// rows in `/usage/*`, these DO carry `agent_id`, so a per-agent view is possible
// here even though it is not possible there. `/api/sessions/{id}/trace` then
// gives, for each turn: which provider and model answered, whether it failed
// over, the latency, and the token usage.
//
// That is the difference between "the copilot is slow" and "hop 0 went to
// gpt-oss-120b, took 916 ms and used 3,830 input tokens" — the second is
// actionable and the first is a complaint.
//
// Cost note: this is an N+1 by construction (list, then trace each). It is a
// page a seller opens between lots, not something on the reply path, and the
// fan-out is bounded and concurrent.

import { meter } from "./meter.js";

export interface TurnEvent {
  hop: number;
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  failedOver: boolean;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export interface AgentActivity {
  sessions: number;
  turns: number;
  /** Turns whose LLM hop reported a failover to a second provider. */
  failovers: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  latency: { p50: number; p95: number; max: number };
  byModel: { model: string; provider: string; turns: number; tokens: number; p50Ms: number }[];
  /** Newest first, for the "what just happened" table. */
  recent: (TurnEvent & { sessionId: string; title: string; at: string })[];
  error?: string;
}

const pct = (sorted: number[], p: number): number => {
  if (!sorted.length) return 0;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
};

export class WhissleSessions {
  constructor(private base: string, private apiKey: string) {}

  /**
   * Aggregate the last `limit` sessions for one agent.
   *
   * Degrades to a NAMED error rather than an empty page: a key without
   * `calls:read` and an agent that has never answered anything are different
   * facts, and an analytics page that renders them identically teaches the
   * seller to distrust it.
   */
  async activity(agentId: string, limit = 25): Promise<AgentActivity> {
    const empty: AgentActivity = {
      sessions: 0, turns: 0, failovers: 0, errors: 0, inputTokens: 0, outputTokens: 0,
      latency: { p50: 0, p95: 0, max: 0 }, byModel: [], recent: [],
    };

    const list = await this.get<{ items?: SessionRow[] }>(
      `/api/sessions?agent_id=${encodeURIComponent(agentId)}&limit=${limit}`,
    );
    if (!list.ok) return { ...empty, error: list.error };

    const items = list.value.items ?? [];
    const traces = await Promise.all(
      items.map(async (s) => ({ s, t: await this.get<TraceBody>(`/api/sessions/${s.id}/trace`) })),
    );

    const turns: (TurnEvent & { sessionId: string; title: string; at: string })[] = [];
    for (const { s, t } of traces) {
      if (!t.ok) continue;
      for (const e of t.value.events?.events ?? []) {
        if (e.type !== "llm_call") continue;
        const d = e.data ?? {};
        turns.push({
          sessionId: s.id,
          title: s.title || "(untitled)",
          at: s.created_at,
          hop: Number(d.hop ?? 0),
          provider: String(d.provider ?? "—"),
          model: String(d.model ?? "—"),
          ok: d.ok !== false,
          latencyMs: Number(d.latency_ms ?? 0),
          failedOver: Boolean(d.failed_over),
          inputTokens: Number(d.usage?.input_tokens ?? 0),
          outputTokens: Number(d.usage?.output_tokens ?? 0),
          stopReason: d.stop_reason == null ? null : String(d.stop_reason),
        });
      }
    }

    const lat = turns.map((t) => t.latencyMs).sort((a, b) => a - b);
    const models = new Map<string, { provider: string; turns: number; tokens: number; lat: number[] }>();
    for (const t of turns) {
      const m = models.get(t.model) ?? { provider: t.provider, turns: 0, tokens: 0, lat: [] };
      m.turns++;
      m.tokens += t.inputTokens + t.outputTokens;
      m.lat.push(t.latencyMs);
      models.set(t.model, m);
    }

    return {
      sessions: items.length,
      turns: turns.length,
      failovers: turns.filter((t) => t.failedOver).length,
      errors: turns.filter((t) => !t.ok).length,
      inputTokens: turns.reduce((a, t) => a + t.inputTokens, 0),
      outputTokens: turns.reduce((a, t) => a + t.outputTokens, 0),
      latency: { p50: pct(lat, 50), p95: pct(lat, 95), max: lat.length ? Math.round(lat[lat.length - 1]) : 0 },
      byModel: [...models.entries()]
        .map(([model, m]) => ({
          model, provider: m.provider, turns: m.turns, tokens: m.tokens,
          p50Ms: pct([...m.lat].sort((a, b) => a - b), 50),
        }))
        .sort((a, b) => b.turns - a.turns),
      recent: turns.slice(0, 40),
    };
  }

  /**
   * The platform's own account of one voice session.
   *
   * A listen-only session is still a session to the gateway: it runs the same
   * emotion/intent head over the host's audio and, when it ends, writes the
   * same `session_summary` block a phone call gets. That block sat on the
   * gateway unread while the report described the show from chat alone.
   *
   * Matching is by the `session_id` the bench minted (it carries the room) and
   * falls back to "a voice session on this agent inside the show's window"; the
   * report says which, because a summary of the wrong session is worse than
   * none.
   */
  async voiceSessionFor(opts: {
    agentId: string;
    room: string | null;
    since: string | null;
  }): Promise<PlatformSessionSummary | null> {
    const list = await this.get<{ items?: SessionRow[] }>(`/api/sessions?kind=voice&limit=25`);
    if (!list.ok) return null;
    const since = opts.since ? new Date(opts.since).getTime() : 0;
    const items = (list.value.items ?? []).filter((s) => new Date(s.created_at).getTime() >= since - 60_000);
    const pick = (matched: PlatformSessionSummary["matchedBy"], f: (s: SessionRow) => boolean) => {
      const hit = items.find(f);
      return hit ? { hit, matched } : null;
    };
    const found =
      (opts.room && pick("room", (s) => Boolean(s.session_id && s.session_id.includes(opts.room!)))) ||
      pick("agent", (s) => s.agent_id === opts.agentId) ||
      (since ? pick("window", () => true) : null);
    if (!found) return null;

    const det = await this.get<{ session?: SessionDetail } & SessionDetail>(`/api/sessions/${found.hit.id}`);
    if (!det.ok) return null;
    const x = det.value.session ?? det.value;
    const m = x.metadata ?? {};
    const ss = m.session_summary;
    const pct = (o: Record<string, number> | undefined) =>
      o
        ? Object.entries(o)
            .map(([label, v]) => ({ label: label.replace(/^(EMOTION|INTENT)_/, "").toLowerCase(), share: Number(v) / 100 }))
            .sort((a, b) => b.share - a.share)
        : [];
    return {
      sessionId: x.id,
      matchedBy: found.matched,
      createdAt: x.created_at,
      durationSec: Number(x.duration_sec ?? 0),
      turns: Array.isArray(m.turn_signals) ? m.turn_signals.length : 0,
      summary: ss && typeof ss === "object"
        ? {
            summary: str(ss.summary),
            outcome: str(ss.outcome),
            disposition: str(ss.disposition),
            nextAction: str(ss.next_action),
            recommendedAction: str(ss.recommended_action),
            confidence: str(ss.confidence),
            keyPoints: Array.isArray(ss.key_points) ? ss.key_points.map(String) : [],
          }
        : null,
      emotion: pct(m.emotion_distribution),
      intent: pct(m.intent_breakdown),
      dominantEmotion: str(m.dominant_emotion)?.replace(/^EMOTION_/, "").toLowerCase() ?? null,
      primaryIntent: str(m.primary_intent)?.replace(/^INTENT_/, "").toLowerCase() ?? null,
      recordingPath: str(x.recording_path),
    };
  }

  private async get<T>(path: string): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    const t0 = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
      const r = await fetch(`${this.base}${path}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: ctl.signal,
      });
      const ms = performance.now() - t0;
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        meter.record({ door: "billing", ms, ok: false, status: r.status, error: body.slice(0, 160) });
        return {
          ok: false,
          error: r.status === 403
            ? `not permitted — this key is missing the \`calls:read\` scope. ${body.slice(0, 140)}`
            : `${r.status} ${body.slice(0, 160) || r.statusText}`,
        };
      }
      meter.record({ door: "billing", ms, ok: true, status: r.status });
      return { ok: true, value: (await r.json()) as T };
    } catch (e) {
      const message = (e as Error).name === "AbortError" ? "gateway timeout" : (e as Error).message;
      meter.record({ door: "billing", ms: performance.now() - t0, ok: false, error: message });
      return { ok: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }
}

interface SessionRow {
  id: string; title: string | null; created_at: string;
  session_id?: string | null; agent_id?: string | null; kind?: string;
}
interface SessionDetail {
  id: string; created_at: string; duration_sec?: number | null; recording_path?: string | null;
  metadata?: {
    session_summary?: Record<string, unknown>;
    emotion_distribution?: Record<string, number>;
    intent_breakdown?: Record<string, number>;
    dominant_emotion?: unknown;
    primary_intent?: unknown;
    turn_signals?: unknown[];
  };
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** What the gateway wrote about the host's audio session, mapped to the
 *  report's vocabulary. `share` is a fraction, labels are bare lower-case. */
export interface PlatformSessionSummary {
  sessionId: string;
  matchedBy: "room" | "agent" | "window";
  createdAt: string;
  durationSec: number;
  turns: number;
  summary: {
    summary: string | null;
    outcome: string | null;
    disposition: string | null;
    nextAction: string | null;
    recommendedAction: string | null;
    confidence: string | null;
    keyPoints: string[];
  } | null;
  emotion: { label: string; share: number }[];
  intent: { label: string; share: number }[];
  dominantEmotion: string | null;
  primaryIntent: string | null;
  recordingPath: string | null;
}
interface TraceEvent {
  type: string;
  data?: {
    hop?: unknown; provider?: unknown; model?: unknown; ok?: unknown; latency_ms?: unknown;
    failed_over?: unknown; stop_reason?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
}
interface TraceBody { events?: { events?: TraceEvent[] } }
