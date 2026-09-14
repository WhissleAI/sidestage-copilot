// Retrieval evaluation — 38 labelled buyer questions with the fact that MUST be
// retrieved to answer them.
//
// The point is not to report a number for the production configuration; it is to
// ablate, so the claim "structured-first plus hybrid similarity" is backed by
// what each piece contributes rather than by assertion:
//
//   lexical          BM25 only
//   ngram            char-trigram cosine only
//   fused            BM25 + ngram, RRF, no structured lookup
//   structured-only  slot resolution + field lookup, no similarity
//   hybrid           structured + fused  (what production runs)
//
// Metrics are recall@k (is the gold fact anywhere in the top k) and MRR. recall@1
// is the one that matters most: the composer is told to answer from the facts it
// is given, so a gold fact that ranks fifth out of eight is much weaker grounding
// than one that ranks first.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rig, PINNED, cleanup } from "./helpers.js";
import type { RetrievalMode } from "../src/retrieval/retriever.js";

interface Labelled {
  q: string;
  /** The fact that must be retrieved. */
  gold: string;
  /** Extra facts that would also be acceptable as the top hit. */
  alt?: string[];
}

const LABELLED: Labelled[] = [
  // price
  { q: "whats the lowest on the chicagos?", gold: `listing:${PINNED}#price` },
  { q: "how much for the chicago 1s", gold: `listing:${PINNED}#price` },
  { q: "price on the box logo?", gold: "listing:lst_bogo_l#price" },
  { q: "how much for the pandas", gold: "listing:lst_dunk_panda_11#price" },
  { q: "what are the 990s going for", gold: "listing:lst_nb990_95#price" },
  { q: "whats the chunky dunky at", gold: "listing:lst_sb_dunk_9#price" },
  { q: "how much are the slides", gold: "listing:lst_yz_slide_10#price" },
  { q: "price on the nuptse", gold: "listing:lst_tn_hoodie_m#price" },

  // discount
  { q: "can you do 380", gold: "policy:pol_discount", alt: [`listing:${PINNED}#price`] },
  { q: "any deal if i take two", gold: "policy:pol_discount", alt: ["qa:qa_bundle"] },
  { q: "would you take 360 shipped", gold: "policy:pol_discount", alt: [`listing:${PINNED}#price`] },

  // availability
  { q: "size 10 still there??", gold: `listing:${PINNED}#availability` },
  { q: "are the chicagos still available", gold: `listing:${PINNED}#availability` },
  { q: "how many pandas left", gold: "listing:lst_dunk_panda_11#availability" },
  { q: "is the bogo gone already", gold: "listing:lst_bogo_l#availability" },
  { q: "did the slides sell", gold: "listing:lst_yz_slide_10#availability" },

  // shipping
  { q: "ship to canada?", gold: "policy:pol_ship_intl", alt: ["policy:pol_ship_domestic", `listing:${PINNED}#shipping`] },
  { q: "do you ship international", gold: "policy:pol_ship_intl", alt: ["policy:pol_ship_domestic", `listing:${PINNED}#shipping`] },
  { q: "do i pay customs to the uk", gold: "policy:pol_ship_intl", alt: ["policy:pol_ship_domestic"] },
  { q: "is shipping free on the chicagos", gold: `listing:${PINNED}#shipping`, alt: ["policy:pol_ship_domestic"] },
  { q: "how fast do these ship", gold: "qa:qa_ship_speed", alt: ["policy:pol_ship_domestic", `listing:${PINNED}#shipping`] },
  { q: "whats shipping on the slides", gold: "listing:lst_yz_slide_10#shipping", alt: ["policy:pol_ship_domestic"] },

  // returns
  { q: "whats the return policy", gold: "policy:pol_returns" },
  { q: "can i return if they dont fit", gold: "policy:pol_returns" },
  { q: "who pays return shipping", gold: "policy:pol_returns" },

  // authenticity
  { q: "are these authenticated", gold: `listing:${PINNED}#authenticity`, alt: ["policy:pol_auth"] },
  { q: "do the pandas come with a cert", gold: "listing:lst_dunk_panda_11#authenticity", alt: ["policy:pol_auth"] },
  { q: "how do i verify the checkcheck number", gold: "qa:qa_cert_lookup", alt: ["policy:pol_auth"] },
  { q: "are the box logos legit checked", gold: "listing:lst_bogo_l#authenticity", alt: ["policy:pol_auth"] },

  // sizing
  { q: "do the 990s run big", gold: "qa:qa_size_990", alt: ["listing:lst_nb990_95#sizing"] },
  { q: "do yeezy slides run big", gold: "qa:qa_size_slide", alt: ["listing:lst_yz_slide_10#sizing"] },
  { q: "what size are the box logos", gold: "listing:lst_bogo_l#sizing" },

  // condition
  { q: "is the cracked leather a flaw on the lost and founds", gold: `listing:${PINNED}#condition`, alt: ["qa:qa_crease"] },
  { q: "how much creasing on the chunky dunkys", gold: "listing:lst_sb_dunk_9#condition" },
  { q: "does it come with the original box", gold: `listing:${PINNED}#condition`, alt: ["qa:qa_box"] },
  { q: "what condition are the 990s", gold: "listing:lst_nb990_95#condition" },

  // market / research
  { q: "are the pandas worth it at that price", gold: "market:NK-DUNK-PANDA#median", alt: ["listing:lst_dunk_panda_11#price"] },
  { q: "what are the chicagos worth", gold: "market:AJ1-CHI-REIMAGINED#median", alt: [`listing:${PINNED}#price`] },
];

const MODES: RetrievalMode[] = ["lexical", "ngram", "fused", "structured-only", "hybrid"];

interface Score {
  r1: number; r3: number; r5: number; mrr: number; abstained: number; n: number;
}

async function evaluate(mode: RetrievalMode): Promise<Score> {
  const r = await rig();
  const s: Score = { r1: 0, r3: 0, r5: 0, mrr: 0, abstained: 0, n: LABELLED.length };

  for (const c of LABELLED) {
    const res = r.retriever.retrieve(c.q, { pinnedId: PINNED, mode, maxFacts: 8 });
    if (res.abstain) s.abstained++;
    const ids = res.evidence.map((e) => e.factId);
    const accept = new Set([c.gold, ...(c.alt ?? [])]);

    let rank = -1;
    for (let i = 0; i < ids.length; i++) {
      if (accept.has(ids[i])) { rank = i; break; }
    }
    if (rank === 0) s.r1++;
    if (rank >= 0 && rank < 3) s.r3++;
    if (rank >= 0 && rank < 5) s.r5++;
    if (rank >= 0) s.mrr += 1 / (rank + 1);
  }
  return s;
}

test("retrieval: ablation over the labelled question set", async () => {
  const rows: [RetrievalMode, Score][] = await Promise.all(
    MODES.map(async (m) => [m, await evaluate(m)] as [RetrievalMode, Score]),
  );

  console.log(`\n  retrieval over ${LABELLED.length} labelled buyer questions`);
  console.log(`    ${"mode".padEnd(17)} ${"R@1".padEnd(7)} ${"R@3".padEnd(7)} ${"R@5".padEnd(7)} MRR`);
  for (const [mode, s] of rows) {
    const f = (x: number) => (x / s.n).toFixed(3).padEnd(7);
    console.log(`    ${mode.padEnd(17)} ${f(s.r1)} ${f(s.r3)} ${f(s.r5)} ${(s.mrr / s.n).toFixed(3)}`);
  }
  console.log();

  const by = Object.fromEntries(rows) as Record<RetrievalMode, Score>;

  // The production configuration must beat every ablation on recall@1. If it
  // does not, the extra machinery is not earning its keep and should be cut.
  for (const m of ["lexical", "ngram", "fused", "structured-only"] as RetrievalMode[]) {
    assert.ok(
      by.hybrid.r1 >= by[m].r1,
      `hybrid R@1 (${by.hybrid.r1}) should be at least ${m} R@1 (${by[m].r1})`,
    );
  }

  // Absolute floors, so a regression is caught rather than merely compared.
  assert.ok(by.hybrid.r1 / by.hybrid.n >= 0.8, `hybrid R@1 ${(by.hybrid.r1 / by.hybrid.n).toFixed(3)} is below 0.80`);
  assert.ok(by.hybrid.r3 / by.hybrid.n >= 0.9, `hybrid R@3 ${(by.hybrid.r3 / by.hybrid.n).toFixed(3)} is below 0.90`);
});

/** Deterministic keyboard-style typos: transpose, drop, double. Live-chat buyers
 *  type fast on phones, and the labelled set above is unrealistically well spelled. */
function typo(s: string, seed: number): string {
  const words = s.split(" ");
  let a = seed >>> 0;
  const next = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  return words
    .map((w) => {
      if (w.length < 5 || next() > 0.5) return w;
      const i = 1 + Math.floor(next() * (w.length - 2));
      const mode = Math.floor(next() * 3);
      if (mode === 0) return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2); // transpose
      if (mode === 1) return w.slice(0, i) + w.slice(i + 1);                    // drop
      return w.slice(0, i) + w[i] + w.slice(i);                                 // double
    })
    .join(" ");
}

async function evaluateTypos(mode: RetrievalMode, seed: number): Promise<Score> {
  const r = await rig();
  const s: Score = { r1: 0, r3: 0, r5: 0, mrr: 0, abstained: 0, n: LABELLED.length };
  for (const c of LABELLED) {
    const res = r.retriever.retrieve(typo(c.q, seed), { pinnedId: PINNED, mode, maxFacts: 8 });
    const ids = res.evidence.map((e) => e.factId);
    const accept = new Set([c.gold, ...(c.alt ?? [])]);
    const rank = ids.findIndex((x) => accept.has(x));
    if (rank === 0) s.r1++;
    if (rank >= 0 && rank < 3) s.r3++;
    if (rank >= 0 && rank < 5) s.r5++;
    if (rank >= 0) s.mrr += 1 / (rank + 1);
  }
  return s;
}

test("retrieval: the ngram leg earns its place on MISSPELLED questions, not clean ones", async () => {
  // On the clean set, fusing the ngram leg into BM25 does NOT help — it costs a
  // little MRR, because BM25 alone already ranks well-spelled questions well.
  const cleanLex = await evaluate("lexical");
  const cleanFused = await evaluate("fused");

  // The leg exists for the case the clean set under-represents. Average over
  // several perturbation seeds so the comparison is not one lucky draw.
  const seeds = [1, 7, 13, 29, 101];
  const avg = async (mode: RetrievalMode) => {
    let acc = 0;
    for (const sd of seeds) acc += (await evaluateTypos(mode, sd)).mrr;
    return acc / (seeds.length * LABELLED.length);
  };

  const typoLex = await avg("lexical");
  const typoFused = await avg("fused");

  console.log(`\n  ngram-leg ablation (MRR)`);
  console.log(`    clean questions      lexical ${(cleanLex.mrr / cleanLex.n).toFixed(3)}   fused ${(cleanFused.mrr / cleanFused.n).toFixed(3)}`);
  console.log(`    misspelled questions lexical ${typoLex.toFixed(3)}   fused ${typoFused.toFixed(3)}`);
  console.log(`    degradation          lexical ${(((cleanLex.mrr / cleanLex.n) - typoLex) / (cleanLex.mrr / cleanLex.n) * 100).toFixed(1)}%   fused ${(((cleanFused.mrr / cleanFused.n) - typoFused) / (cleanFused.mrr / cleanFused.n) * 100).toFixed(1)}%\n`);

  assert.ok(
    typoFused > typoLex,
    `fused MRR on misspelled questions (${typoFused.toFixed(3)}) should beat lexical (${typoLex.toFixed(3)}) — ` +
    "if it does not, the ngram leg is dead weight and should be removed",
  );
});

test("retrieval: abstains on questions the catalog genuinely cannot answer", async () => {
  const r = await rig();
  // These have no grounding: a size we do not stock, a future drop, a favour.
  // The right behaviour is to retrieve nothing confident rather than to surface
  // a loosely-related fact the composer would then answer from.
  const res = r.retriever.retrieve("will you be selling jordan 4s next week", { pinnedId: PINNED, mode: "fused" });
  assert.equal(res.abstain, true, "a question with no grounding must abstain");
});

test("retrieval: a markdown is visible to the very next question", async () => {
  const r = await rig();
  const before = r.retriever.retrieve("how much for the chicagos", { pinnedId: PINNED });
  const priceFact = before.facts.find((f) => f.factId === `listing:${PINNED}#price`)!;
  assert.equal(priceFact.numericCents, 41200);
  assert.equal(priceFact.listingVersion, 1);

  await r.repo.mutateListing(PINNED, { priceCents: 37000 });
  await r.retriever.rebuild();

  const after = r.retriever.retrieve("how much for the chicagos", { pinnedId: PINNED });
  const updated = after.facts.find((f) => f.factId === `listing:${PINNED}#price`)!;
  assert.equal(updated.numericCents, 37000);
  assert.equal(updated.listingVersion, 2, "the fact must carry the NEW version");
});

// Every rig() creates a real show in the real database. Without this the suite
// leaked one show plus its whole catalog per test — 809 shows and 6,488 listings
// before anyone looked.
after(cleanup);
