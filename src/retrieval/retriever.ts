// The retriever. Structured-first, then a hybrid similarity leg, fused with
// Reciprocal Rank Fusion.
//
// Why this shape rather than "embed everything and take the top 5":
//   • The answers that MUST be right (price, stock, cert number) are field
//     lookups. Resolving them structurally makes them exact and verifiable, and
//     attaches the listing `version` that the price guard later checks.
//   • The answers that are genuinely fuzzy (past Q&A, condition prose, policy
//     wording) are what the similarity leg is for.
//   • RRF fuses the two lexical/ngram rankings without needing calibrated
//     scores — it only needs ranks, which is exactly what we can trust here.
//
// `docs/EVALS.md` reports recall@k and MRR for lexical-only vs this hybrid over
// a labelled question -> factId set.

import type { Evidence } from "../domain/types.js";
import type { Repo, ListingWithDescription } from "../domain/repo.js";
import { buildFacts, type Fact, type FactField } from "./facts.js";
import { Bm25Index } from "./bm25.js";
import { cosine, ngramVector, terms } from "./text.js";
import { GENERIC_TITLE_TOKENS, POLICY_LED, resolveSlots, type Slots } from "./slots.js";

/** RRF damping. 60 is the value from the original Cormack et al. formulation;
 *  it flattens the head enough that one leg cannot dominate the fusion. */
const RRF_K = 60;
const MAX_FACTS = 8;
/**
 * Abstention backstop.
 *
 * The signal is slot resolution FAILING — no listing and no attribute could be
 * resolved — because on a corpus this small a similarity score does not separate
 * "answerable" from "unanswerable" at all: measured over the labelled set,
 * ungrounded questions score BM25 2.6-5.7 and grounded ones 2.0-10.7, which
 * overlap almost completely (docs/EVALS.md). So similarity is used only as a
 * backstop below this raw BM25 score, never as the primary test.
 */
const ABSTAIN_BM25_BELOW = 4.0;

export interface RetrievalResult {
  evidence: Evidence[];
  facts: Fact[];
  abstain: boolean;
  slots: Slots;
  mode: "structured" | "hybrid" | "mixed" | "abstain";
}

/** Retrieval configurations. `hybrid` is production: structured lookup plus both
 *  similarity legs fused. The rest exist so docs/EVALS.md can measure what each
 *  part actually contributes instead of asserting that it helps. */
export type RetrievalMode =
  | "hybrid"          // structured + BM25 + ngram (production)
  | "fused"           // BM25 + ngram, no structured lookup
  | "lexical"         // BM25 only
  | "ngram"           // char-ngram cosine only
  | "structured-only";

export class Retriever {
  private facts: Fact[] = [];
  private byId = new Map<string, Fact>();
  private bm25!: Bm25Index;

  /** The listings the current index was built from.
   *
   *  Held rather than re-read so `retrieve()` stays synchronous — and, more
   *  importantly, so the lineup a question is resolved against is the SAME
   *  snapshot the facts were built from. Reading listings live while the index
   *  lagged a rebuild behind meant slot resolution and the fact text could
   *  briefly disagree about what was in the show. */
  private listings: ListingWithDescription[] = [];

  constructor(private repo: Repo) {}

  /** Rebuild the index. Called on boot and whenever a listing write lands, so a
   *  markdown is reflected in retrieved facts on the very next question. */
  async rebuild(): Promise<void> {
    const [facts, listings] = await Promise.all([buildFacts(this.repo), this.repo.listings()]);
    this.facts = facts;
    this.listings = listings;
    this.byId = new Map(this.facts.map((f) => [f.factId, f]));
    this.bm25 = new Bm25Index(this.facts);
  }

  fact(factId: string): Fact | null {
    return this.byId.get(factId) ?? null;
  }

  get size(): number {
    return this.facts.length;
  }

  retrieve(
    question: string,
    opts: { pinnedId?: string | null; mode?: RetrievalMode; maxFacts?: number } = {},
  ): RetrievalResult {
    const mode = opts.mode ?? "hybrid";
    let maxFacts = opts.maxFacts ?? MAX_FACTS;
    let noMatchInventory = false;
    const listings = this.listings;
    const slots = resolveSlots(question, listings, opts.pinnedId ?? null);

    const picked = new Map<string, number>(); // factId -> score

    // ── leg 0: inventory search ───────────────────────────────────────────
    // "any red sox", "Got any Grady Sizemore?" — the dominant question shape in
    // a real live-commerce chat. This is a SEARCH over the lineup, not a field
    // lookup on the pinned lot, and answering it the other way produces a
    // confident answer to a question nobody asked.
    if (slots.inventoryQuery && mode !== "lexical" && mode !== "ngram") {
      const q = new Set(terms(slots.inventoryQuery));
      const matches: { id: string; hits: number }[] = [];
      const searchable = listings.filter((l) => !l.externalRef);
      for (const l of (searchable.length ? searchable : listings)) {
        if (l.state === "ended") continue;
        // Identity fields only. Matching the DESCRIPTION made every prose word a
        // hit, which is how "any $2.50 incuse Indian gold coin" matched a
        // baseball card: "gold" appears in "Topps Gold".
        const hay = new Set(terms(`${l.title} ${l.shortName} ${l.brand} ${l.model} ${l.colorway}`));
        let hits = 0;
        let distinct = 0;
        for (const t of q) {
          if (!hay.has(t)) continue;
          hits++;
          if (!GENERIC_TITLE_TOKENS.has(t)) distinct++;
        }
        // A single GENERIC token is not a match. Colours, metals and grades
        // appear across half a catalog; they qualify an item, they do not name
        // one. Two hits, or one distinctive hit, is a real match.
        if (distinct > 0 || hits >= 2) matches.push({ id: l.id, hits: distinct * 2 + hits });
      }
      matches.sort((a, b) => b.hits - a.hits);

      // The lineup fact ALWAYS rides along: with a match it names the lot, and
      // with no match it is the evidence for an honest "not in tonight's show".
      picked.set("catalog:lineup", 1);
      if (matches.length) {
        // Room for up to three matched lots' fact sets plus the lineup.
        maxFacts = Math.max(maxFacts, 16);
      } else {
        // NOTHING matched. The honest answer is "not in tonight's lineup", and
        // it needs exactly one fact. Letting the similarity leg fill fifteen
        // slots with unrelated lots made the console unreadable and handed the
        // model a pile of items it was not asked about.
        noMatchInventory = true;
      }
      // Give a matched lot the SAME fact set an attribute question would get.
      // Supplying only identity/price/availability made the model cite a
      // condition fact it had never been handed, which the grounding guard then
      // correctly blocked — a self-inflicted false positive.
      const perMatch: [FactField, number][] = [
        ["identity", 0.98], ["price", 0.96], ["availability", 0.94],
        ["condition", 0.9], ["sizing", 0.88], ["authenticity", 0.86], ["shipping", 0.84],
      ];
      for (const m of matches.slice(0, 3)) {
        for (const [field, score] of perMatch) {
          const f = this.byId.get(`listing:${m.id}#${field}`);
          if (f) picked.set(f.factId, Math.max(picked.get(f.factId) ?? 0, score));
        }
      }
    }

    // ── leg 1: structured lookup ──────────────────────────────────────────
    if (mode !== "lexical" && mode !== "ngram" && mode !== "fused") {
      // A listing fact for the field the buyer actually asked about ranks above
      // one pulled in by expansion; and where the answer is really a policy, the
      // clause leads and the listing field supports it.
      const primaryIsPolicyLed = POLICY_LED.has(slots.primaryField);
      for (const id of slots.listingIds) {
        for (const field of slots.fields) {
          const f = this.byId.get(`listing:${id}#${field}`);
          if (!f) continue;
          const isPrimary = field === slots.primaryField;
          const score = isPrimary ? (primaryIsPolicyLed ? 0.92 : 1) : 0.88;
          picked.set(f.factId, Math.max(picked.get(f.factId) ?? 0, score));
        }
        // Identity always rides along: it is what lets the reply name the item.
        const ident = this.byId.get(`listing:${id}#identity`);
        if (ident) picked.set(ident.factId, Math.max(picked.get(ident.factId) ?? 0, 0.85));
        // A price question is also a market question — the median is what makes
        // a discount answer defensible instead of arbitrary.
        if (slots.fields.includes("price") || slots.fields.includes("discount") || slots.fields.includes("market")) {
          const l = listings.find((x) => x.id === id);
          const m = l && this.byId.get(`market:${l.sku}#median`);
          if (m) picked.set(m.factId, Math.max(picked.get(m.factId) ?? 0, 0.8));
        }
      }
      for (const topic of slots.policyTopics) {
        const leads = primaryIsPolicyLed && FIELD_POLICY[slots.primaryField] === topic;
        for (const f of this.facts) {
          if (f.source === "policy" && f.policyTopic === topic) {
            picked.set(f.factId, Math.max(picked.get(f.factId) ?? 0, leads ? 1 : 0.9));
          }
        }
      }
    }
    const structuredCount = picked.size;

    // ── leg 2: similarity, fused ──────────────────────────────────────────
    let bestFused = 0;
    if (mode !== "structured-only" && !noMatchInventory) {
      const fused = this.fuse(question, mode);
      bestFused = fused[0]?.score ?? 0;
      for (const { factId, score } of fused) {
        if (picked.size >= maxFacts) break;
        if (!picked.has(factId)) picked.set(factId, Math.min(0.75, score / (bestFused || 1) * 0.75));
      }
    }

    // Nothing resolved structurally AND nothing matched lexically with any
    // conviction: say so, rather than hand the composer a loosely-related fact
    // and invite it to answer from it.
    const abstain =
      !slots.inventoryQuery &&
      structuredCount === 0 &&
      this.bm25.topScore(question) < ABSTAIN_BM25_BELOW;

    const chosen = [...picked.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxFacts)
      .map(([factId, score]) => ({ fact: this.byId.get(factId)!, score }))
      .filter((x) => x.fact);

    return {
      evidence: chosen.map(({ fact, score }) => toEvidence(fact, score)),
      facts: chosen.map((x) => x.fact),
      abstain,
      slots,
      mode: abstain ? "abstain" : structuredCount && chosen.length > structuredCount ? "mixed" : structuredCount ? "structured" : "hybrid",
    };
  }

  /** Rank by BM25 and by char-ngram cosine, then fuse the two RANKINGS. */
  private fuse(question: string, mode: RetrievalMode): { factId: string; score: number }[] {
    const lists: { index: number; score: number }[][] = [];
    if (mode === "hybrid" || mode === "fused" || mode === "lexical") lists.push(this.bm25.search(question));
    if (mode === "hybrid" || mode === "fused" || mode === "ngram") lists.push(this.ngramSearch(question));

    const fused = new Map<number, number>();
    for (const list of lists) {
      list.forEach((hit, rank) => {
        fused.set(hit.index, (fused.get(hit.index) ?? 0) + 1 / (RRF_K + rank + 1));
      });
    }
    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([index, score]) => ({ factId: this.facts[index].factId, score }));
  }

  private ngramSearch(question: string): { index: number; score: number }[] {
    const q = ngramVector(question);
    const out: { index: number; score: number }[] = [];
    for (let i = 0; i < this.facts.length; i++) {
      const score = cosine(q, this.facts[i].vector);
      if (score > 0.02) out.push({ index: i, score });
    }
    return out.sort((a, b) => b.score - a.score);
  }
}

/** Which policy topic each policy-led field answers to. */
const FIELD_POLICY: Partial<Record<FactField, string>> = {
  shipping: "shipping", returns: "returns", authenticity: "authenticity", discount: "discount",
};

export function toEvidence(f: Fact, score: number): Evidence {
  const e: Evidence = {
    factId: f.factId,
    source: f.source,
    label: f.label,
    text: f.text,
    score: Number(score.toFixed(3)),
  };
  if (f.listingVersion !== undefined) e.listingVersion = f.listingVersion;
  return e;
}

export type { Fact, FactField };
