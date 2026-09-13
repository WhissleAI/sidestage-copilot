// Shared text processing for both retrieval legs. Kept in one module so the
// index and the query are guaranteed to be tokenized identically — the classic
// way a hybrid retriever silently under-performs is the two legs disagreeing
// about what a token is.

const STOP = new Set([
  "a","an","and","are","as","at","be","but","by","can","did","do","does","for","from","had","has",
  "have","he","her","his","how","i","if","in","is","it","its","me","my","of","on","or","see","she",
  "so","that","the","their","them","there","these","they","this","to","too","was","we","were","what",
  "when","where","which","who","will","with","you","your","u","ur","im","its","thats",
]);

/** Lowercase, strip punctuation, drop stopwords, keep numerals (sizes and prices
 *  are content words in commerce chat, not noise). */
export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)?/g) || []).filter(
    (t) => t.length > 1 && !STOP.has(t),
  );
}

/** Light suffix folding. Not a real stemmer — deliberately. A Porter stemmer
 *  mangles brand tokens ("yeezy" -> "yeezi"), and brands are exactly the tokens
 *  that must match exactly here. This only handles plurals and -ing/-ed. */
export function fold(t: string): string {
  // Threshold is 3, not 4, so short alphanumeric model tokens fold correctly:
  // a buyer types "990s" and the listing key is "990".
  if (t.length <= 3) return t;
  if (t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.endsWith("ses") || t.endsWith("xes") || t.endsWith("zes")) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  if (t.endsWith("ing") && t.length > 6) return t.slice(0, -3);
  if (t.endsWith("ed") && t.length > 5) return t.slice(0, -2);
  return t;
}

export const terms = (s: string): string[] => tokenize(s).map(fold);

/** Character n-grams over the raw (space-normalized) string. This is the second
 *  retrieval leg: it recovers matches BM25 loses to typos and run-together
 *  words — "chicagos", "authenticaton", "boxlogo" — which is most of live chat. */
export function charNgrams(s: string, n = 3): string[] {
  const norm = ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const out: string[] = [];
  for (let i = 0; i + n <= norm.length; i++) out.push(norm.slice(i, i + n));
  return out;
}

export type SparseVec = Map<string, number>;

/** L2-normalized n-gram frequency vector. Normalizing at build time makes the
 *  cosine a plain dot product at query time. */
export function ngramVector(s: string, n = 3): SparseVec {
  const v: SparseVec = new Map();
  for (const g of charNgrams(s, n)) v.set(g, (v.get(g) || 0) + 1);
  let norm = 0;
  for (const x of v.values()) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (const [k, x] of v) v.set(k, x / norm);
  return v;
}

export function cosine(a: SparseVec, b: SparseVec): number {
  // Iterate the smaller map — query vectors are far smaller than document ones.
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, x] of small) {
    const y = big.get(k);
    if (y !== undefined) dot += x * y;
  }
  return dot;
}
