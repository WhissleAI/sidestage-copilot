// Reply cache — the single largest latency win available, because live chat is
// enormously repetitive. In a busy show "how much", "does it come with the box"
// and "ship to canada" arrive dozens of times in a few minutes. Answering the
// first one in 1.4 s and the next twenty in under a millisecond is what moves
// p95 rather than p50.
//
// The correctness question is invalidation, and this is where the listing
// `version` earns its keep a second time: the cache key includes the version of
// every listing the answer was grounded in, so a markdown does not just expire
// the entry — it makes the old key unreachable. There is no TTL race to lose.

import { terms } from "../retrieval/text.js";
import type { Claim, Evidence, GuardResult, Verdict } from "../domain/types.js";

export interface CachedReply {
  answer: string;
  claims: Claim[];
  evidence: Evidence[];
  guards: GuardResult[];
  verdict: Verdict;
  confidence: number;
  repaired: boolean;
}

interface Entry {
  value: CachedReply;
  at: number;
}

export interface CacheKeyParts {
  question: string;
  /** listingId -> version, for every listing the answer touched. */
  versions: Record<string, number>;
}

/**
 * Normalize the question to its sorted content terms. "how much for the pandas"
 * and "the pandas, how much?" collapse to the same key; "how much for the
 * dunks" does not. Deliberately conservative — a false cache hit is a wrong
 * answer sent to a buyer, which is far worse than a miss.
 */
export function cacheKey(parts: CacheKeyParts): string {
  const q = [...new Set(terms(parts.question))].sort().join(" ");
  const v = Object.keys(parts.versions).sort().map((k) => `${k}@${parts.versions[k]}`).join(",");
  return `${q}|${v}`;
}

export class ReplyCache {
  private map = new Map<string, Entry>();

  constructor(private max = 400, private ttlMs = 10 * 60_000) {}

  get(key: string): CachedReply | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() - e.at > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    // Refresh recency for the LRU eviction below.
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: CachedReply): void {
    // Never cache a reply that failed a guard. A blocked draft is a decision
    // about one moment's catalog state, and replaying it would silently reuse a
    // verdict whose inputs may have changed.
    if (value.verdict !== "allow") return;
    this.map.set(key, { value, at: Date.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
