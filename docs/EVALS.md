# Evaluations

Three harnesses. Two run with **no credentials** (`npm run eval`, `npm test`); the latency
benchmark exercises the real reply path (`npm run bench`).

Everything below is reproducible — the commands are the ones that produced the numbers, against
the seeded catalog in `src/db/seed.ts`.

---

## 1. Guardrails — precision and recall on blocking

`test/guardrails.eval.ts` · `npm run eval`

**46 labelled cases**, each a `(catalog state, buyer question, drafted reply)` triple with the
verdict a careful seller would give. **21 of the 46 should pass** — a suite made only of
violations measures nothing, because a chain that blocks everything would score perfectly on it.
The pass cases are what hold false positives down, and a false positive is expensive: it puts a
correct reply in front of the seller as a problem and trains them to click through warnings.

Several cases mutate catalog state before judging — landing a markdown, zeroing stock — so the
staleness checks are exercised against a genuinely moved target rather than a fixture.

Measured 2026-09-19; this is the run's stdout:

```
  guardrail chain over 46 labelled cases
    caught 25  missed 0  false alarms 0  clean passes 21
    precision 1.000   recall 1.000   f1 1.000
    availability     fired on 4/4 of its own cases
    claim_grounding  fired on 4/4 of its own cases
    pii              fired on 2/2 of its own cases
    policy           fired on 6/6 of its own cases
    price            fired on 4/4 of its own cases
    tone             fired on 5/5 of its own cases
```

`community_rule` and `sponsor` do not appear because the labelled set has no cases for either.
Two of the eight shipped guards are unmeasured.

Thresholds asserted in the suite are **asymmetric**: recall ≥ 0.95, precision ≥ 0.90. A miss is
a wrong answer sent to a buyer; a false alarm costs the seller a glance.

**`npm run eval` exits non-zero today, under that perfect scoreboard.** The scoring test
binarises — it asks only whether the chain *stopped* a draft, so `revise` and `block` score
identically — while a second test in the same file checks each case's exact verdict. On
2026-09-19 that second test failed, 8 of 46 reading `expected revise, got block`. Nothing runs
either automatically: `npm test` globs `test/*.test.ts`, `npm run eval` globs `test/*.eval.ts`,
and only a human types the second. A red eval that nothing runs is how the rest of this document
went stale.

### What this number does and does not mean

It means the chain behaves correctly on 46 cases chosen to cover each guard's decision boundary
— including the adversarial ones: declining a lowball by naming it (must pass), accepting one
below the floor (must block), "guaranteed authentic" on a certified listing (passes) versus an
uncertified one (blocks).

It does **not** mean the guards are right on the long tail. 46 cases is small, they were written
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

Measured 2026-09-19, twice, identical both times — the suite is deterministic, so this table
is that run's stdout rather than a transcription:

```
  retrieval over 38 labelled buyer questions
    mode              R@1     R@3     R@5     MRR
    lexical           0.553   0.763   0.763   0.657
    ngram             0.526   0.605   0.684   0.604
    fused             0.579   0.711   0.789   0.668
    structured-only   0.842   0.895   0.921   0.875
    hybrid            0.842   0.921   0.974   0.898
```

**Reading it honestly:**

- **Structured lookup does the work.** It alone reaches R@1 0.842; the best similarity leg
  alone reaches 0.579. That is the core claim of the design, and it is the largest single
  effect here.
- **Similarity adds tail recall, not head precision.** Hybrid ties structured-only at R@1 and
  improves R@3 (0.895 → 0.921) and R@5 (0.921 → 0.974). It catches the questions slot
  resolution does not reach — past Q&A, condition prose.
- **The negative result this section used to carry has reversed, and is withdrawn.** Through
  2026-09-15 this doc reported that RRF fusion *lost* to BM25 alone on clean text (MRR 0.631 vs
  0.642) and §3 existed to justify keeping the leg anyway. Measured now, fused 0.668 **beats**
  lexical 0.657, and fused leads on R@1 and R@5 too. The leg no longer needs the typo argument
  to earn its place on clean text; §3 still holds and is now a second reason rather than the
  only one.

> The fusion figures moved because the retriever and the fact set moved under them, not because
> the labelled questions changed — it is still 38. Nobody re-ran this suite between those
> changes and 2026-09-19, which is how a doc ends up asserting the opposite of what the code
> does. The fix is not a better number; it is running it.

`recall@1` is weighted most heavily because the composer is instructed to answer from the facts
it is given: a gold fact ranked fifth of eight is much weaker grounding than one ranked first.

### Two real bugs this suite found

| # | Bug | Effect |
|---|---|---|
| 1 | **The abstain path was dead code.** The anaphora fallback was written `(ANAPHORA.test(lower) \|\| true)` — unconditional — so every question resolved to the pinned lot and nothing ever abstained. The RRF-score threshold could not fire either: rank 1 always scores `1/(k+1)`. | Abstention is now driven by slot resolution failing, with a weak-BM25 backstop. |
| 2 | **Policy questions ranked the listing field above the governing clause** — "do i pay customs to the uk" returned this pair's domestic shipping line first. Separately, "does it come with the original box" resolved to the Supreme **Box** Logo hoodie. | `POLICY_LED` fields let the clause lead; generic title tokens are stoplisted. Hybrid R@1 0.737 → **0.842** and MRR 0.836 → **0.897** when the fix landed; hybrid measures 0.842 / 0.898 today. |

### A negative result worth stating

**Similarity score is unusable as a confidence signal on a catalog this size.** Top BM25
scores, measured by hand while the feature was being considered and **not reproduced since** —
the suite does not print these, so treat the ranges as of 2026-09-15 and pending
re-measurement:

| | BM25 range (2026-09-15, not re-measured) |
|---|---|
| ungrounded questions ("whats the weather like") | 0.0 – 5.7 |
| grounded questions ("how much for the pandas") | 2.0 – 10.7 |

Those distributions overlap almost completely. A "confidence from retrieval score" feature was
planned and cut: it would have been noise presented as certainty. Confidence is now derived from
guard outcomes and evidence rank instead.

---

## 3. Does the n-gram leg earn its place?

Same suite. This section was written when §2 showed fusion **costing** MRR on clean questions;
it no longer does, so what follows is now the second argument for the leg rather than the only
one. The leg exists for typo tolerance, which the labelled set — written in full sentences —
under-represents. So the
suite perturbs every question with deterministic keyboard-style typos (transpose, drop, double)
and averages over five seeds.

Measured 2026-09-19, same run as §2:

```
  ngram-leg ablation (MRR)
    clean questions      lexical 0.657   fused 0.668
    misspelled questions lexical 0.390   fused 0.537
    degradation          lexical 40.7%   fused 19.7%
```

**Verdict: it stays, and the case is now unconditional.** It no longer costs anything on clean
text — fusion is ahead there too — and it still roughly **halves degradation** under typos
(40.7% → 19.7%). Live-chat buyers type fast on phones, so the misspelled column is the
realistic one. The test asserts this directly and says in its failure message that if fusion
ever stops winning here, the leg is dead weight and should be removed.

---

## 4. Latency

`bench/latency.bench.ts` · `npm run bench -- 24`

Replays a seeded script through the real pipeline against the real Whissle agent. Two passes:
cold (every reply hits the LLM), then the **same questions again** so the version-keyed cache
serves them.

> **Pending re-measurement.** Every figure in this section was measured on **2026-09-15** and
> has not been reproduced since; the bench needs `WHISSLE_API_KEY` and a live gateway, so it
> cannot be run from a checkout without one. The tail here is the shared hosted pool (see
> conclusion 3), which means these numbers age faster than anything else in this document.
> Quote them with the date attached or re-run `npm run bench -- 24` first.

**Three consecutive runs, 24 questions each — 2026-09-15:**

| run | cold p50 | cold p95 | cold p99 | breaches | cached p50 | cached p95 |
|---|---|---|---|---|---|---|
| 1 | 1220 ms | 2116 ms | 2733 ms | 8.3% | 4 ms | 1164 ms |
| 2 | 1211 ms | 3735 ms | 5983 ms | 12.5% | 2 ms | 1131 ms |
| 3 | 982 ms | 1950 ms | 2403 ms | 4.2% | 2 ms | 992 ms |

**Per-stage, run 1 — 2026-09-15:**

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

**Token streaming is implemented** (`chatTurnStream` in `src/llm/whissle.ts`; the pipeline
re-emits the proposal with `status: "drafting"` on every delta). It shortens time-to-first-token
— measured first token at ~1.0 s on a reply completing in ~1.1 s — and does not change the
numbers above, which are time-to-send: the guards judge the complete draft. The bench has not
been re-run since; the cold-path breaches stand as measured. On the hosted stack on
2026-09-15, proposals arrived in 0.5–1.5 s and a dry run on a cold path took 4.3 s.

### Cache correctness, not just speed

The benchmark ends by marking down the pinned lot and re-asking a question it had just cached:

```
  cache invalidation: after a markdown, "how much for the chicagos" was recomputed (correct)
```

The bench exits non-zero if that reply is ever served from cache.

---

## 5. Unit tests

`npm test` — **479 tests** across `test/*.test.ts` on Node's test runner (counted from a run on
2026-09-19), no LLM credentials required (a local Postgres is; `pretest` creates
`sidestage_test`).

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
| Contract suite | The real routing table driven the way the browser does it: REST routes, the SSE `hello` envelope, the header the browser sends, empty and malformed bodies |
| Tenancy | A stranger gets 404 on another account's show, report, record, export, timeline and media; lists and analytics are cut to the caller; a mutating route with no session is refused before the handler |
| eBay client and adapter | Token minting and scope narrowing, a silently dropped seller filter is a failure, sold vs asking never conflated; the write adapter refuses when the remote moved, withdraws rather than deletes, and names a missing connection |
| Account deletion | The challenge hash; a notice eBay signed verifies, the same bytes with a forged or missing signature do not |
| Session record | A settled proposal is written and its decision stamped once |
| Signals | Emotion and intent distributions kept whole on the transcript |

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
