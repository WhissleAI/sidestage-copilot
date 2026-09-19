// What the host just said, as citable evidence.
//
// On a stranger's show there is no catalog, and eBay Live's lot card carries
// a price and a number, nothing else. The one source that does answer "10
// men slides?" is the host, who said "these are a size ten men … nine and a
// half men, eleven women" thirty seconds earlier. Until 2026-09-15 that speech
// reached the composer only as colour ("what the host just said"), never as a
// fact a claim could cite, so the guard that demands a citation sent the
// question to the deferral template.
//
// A host fact is an utterance from the last two minutes that shares a
// content word or a number with the question. It carries no `numericCents`
// and no listing version: a price the host says is a thing the host said,
// never the listing's price, so the price guard keeps its own rules.
import type { Fact, FactField } from "./facts.js";
import { ngramVector, terms } from "./text.js";

export interface HostSegment {
  text: string;
  at: number;
  seq?: number;
}

const STOP = new Set(["the", "a", "an", "is", "are", "it", "this", "that", "these", "those", "do", "you", "u", "have", "any", "in", "on", "of", "for", "to", "and", "or", "what", "whats", "how", "much", "one", "ones", "please", "pls", "guys", "there", "still", "got", "get", "can", "i", "me", "my", "we", "they", "them", "with", "from", "like", "just", "so"]);

const FIELD_CUES: [FactField, RegExp][] = [
  ["price", /\$\s?\d|\bdollars?\b|\bbucks\b|\bprice\b|\bcost\b/i],
  ["sizing", /\bsize\b|\bsz\b|\bmen'?s\b|\bwomen'?s\b|\bfits?\b|\b(x?s|m|l|x{1,3}l)\b/i],
  ["availability", /\blast one\b|\bsold out\b|\bleft\b|\bone left\b|\bin stock\b|\bstill (?:have|got)\b|\bgone\b/i],
  ["shipping", /\bship(?:ping|s)?\b|\bpostage\b|\bdeliver/i],
  ["condition", /\bcondition\b|\bnew\b|\bworn\b|\bused\b|\bflaw|\bscratch|\bcrack/i],
  ["authenticity", /\bauthentic|\bgenuine\b|\breal\b|\bcertif|\bgraded?\b|\bpsa\b/i],
];

const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
  eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", hundred: "100",
};

/**
 * Buyers type "10men" and "sz9.5"; hosts say "ten men" and "nine and a half".
 * Split digits from letters and spell numbers as digits on both sides so the
 * two can meet. "and a half" becomes ".5" on the preceding number.
 */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/\b([a-z]+)\b/g, (w) => NUMBER_WORDS[w] ?? w)
    .replace(/\b(\d+)\s+and\s+a\s+half\b/g, "$1.5")
    .replace(/\b(\d+)\s+point\s+(\d)\b/g, "$1.$2");
}

/** Segments from the window that plausibly answer the question, newest first. */
export function hostFacts(question: string, segs: HostSegment[], now = Date.now(), opts: { windowMs?: number; max?: number } = {}): Fact[] {
  const windowMs = opts.windowMs ?? 120_000;
  const max = opts.max ?? 3;
  const q = terms(normalizeForMatch(question)).filter((t) => !STOP.has(t));
  if (!q.length) return [];
  const qSet = new Set(q);
  const qNums = new Set(q.filter((t) => /^\d+(?:\.\d+)?$/.test(t)));

  const out: { f: Fact; score: number }[] = [];
  for (const s of segs) {
    if (now - s.at > windowMs) continue;
    const st = terms(normalizeForMatch(s.text));
    if (st.length < 2) continue;
    let hits = 0;
    let numHit = false;
    for (const t of st) {
      if (qSet.has(t) && !STOP.has(t)) hits++;
      if (qNums.has(t)) numHit = true;
    }
    if (!hits && !numHit) continue;
    const ageS = Math.max(0, Math.round((now - s.at) / 1000));
    const field = FIELD_CUES.find(([, re]) => re.test(s.text))?.[0] ?? "description";
    const id = `host:${s.seq ?? s.at}`;
    const indexable = s.text;
    out.push({
      score: hits + (numHit ? 1 : 0) - ageS / 240,
      f: {
        factId: id,
        source: "host",
        // What the host said out loud about what is on the table. Grounding of
        // the listing kind, measured a different way — never a room rule.
        corpus: "listing",
        label: `the host said, ${ageS}s ago`,
        text: s.text,
        field,
        tokens: st,
        vector: ngramVector(indexable),
      },
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.f);
}
