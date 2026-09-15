// The rolling show context — what the host is talking about RIGHT NOW.
//
// This is the part of grounding the catalog cannot supply. The catalog knows what
// the Chicago 1s are; it does not know that the host is holding them up and
// explaining that the cracked leather is factory-intended. A buyer who types
// "is that a flaw?" ten seconds later is asking about THAT, and a reply that
// ignores it reads like a form letter.
//
// Design: keep a sliding window of the host's recent speech, and on a timer —
// only when there is genuinely new speech — summarise it into a small typed
// snapshot with one cheap utility LLM call. The reply path NEVER blocks on this:
// it reads the latest snapshot synchronously, so a slow or failed summarisation
// costs freshness, never latency.

import type { ShowContext, SignalDistribution } from "../domain/types.js";
import { styleOf, type StyleSample } from "./hostStyle.js";
import type { LlmPort } from "../llm/types.js";
import { extractJsonObject } from "../compose/composer.js";

export interface ShowContextOpts {
  llm: LlmPort;
  /** Catalog titles, so the summariser picks a real lot rather than inventing one. */
  lotTitles: () => { id: string; title: string }[];
  windowMs?: number;
  refreshMs?: number;
  onUpdate?: (c: ShowContext) => void;
}

interface Segment { text: string; at: number }

/** How long an acoustic read stays usable. One utterance's worth: the host's
 *  manner changes lot to lot, and a stale read is worse than none. */
const VOICE_TTL_MS = 45_000;
/** How long an on-screen reading stays usable. Lots move fast on a live show. */
const ON_SCREEN_TTL_MS = 60_000;
/** How much of the host's recent delivery describes their style right now. */
const STYLE_WINDOW_MS = 5 * 60_000;

export class ShowContextEngine {
  private segs: Segment[] = [];
  private ctx: ShowContext = {
    currentTopic: "Getting started",
    listingInFocus: null,
    recentPoints: [],
    tone: null,
    voice: null,
    style: null,
    onScreen: null,
    updatedAt: new Date(0).toISOString(),
  };
  private timer: NodeJS.Timeout | null = null;
  private lastSegCount = 0;
  private inFlight = false;
  private windowMs: number;
  private refreshMs: number;

  constructor(private o: ShowContextOpts) {
    this.windowMs = o.windowMs ?? 90_000;
    this.refreshMs = o.refreshMs ?? 8_000;
  }

  /**
   * Feed a finalized transcript segment from the host's audio.
   *
   * `voice` is the acoustic distribution that arrived with it. It is kept
   * separately from the text because it answers a different question — the text
   * says what the host is selling, the distribution says whether they are
   * excited about it — and because it is only worth carrying while it is fresh.
   */
  push(text: string, voice?: SignalDistribution | null, intent?: SignalDistribution | null, extra: { level?: number | null; wpm?: number | null } = {}): void {
    if (voice !== undefined) this.setVoice(voice);
    const t = text.trim();
    if (!t) return;
    const now = Date.now();
    this.segs.push({ text: t, at: now });
    // The style history keeps every trusted read: the voice heads describe
    // the seller's delivery, and delivery is what a reply should match.
    this.styleSamples.push({ at: now, emotion: voice?.trusted ? voice : null, intent: intent ?? null, level: extra.level ?? null, wpm: extra.wpm ?? null });
    while (this.styleSamples.length > 400 || (this.styleSamples[0] && this.styleSamples[0].at < now - STYLE_WINDOW_MS)) this.styleSamples.shift();
    const cutoff = Date.now() - this.windowMs * 2;
    while (this.segs.length > 200 || (this.segs[0] && this.segs[0].at < cutoff)) this.segs.shift();
  }

  /**
   * The latest acoustic read, kept only while the head trusts it.
   *
   * An untrusted distribution is dropped rather than stored, so a reply is
   * never shaded by a measurement the measurer disowns.
   */
  setVoice(voice: SignalDistribution | null): void {
    this.ctx = { ...this.ctx, voice: voice?.trusted ? voice : null };
    this.voiceAt = voice?.trusted ? Date.now() : 0;
  }

  private voiceAt = 0;
  private styleSamples: StyleSample[] = [];

  /** The host's utterances from the last `ms`, oldest first, for evidence. */
  recent(ms: number): { text: string; at: number; seq: number }[] {
    const since = Date.now() - ms;
    return this.segs.filter((s) => s.at >= since).map((s) => ({ text: s.text, at: s.at, seq: s.at }));
  }

  /** A one-line reading of what is on screen, from the show's video. */
  setOnScreen(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.ctx = { ...this.ctx, onScreen: { text: t.slice(0, 240), at: new Date().toISOString() } };
    this.onScreenAt = Date.now();
    this.o.onUpdate?.(this.ctx);
  }

  private onScreenAt = 0;

  /**
   * Both live signals go stale fast, and stale is worse than absent here: a
   * reply shaded by how the host sounded two minutes ago, or describing an item
   * they have already sold and moved on from, is wrong in a way that is hard to
   * see. So they expire rather than linger.
   */
  private freshen(): void {
    const now = Date.now();
    let next = this.ctx;
    if (next.voice && now - this.voiceAt > VOICE_TTL_MS) next = { ...next, voice: null };
    if (next.onScreen && now - this.onScreenAt > ON_SCREEN_TTL_MS) next = { ...next, onScreen: null };
    this.ctx = next;
  }

  /** The latest snapshot. Synchronous and never blocking — this is on the hot path. */
  current(): ShowContext {
    this.freshen();
    const since = Date.now() - STYLE_WINDOW_MS;
    const style = styleOf(this.styleSamples.filter((s) => s.at >= since));
    if ((style?.label ?? null) !== (this.ctx.style?.label ?? null) || (style?.detail ?? null) !== (this.ctx.style?.detail ?? null)) {
      this.ctx = { ...this.ctx, style };
    }
    return this.ctx;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.maybeRefresh(), this.refreshMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private window(): Segment[] {
    const since = Date.now() - this.windowMs;
    return this.segs.filter((s) => s.at >= since);
  }

  private async maybeRefresh(): Promise<void> {
    if (this.inFlight) return;
    const win = this.window();
    if (!win.length || win.length === this.lastSegCount) return;
    this.lastSegCount = win.length;
    this.inFlight = true;

    const windowText = win.map((s) => s.text).join(" ");
    const lots = this.o.lotTitles();
    const system = [
      "You maintain a live, structured picture of a live SELLING show for a reply copilot.",
      "Return ONLY compact JSON, no prose.",
      "From the recent transcript of what the HOST is saying, extract what they are on RIGHT NOW.",
      'Shape: {"currentTopic":"<short phrase>","listingId":"<id>"|null,"recentPoints":["<=4 short bullets"],"tone":"<one word>"|null}',
      "`listingId` MUST be one of these ids or null — never invent one:",
      ...lots.map((l) => `  ${l.id} = ${l.title}`),
      "Do not infer facts the host did not say.",
    ].join("\n");

    try {
      const raw = await this.o.llm.utilityTurn(system, windowText, { maxTokens: 300 });
      const p = extractJsonObject(raw);
      if (p) {
        const validIds = new Set(lots.map((l) => l.id));
        const id = typeof p.listingId === "string" && validIds.has(p.listingId) ? p.listingId : null;
        this.ctx = {
          // Spread FIRST so the summariser, which knows nothing about the live
          // signals, cannot drop them by omission — the class of bug where a new
          // field silently disappears every refresh tick.
          ...this.ctx,
          currentTopic: str(p.currentTopic) || this.ctx.currentTopic,
          listingInFocus: id,
          recentPoints: Array.isArray(p.recentPoints)
            ? (p.recentPoints as unknown[]).map(str).filter(Boolean).slice(0, 4)
            : this.ctx.recentPoints,
          tone: p.tone ? str(p.tone) : this.ctx.tone,
          updatedAt: new Date().toISOString(),
        };
        this.o.onUpdate?.(this.ctx);
      }
    } catch {
      // A failed summary must never stall the show. Keep the previous snapshot;
      // the reply path is grounded in the catalog regardless.
    } finally {
      this.inFlight = false;
    }
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
