// Reply cache — the single largest latency win available, because live chat is
// enormously repetitive. In a busy show "how much", "does it come with the box"
// and "ship to canada" arrive dozens of times in a few minutes. Answering the
// first one in 1.4 s and the next twenty in under a millisecond is what moves
// p95 rather than p50.
//
// The correctness question is invalidation, and the first design got it exactly
// backwards in a way that only showed up on a live auction.
//
// Keying on the VERSION of every listing in evidence is safe but useless: a
// question like "what's the return policy" retrieves policy facts plus a handful
// of listing facts, so the key pinned on four listings' versions. On eBay Live a
// lot's version bumps on every bid — one watch reached v19 — so the key changed
// every few seconds and the hit rate sat at exactly 0%, forever.
//
// Key on the CONTENT the model was actually shown instead. The cached answer is
// valid for as long as the facts behind it read the same, whatever their version
// numbers did. A price moves, the price fact's text changes, the key changes, the
// entry becomes unreachable — the property that mattered is kept. An unrelated
// lot takes a bid and nothing changes, because nothing the answer depends on did.

import { createHash } from "node:crypto";
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
  /** The evidence the model was shown, verbatim. Content, not version numbers. */
  facts: { factId: string; text: string }[];
}

/**
 * Normalize the question to its sorted content terms. "how much for the pandas"
 * and "the pandas, how much?" collapse to the same key; "how much for the
 * dunks" does not. Deliberately conservative — a false cache hit is a wrong
 * answer sent to a buyer, which is far worse than a miss.
 */
export function cacheKey(parts: CacheKeyParts): string {
  const q = [...new Set(terms(parts.question))].sort().join(" ");
  // Order-independent: retrieval may rank the same facts differently between two
  // otherwise identical turns, and that is not a reason to miss.
  const evidence = parts.facts
    .map((f) => `${f.factId}\u0000${f.text}`)
    .sort()
    .join("\u0001");
  const digest = createHash("sha1").update(evidence).digest("hex").slice(0, 16);
  return `${q}|${digest}`;
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
