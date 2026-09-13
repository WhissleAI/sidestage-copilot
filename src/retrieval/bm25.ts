// Okapi BM25 over the fact corpus. Small enough to keep entirely in memory and
// rebuild whenever a listing changes — the whole corpus is a few hundred short
// documents, so an incremental index would be complexity with no payoff.

import type { Fact } from "./facts.js";
import { terms } from "./text.js";

const K1 = 1.2;
const B = 0.75;

export class Bm25Index {
  private df = new Map<string, number>();
  private tf: Map<string, number>[] = [];
  private len: number[] = [];
  private avgLen = 0;
  private n = 0;

  constructor(private facts: Fact[]) {
    this.n = facts.length;
    for (const f of facts) {
      const counts = new Map<string, number>();
      for (const t of f.tokens) counts.set(t, (counts.get(t) || 0) + 1);
      this.tf.push(counts);
      this.len.push(f.tokens.length);
      for (const t of counts.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.avgLen = this.len.reduce((a, b) => a + b, 0) / (this.n || 1);
  }

  /** Robertson/Sparck-Jones idf with the +1 guard, so a term appearing in more
   *  than half the corpus cannot contribute a negative score. */
  private idf(t: string): number {
    const df = this.df.get(t) || 0;
    return Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
  }

  /** Top raw score for a query. Used as the abstain backstop — RRF scores cannot
   *  serve that purpose, because rank 1 always scores 1/(k+1) whatever matched. */
  topScore(query: string): number {
    return this.search(query)[0]?.score ?? 0;
  }

  search(query: string): { index: number; score: number }[] {
    const q = terms(query);
    const scores = new Array<number>(this.n).fill(0);
    for (const t of q) {
      const idf = this.idf(t);
      if (idf === 0) continue;
      for (let i = 0; i < this.n; i++) {
        const f = this.tf[i].get(t);
        if (!f) continue;
        const norm = 1 - B + B * (this.len[i] / (this.avgLen || 1));
        scores[i] += idf * ((f * (K1 + 1)) / (f + K1 * norm));
      }
    }
    return scores
      .map((score, index) => ({ index, score }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
  }
}
