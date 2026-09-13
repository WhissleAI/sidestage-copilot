# Evaluations

Three harnesses. Two run with **no credentials** (`npm run eval`, `npm test`); the latency
benchmark exercises the real reply path (`npm run bench`).

Everything below is reproducible — the commands are the ones that produced the numbers, against
the seeded catalog in `src/db/seed.ts`.

---

## 1. Guardrails — precision and recall on blocking

`test/guardrails.eval.ts` · `npm run eval`

**44 labelled cases**, each a `(catalog state, buyer question, drafted reply)` triple with the
verdict a careful seller would give. **19 of the 44 should pass** — a suite made only of
violations measures nothing, because a chain that blocks everything would score perfectly on it.
The pass cases are what hold false positives down, and a false positive is expensive: it puts a
correct reply in front of the seller as a problem and trains them to click through warnings.

Several cases mutate catalog state before judging — landing a markdown, zeroing stock — so the
staleness checks are exercised against a genuinely moved target rather than a fixture.

```
  guardrail chain over 44 labelled cases
    caught 25  missed 0  false alarms 0  clean passes 19
    precision 1.000   recall 1.000   f1 1.000
    availability     fired on 4/4 of its own cases
    claim_grounding  fired on 4/4 of its own cases
    pii              fired on 2/2 of its own cases
    policy           fired on 6/6 of its own cases
    price            fired on 4/4 of its own cases
    tone             fired on 5/5 of its own cases
```

Thresholds asserted in the suite are **asymmetric**: recall ≥ 0.95, precision ≥ 0.90. A miss is
a wrong answer sent to a buyer; a false alarm costs the seller a glance.

### What this number does and does not mean

It means the chain behaves correctly on 44 cases chosen to cover each guard's decision boundary
— including the adversarial ones: declining a lowball by naming it (must pass), accepting one
below the floor (must block), "guaranteed authentic" on a certified listing (passes) versus an
uncertified one (blocks).

It does **not** mean the guards are right on the long tail. 44 cases is small, they were written
by the same person who wrote the guards, and a perfect score on a self-authored suite mostly
demonstrates internal consistency. The suite's real value was as a bug-finder during
development, not as a score afterwards.

### Five real bugs this suite found

| # | Bug | Fix |
|---|---|---|
| 1 | `extractMoneyCents` never parsed bare negotiation numbers — "can you do 380" — although its own doc comment promised to. Every decline of a lowball blocked. | Verb-prefixed bare-number pattern |
| 2 | `FACTUAL` used `\b\d\b`, which matches a *single* digit between boundaries. "30 days" and every multi-digit price failed to register as a factual claim, so ungrounded replies passed. | Prefix matching, unanchored digits |
| 3 | Claim support was token-overlap only, which is brittle across morphology ("capped" vs "cap"). Valid citations were flagged unsupported. | Trigram cosine as a second signal |
| 4 | The price guard required every amount to match an existing fact, which made *offering a discount* impossible — the discount policy authorises a price no fact states. | Amounts below list within floor and cap are commitments, checked against floor and cap |
| 5 | The bare-number pattern read "caps at 15% off" as `$15.00` and blocked a valid reply. | Negative lookahead on `%` |

---

## 2. Retrieval — ablation

`test/retrieval.eval.ts` · `npm run eval`

**38 labelled buyer questions**, each with the fact that must be retrieved to answer it (plus
acceptable alternates where more than one fact genuinely answers). The point is to **ablate**,
so "structured-first plus hybrid similarity" is backed by what each piece contributes rather
than by assertion.

```
  retrieval over 38 labelled buyer questions
    mode              R@1     R@3     R@5     MRR
    lexical           0.526   0.737   0.789   0.642
    ngram             0.447   0.605   0.632   0.530
    fused             0.526   0.658   0.737   0.631
    structured-only   0.842   0.895   0.921   0.875
    hybrid            0.842   0.921   0.947   0.897
```

**Reading it honestly:**

- **Structured lookup does the work.** It alone reaches R@1 0.842; the similarity legs alone
  reach 0.526. That is the core claim of the design, and it is the largest single effect here.
- **Similarity adds tail recall, not head precision.** Hybrid ties structured-only at R@1 and
  improves R@3 (0.895 → 0.921) and R@5 (0.921 → 0.947). It catches the questions slot
  resolution does not reach — past Q&A, condition prose.
- **RRF fusion does not beat BM25 alone on clean text** (MRR 0.631 vs 0.642). Fusing a weaker
  leg costs a little ranking quality. That is a real negative result, and §3 is why the leg
  stays anyway.

`recall@1` is weighted most heavily because the composer is instructed to answer from the facts
it is given: a gold fact ranked fifth of eight is much weaker grounding than one ranked first.

### Two real bugs this suite found

| # | Bug | Effect |
|---|---|---|
| 1 | **The abstain path was dead code.** The anaphora fallback was written `(ANAPHORA.test(lower) \|\| true)` — unconditional — so every question resolved to the pinned lot and nothing ever abstained. The RRF-score threshold could not fire either: rank 1 always scores `1/(k+1)`. | Abstention is now driven by slot resolution failing, with a weak-BM25 backstop. |
| 2 | **Policy questions ranked the listing field above the governing clause** — "do i pay customs to the uk" returned this pair's domestic shipping line first. Separately, "does it come with the original box" resolved to the Supreme **Box** Logo hoodie. | `POLICY_LED` fields let the clause lead; generic title tokens are stoplisted. R@1 0.737 → **0.842**, MRR 0.836 → **0.897**. |

### A negative result worth stating

**Similarity score is unusable as a confidence signal on a catalog this size.** Measured top
BM25 scores:

| | BM25 range |
|---|---|
| ungrounded questions ("whats the weather like") | 0.0 – 5.7 |
| grounded questions ("how much for the pandas") | 2.0 – 10.7 |

Those distributions overlap almost completely. A "confidence from retrieval score" feature was
planned and cut: it would have been noise presented as certainty. Confidence is now derived from
guard outcomes and evidence rank instead.

---

## 3. Does the n-gram leg earn its place?

Same suite. §2 shows fusing the trigram leg **costs** MRR on clean questions. The leg exists for
typo tolerance, which the labelled set — written in full sentences — under-represents. So the
suite perturbs every question with deterministic keyboard-style typos (transpose, drop, double)
and averages over five seeds.

```
  ngram-leg ablation (MRR)
    clean questions      lexical 0.642   fused 0.631
    misspelled questions lexical 0.369   fused 0.510
    degradation          lexical 42.5%   fused 19.2%
```

**Verdict: it stays.** It costs 1.7% MRR on clean text and **halves degradation** under typos
(42.5% → 19.2%). Live-chat buyers type fast on phones, so the misspelled column is the realistic
one. The test asserts this directly and says in its failure message that if fusion ever stops
winning here, the leg is dead weight and should be removed.

---

## 4. Latency

`bench/latency.bench.ts` · `npm run bench -- 24`

Replays a seeded script through the real pipeline against the real Whissle agent. Two passes:
cold (every reply hits the LLM), then the **same questions again** so the version-keyed cache
serves them.

**Three consecutive runs, 24 questions each:**

| run | cold p50 | cold p95 | cold p99 | breaches | cached p50 | cached p95 |
|---|---|---|---|---|---|---|
| 1 | 1220 ms | 2116 ms | 2733 ms | 8.3% | 4 ms | 1164 ms |
| 2 | 1211 ms | 3735 ms | 5983 ms | 12.5% | 2 ms | 1131 ms |
| 3 | 982 ms | 1950 ms | 2403 ms | 4.2% | 2 ms | 992 ms |

**Per-stage, run 1:**

```
    admit          p50     0  p95     0
    classify       p50     0  p95     0
    retrieve       p50     1  p95     2
    compose (LLM)  p50  1212  p95  1693  p99  2113
    guard          p50     1  p95     5
    repair         p50   768  p95  1161      (2 of 24 replies)
    TOTAL          p50  1220  p95  2116  p99  2733   OVER BUDGET
```

**Conclusions:**

1. **Everything local is free.** admit, classify, retrieve and guard together are under 5 ms at
   p95. The budget is entirely the LLM hop.
2. **The 2-second p95 target is missed on the cold path**, in 2 of 3 runs. Breach rate 4–13%.
3. **The tail is the shared hosted pool, not our output size.** Cutting `max_tokens` 400 → 220
   moved p50 by under 1% while p95 swung from 1693 ms to 3733 ms between consecutive runs.
   Output length is not the lever; queueing is.
4. **The cache is the win.** p50 drops from ~1200 ms to ~2 ms on repeated questions, which
   matters because live chat genuinely asks the same six questions over and over.
5. **A repair pass roughly doubles the turn** (768 ms p50 on top). Bounding it to one is what
   keeps a `revise` from blowing the budget entirely.

**The honest fix is not implemented:** token streaming, so the seller sees text as it is
generated. The frontend contract already specifies a streaming `drafting` status; the backend
emits proposals once, complete.

### Cache correctness, not just speed

The benchmark ends by marking down the pinned lot and re-asking a question it had just cached:

```
  cache invalidation: after a markdown, "how much for the chicagos" was recomputed (correct)
```

The bench exits non-zero if that reply is ever served from cache.

---

## 5. Unit tests

`npm test` — 39 tests, no credentials required.

| Area | What is proven |
|---|---|
| Two-phase commit | A committed markdown lands on both sides and bumps the version |
| Rollback | Both sides restored from the preflight snapshot |
| Apply failure | Marketplace failure leaves **nothing** changed — no phantom local write |
| Concurrency | A remote edit under us is caught at reserve, before any write |
| Idempotency | Approving twice applies once; same intent at same version ⇒ same key |
| Audit chain | Full lifecycle recorded; tampering with a historical row is detected at the exact seq |
| Hash construction | Every field affects the hash; no separator collisions |
| Preflight | Floor price, discount cap, cost basis, negative stock, implausible jumps |
| Ladder | A blocked draft never auto-sends at any rung; price/discount never auto-answered |
| Cache | A version bump makes the old key unreachable; blocked replies are never cached |
| Two-layer policy | Certificate-conditional rules stay out of the agent config, but exist app-side |
| Proposer | Distinct-asker thresholds; proposed markdowns respect floor and cap |

---

## 6. What is not evaluated

Stated so nobody has to discover it:

- **No end-to-end reply-quality eval.** There is no labelled set of (question → ideal reply)
  scored by a human or a judge. The guardrail suite measures whether a reply is *safe*, not
  whether it is *good*.
- **No multi-turn evaluation.** Every reply is independent by design (`new_conversation: true`),
  so conversational coherence across a buyer's follow-ups is untested and probably weak.
- **No load testing.** The bench drives 24 questions at concurrency 3. Behaviour at a
  400-viewer chat burst is modelled by the rate cap but not measured.
- **The labelled sets are self-authored**, which bounds what a perfect score can mean.
- **Retrieval is evaluated on an 8-lot, 81-fact catalog.** Lexical recall degrades with catalog
  size; these numbers should not be extrapolated to a 5,000-lot seller.
