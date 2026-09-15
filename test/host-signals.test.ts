import { test } from "node:test";
import assert from "node:assert/strict";
import { hostFacts } from "../src/retrieval/hostFacts.js";
import { styleOf, trajectoryOf, arousal } from "../src/ingest/hostStyle.js";
import type { SignalDistribution } from "../src/domain/types.js";

// What the host said is evidence; how the host said it is style. Both from
// the reviewer session of 2026-09-15: "10men slides?" was deferred while the
// transcript held "these are a size ten men … nine and a half men, eleven
// women", and the report called the host's emotion mass "sentiment".

const now = 1_700_000_000_000;
const segs = [
  { text: "I have a Nike here.", at: now - 50_000, seq: 1 },
  { text: "Okay. Brand new in the box. Size nine and a half.", at: now - 44_000, seq: 2 },
  { text: "Men's, nine and a half. Women's, eleven, you guys.", at: now - 40_000, seq: 3 },
  { text: "These are a size ten men.", at: now - 8_000, seq: 4 },
  { text: "Running it.", at: now - 2_000, seq: 5 },
  { text: "Free shipping on everything tonight.", at: now - 400_000, seq: 0 },
];

test("host facts pick the utterances that share content words or numbers with the question", () => {
  const f = hostFacts("10men slides?", segs, now);
  assert.ok(f.length >= 1);
  assert.equal(f[0]!.source, "host");
  assert.match(f[0]!.text, /size ten men|nine and a half/);
  assert.equal(f[0]!.field, "sizing");
  assert.ok(f.every((x) => x.factId.startsWith("host:")));
  assert.ok(f.every((x) => x.numericCents === undefined), "a host fact never carries a listing price");
});

test("host facts ignore stale speech and questions with no content", () => {
  assert.equal(hostFacts("do you ship?", segs, now).length, 0, "the shipping line is six minutes old");
  assert.equal(hostFacts("is it?", segs, now).length, 0);
  assert.equal(hostFacts("orange", segs, now).length, 0, "nothing the host said mentions orange");
});

const dist = (top: string, p: number, rest: [string, number][]): SignalDistribution => ({
  topLabel: top, topP: p, topK: [{ label: top, p }, ...rest.map(([label, q]) => ({ label, p: q }))],
  changed: false, prevLabel: null, heldMs: null, flips: null, trusted: true,
});

test("style reads delivery, not sentiment: dominant intent, energy band and trend", () => {
  const samples = Array.from({ length: 12 }, (_, i) => ({
    at: i * 20_000,
    emotion: i < 6 ? dist("neutral", 0.7, [["excited", 0.3]]) : dist("excited", 0.75, [["neutral", 0.25]]),
    intent: dist(i % 3 === 0 ? "question" : "inform", 0.8, [["other", 0.2]]),
    level: i < 6 ? 0.3 : 0.7,
    wpm: 160,
  }));
  const s = styleOf(samples)!;
  assert.match(s.label, /explaining/);
  assert.match(s.detail, /rising/);
  assert.match(s.detail, /160 wpm/);
  assert.equal(arousal(dist("excited", 0.75, [["neutral", 0.25]])), 0.75);
  const t = trajectoryOf(samples, 0, 120_000);
  assert.equal(t.length, 2);
  assert.ok(t[1]!.energy > t[0]!.energy);
  assert.ok((t[0]!.intent.inform ?? 0) > (t[0]!.intent.question ?? 0));
});
