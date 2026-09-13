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

import type { ShowContext } from "../domain/types.js";
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

export class ShowContextEngine {
  private segs: Segment[] = [];
  private ctx: ShowContext = {
    currentTopic: "Getting started",
    listingInFocus: null,
    recentPoints: [],
    tone: null,
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

  /** Feed a finalized transcript segment from the host's audio. */
  push(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.segs.push({ text: t, at: Date.now() });
    const cutoff = Date.now() - this.windowMs * 2;
    while (this.segs.length > 200 || (this.segs[0] && this.segs[0].at < cutoff)) this.segs.shift();
  }

  /** The latest snapshot. Synchronous and never blocking — this is on the hot path. */
  current(): ShowContext {
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
