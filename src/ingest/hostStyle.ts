// The seller's STYLE over time, from the voice metadata.
//
// The emotion and intent heads measure the host, not the buyers. Read as
// sentiment they are meaningless ("the show was 41% excited"); read as a
// trajectory of delivery — explaining, asking the room, driving a close; calm,
// steady, high energy; rising or settling — they describe how the seller
// worked the show, which is what the copilot should match while it runs and
// what the report should say afterwards. One function computes both.
import type { SignalDistribution } from "../domain/types.js";

export interface StyleSample {
  at: number;
  emotion?: SignalDistribution | null;
  intent?: SignalDistribution | null;
  /** Mean loudness 0..1 while this was said, when measured. */
  level?: number | null;
  wpm?: number | null;
}

export interface StyleBucket {
  offsetMs: number;
  utterances: number;
  /** 0..1: arousal mass from the emotion head blended with loudness. */
  energy: number;
  intent: Record<string, number>;
  emotion: Record<string, number>;
  wpm: number | null;
}

export interface HostStyle {
  label: string;
  detail: string;
}

const HIGH_AROUSAL = new Set(["excited", "happy", "angry", "surprised", "frustrated", "enthusiastic", "urgent"]);

/** What share of the emotion mass sits on high-arousal labels. */
export function arousal(d: SignalDistribution | null | undefined): number | null {
  if (!d?.topK?.length) return null;
  let total = 0;
  let high = 0;
  for (const k of d.topK) {
    total += k.p;
    if (HIGH_AROUSAL.has(k.label)) high += k.p;
  }
  return total > 0 ? high / total : null;
}

function massOf(ds: (SignalDistribution | null | undefined)[]): Record<string, number> {
  const acc: Record<string, number> = {};
  let n = 0;
  for (const d of ds) {
    if (!d?.topK?.length) continue;
    n++;
    for (const k of d.topK) acc[k.label] = (acc[k.label] ?? 0) + k.p;
  }
  if (!n) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(acc)) out[k] = Math.round((v / n) * 1000) / 1000;
  return out;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

export function energyOf(samples: StyleSample[]): number {
  const a = samples.map((s) => arousal(s.emotion)).filter((x): x is number => x != null);
  const l = samples.map((s) => s.level).filter((x): x is number => typeof x === "number");
  const am = a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const lm = l.length ? l.reduce((x, y) => x + y, 0) / l.length : null;
  if (am != null && lm != null) return Math.round((0.6 * am + 0.4 * lm) * 100) / 100;
  return Math.round(((am ?? lm) ?? 0) * 100) / 100;
}

/** Fixed-width buckets from the first sample; `offsetMs` is relative to `origin`. */
export function trajectoryOf(samples: StyleSample[], origin: number, bucketMs = 120_000): StyleBucket[] {
  if (!samples.length) return [];
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const out: StyleBucket[] = [];
  let i = 0;
  const first = Math.floor((sorted[0]!.at - origin) / bucketMs) * bucketMs;
  const last = sorted[sorted.length - 1]!.at - origin;
  for (let start = first; start <= last; start += bucketMs) {
    const end = start + bucketMs;
    const inb: StyleSample[] = [];
    while (i < sorted.length && sorted[i]!.at - origin < end) inb.push(sorted[i++]!);
    if (!inb.length) continue;
    out.push({
      offsetMs: Math.max(0, start),
      utterances: inb.length,
      energy: energyOf(inb),
      intent: massOf(inb.map((s) => s.intent)),
      emotion: massOf(inb.map((s) => s.emotion)),
      wpm: median(inb.map((s) => s.wpm).filter((x): x is number => typeof x === "number" && x > 0)),
    });
  }
  return out;
}

const INTENT_WORD: Record<string, string> = {
  inform: "explaining", informing: "explaining", statement: "explaining", explain: "explaining",
  question: "asking the room", query: "asking the room",
  command: "driving the sale", directive: "driving the sale", request: "driving the sale", persuade: "driving the sale",
  greeting: "greeting", social: "chatting", chitchat: "chatting", other: "chatting",
};

/** One label and one sentence for a run of samples. */
export function styleOf(samples: StyleSample[]): HostStyle | null {
  if (!samples.length) return null;
  const intent = massOf(samples.map((s) => s.intent));
  const top = Object.entries(intent).sort((a, b) => b[1] - a[1])[0] ?? null;
  const verb = top ? (INTENT_WORD[top[0]] ?? top[0]) : null;
  const energy = energyOf(samples);
  const band = energy < 0.35 ? "calm" : energy < 0.6 ? "steady" : "high energy";
  const third = Math.max(1, Math.floor(samples.length / 3));
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const e0 = energyOf(sorted.slice(0, third));
  const e1 = energyOf(sorted.slice(-third));
  const trend = sorted.length >= 6 ? (e1 - e0 > 0.1 ? "rising" : e0 - e1 > 0.1 ? "settling" : "level") : "level";
  const wpm = median(samples.map((s) => s.wpm).filter((x): x is number => typeof x === "number" && x > 0));
  const label = [verb, band].filter(Boolean).join(", ");
  const detail =
    (top ? `mostly ${verb} (${Math.round(top[1] * 100)}% of the intent mass)` : "delivery mix unmeasured") +
    `, energy ${e0.toFixed(2)} → ${e1.toFixed(2)} (${trend})` +
    (wpm ? `, ${Math.round(wpm)} wpm` : "");
  return { label: label || band, detail };
}
