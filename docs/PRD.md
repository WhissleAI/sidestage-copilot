# SideStage — Product Requirements

## 1. The user

**Rae, a solo marketplace live-seller.**

She runs a 60–120 minute live selling show two or three nights a week on a marketplace with
live video — eBay Live, Whatnot, TikTok Shop — selling sneakers and streetwear from a queue of
40–80 lots, mostly single-quantity. 40–400 concurrent viewers. She sources, photographs, lists,
authenticates, hosts, packs and ships. There is nobody else.

This is a specific choice, not a category. A brand running a live show has a **producer**
calling the run of show, a **moderator** working chat, and a **merchandiser** who can change a
price without leaving the camera. Rae is all three at once *while being the person on camera
holding the product*. The copilot is not a nice-to-have productivity layer for her; it is the
three people she does not have.

Explicitly **not** the user, because the product would be different:

- A brand or agency running live commerce at scale — they need scheduling, multi-operator
  permissions, and brand-safety review workflows. Their bottleneck is coordination, not attention.
- A marketplace platform — they would need this as multi-tenant infrastructure with per-seller
  policy isolation.
- A pure dropshipper — no condition grading, no authentication, no per-item floor price, so
  most of the grounding surface here is irrelevant.

### What actually hurts

Three failures, in order of what they cost her:

1. **Questions go unanswered, and unanswered questions do not convert.** She physically cannot
   read chat and sell at the same time. During the 90 seconds she spends describing a lot,
   chat asks the same six questions — *how much, what size, does it come with the box, ship to
   Canada, is it legit, will you take X* — and by the time she looks down the questions have
   scrolled. Each one is a buyer who was close.
2. **Operational edits happen late or not at all.** Four people ask for a discount and the
   price stays put until she notices. The pinned lot sold out three minutes ago and chat is
   still asking about it. The item everyone wants is not the one on screen. Each is a
   detectable pattern with an obvious, reversible fix, and each one is currently gated on her
   noticing it mid-sentence.
3. **When she does answer fast, she answers wrong.** She quotes the pre-markdown price. She
   says "still available" about a lot that just sold. She says "yeah, authentic" about a
   general-release pair she never had authenticated. Each of these is a refund, a dispute, or
   a rating hit — and the fast answer is precisely the one most likely to be wrong.

Failure 3 is why this is a guardrails product and not a chatbot. **Speed without verification
makes the third failure worse, not better.** Any system that answers faster must prove, per
reply, that the answer is still true — otherwise it just industrialises the mistake.

### Evidence, and its limits

No live-seller interviews were run inside the build window. This is proxy research and is
labelled as such:

- **Practitioner writing and show observation** — reseller community threads and recorded
  Whatnot/eBay Live shows, which is where the question mix (price/availability dominant, a
  long tail of shipping, sizing, authenticity) and the ~50–60% reaction-to-question ratio in
  `src/ingest/script.ts` come from.
- **Comparable products** — marketplace-native auto-responders answer from a static FAQ and do
  not know the live price, which is the specific gap this design attacks. Generic live-chat
  copilots ground in a knowledge base with no notion of mid-session state changes.
- **Domain data** — the condition grading (DS/VNDS/USED), third-party authentication
  certificates above a price threshold, per-item floor prices and cost basis in
  `src/db/seed.ts` are how this category actually prices and describes inventory.

**The first thing a pilot must falsify** is the ranking above: that unanswered questions cost
more GMV than late operational edits. If it is the other way round, the product's centre of
gravity moves from the reply queue to the action rail, and the console's layout is wrong.

## 2. The first workflow

One workflow, end to end, before anything else is built:

> A buyer asks a question in live chat. The copilot classifies it, retrieves the grounding
> facts, drafts a **claim-structured** reply, runs every guardrail against **current** catalog
> state, and surfaces a card carrying the reply, its provenance and its verdict. Rae sends it
> with one keystroke. When the chat reveals an operational problem — sustained discount
> pressure, a sold-out lot, interest in a lot that is not on screen — the copilot proposes a
> **bounded, reversible action** with a visible preflight checklist. Rae approves it; it
> commits to the marketplace and to her catalog together, lands in a hash-chained audit log,
> and stays one keystroke from undo.

Two requirements that fall out of this and shape everything downstream:

- **No reply is sent that the system cannot justify.** Every factual statement cites a
  retrieved fact by id, and every cited fact is re-checked against live state before send.
- **No write is proposed that cannot be undone.** Prior state is captured at preflight and is
  the sole input to rollback.

## 3. What is deliberately not in v1

- **Voice replies.** Rae is already talking; a second voice is noise.
- **Auto-posting to chat by default.** Ships at L1 (suggest). Auto-send is a rung she climbs.
- **Multi-show or multi-seller.** One seller, one show, one catalog.
- **Sourcing, listing creation, fulfilment.** Adjacent, larger, and not where the live-show pain is.
- **Sentiment and viewer analytics.** Attractive to demo, no decision attached.

## 4. Success metrics

Measured per show, compared against the same seller's own baseline shows.

> **Implementation status.** Every metric below is computed in
> [`src/shows/prdMetrics.ts`](../src/shows/prdMetrics.ts), served live at
> `GET /api/show/prd`, and carried on the post-session report — with one
> exception, marked ✗, which is named here rather than faked.
>
> GMV is derived from recorded SALES, not inferred from listing state: an
> observed lot that goes `live → ended` is a lot the host just hammered, and the
> price it carried at that moment is written to the `sales` table. The listing
> row keeps moving afterwards, so a sum over current state would answer a
> different question every time it was asked.

**GMV**

| Metric | Baseline | Target | Why it is the right measure |
|---|---|---|---|
| Answered-question rate | ~35% | **> 85%** | ✓ The direct mechanism. An unanswered question is a buyer who was close. |
| Time-to-answer, p95 | 90 s+ | **< 10 s** | ✓ Past roughly a minute the buyer has scrolled; the answer no longer converts. |
| GMV per show hour | baseline | **+15%** | ✓ The outcome the seller actually cares about. Null below 15 minutes of show — a rate extrapolated from four minutes is noise wearing a decimal point. |
| Sell-through on lots with ≥1 answered question | baseline | **+20%** | ✓ Isolates the effect from general show variance. Joined through the evidence on a SENT reply, which names the listing it was grounded in. |

**Operator load**

| Metric | Baseline | Target | |
|---|---|---|---|
| Seller chat interactions per show | 60–120 | **< 25** | ✓ |
| Median seller decision time per proposal | — | **< 2 s** | ✓ Stamped when the seller first sends or dismisses; a proposal nobody touched is not a slow decision and is excluded. |
| Operational edits per show (markdowns, stock fixes, swaps) | 2–4, late | **8–12, within 60 s of the signal** | ~ Count is computed; "within 60 s of the signal" is not. |

**Trust** — the leading indicator for whether she climbs the ladder:

| Metric | Target | |
|---|---|---|
| Guardrail block rate | **< 5%** of drafts (higher means the grounding is bad, not that the guards are good) | ✓ |
| Wrong replies reaching a buyer | **0** | **✗ not self-measurable.** A reply this system judged correct is exactly the reply it cannot mark wrong. It needs a human reading sent replies against the catalog — which is what the pilot's weekly review is for. The nearest machine proxy, `sentThenContradicted` (a sent reply whose grounding listing later changed version), IS computed and is **not** the same thing. |
| Seller edit rate on sent drafts | **< 20%** | ✓ |
| Actions rolled back | **< 10%** (higher means preflight is too permissive) | ✓ |

**The anti-metric:** reply volume. A system optimising for replies sent would answer the hype,
and the admission gate exists to refuse exactly that. ~55% of live chat is reaction.

## 5. The copilot-to-automation ladder

A seller does not adopt automation because it is safe. She adopts it because she watched the
rung below behave for three shows. So autonomy is five explicit levels, each with a stated
promotion criterion she can check against her own numbers — implemented in
`src/autonomy/ladder.ts`, selected from the console's top bar.

| Rung | Behaviour | Promote when |
|---|---|---|
| **L0 Observe** | Classifies chat, proposes nothing. | You want a baseline of how much your show actually asks. |
| **L1 Suggest** | Drafts every reply; you send all of them. | Edit rate on drafts < 20% across 3 shows. |
| **L2 One-tap** | Drafts pre-approved for a single keystroke. | Guardrail block rate < 2% AND no blocked reply sent unedited, across 3 shows. |
| **L3 Auto-reply** | Replies in **allow-listed intents** that pass every guardrail and clear a 0.8 confidence floor send themselves. | Zero buyer corrections on auto-sent replies across 5 shows. |
| **L4 Auto-act** | **Bounded writes** — stock fixes and markdowns above your floor — execute themselves inside the undo window. | Rollback rate < 5% across 5 shows at L3. |

Two rules hold at every rung and are not configurable:

- **A guardrail `block` never auto-sends.** The ladder only ever acts on drafts the guards
  already allowed.
- **Auto-acting is restricted to action kinds whose preflight is fully decidable from catalog
  state.** `markdown_price` and `adjust_stock` qualify. `end_listing` and `swap_pinned` change
  what the show *is* and always need a human.

The L3 allow-list is `shipping, returns, sizing, authenticity, availability` — questions whose
answers are policy or a catalog field. **Price and discount are deliberately excluded at every
rung.** They move during a show and are where a wrong answer costs real money.

## 6. Pilot design

**Five sellers, four weeks.** Recruited from a single vertical — sneakers and streetwear — so
the catalog shape, the question mix and the policy surface are comparable. Each must already
run ≥2 shows a week, so a within-seller baseline exists.

- **Week 0 — baseline.** L0 Observe only. The copilot classifies and measures; it proposes
  nothing. Produces each seller's own answered-question rate, time-to-answer and GMV/hour. This
  week exists so improvement is measured against the seller, not against a cohort average.
- **Weeks 1–2 — L1/L2.** Suggest, then one-tap. Every send, edit and dismiss is logged with the
  guardrail verdict at send time. The primary readout is the **edit rate** — the seller's
  revealed opinion of draft quality, and a better signal than any satisfaction question.
- **Week 3 — L3 for sellers who qualify.** Only those meeting the L2 promotion criterion.
  Auto-sent replies are sampled and reviewed against the buyer's follow-up.
- **Week 4 — L4 for sellers who qualify.** Bounded auto-actions, undo window at 90 s.

**Instrumentation:** every proposal already carries its span breakdown, evidence set, guard
verdicts and confidence; every action and send is in the hash-chained audit log. The pilot
needs no additional telemetry, which is deliberate — the operator surface and the eval surface
are the same data.

**What would stop the pilot:** one wrong reply reaching a buyer at L3, or one unrecoverable
write at L4. Both drop the affected seller to L1 immediately.

**What success looks like:** at least 3 of 5 sellers reach L3 by week 4 and choose to stay
there, with answered-question rate above 85% and zero wrong replies delivered. Sellers
*choosing to stay* is the real metric — an autonomy level a seller turns off after one show has
failed regardless of what its accuracy numbers say.

## 7. How the build responded to what we learned

Three things changed during implementation, each because the evaluation harness contradicted an
assumption:

1. **The abstain path did not exist.** The design called for the copilot to decline when it had
   no grounding. The retrieval eval showed it never abstained — an unconditional
   "assume the pinned lot" fallback made every question resolve to something. Abstention is now
   driven by slot resolution failing. (`src/retrieval/slots.ts`, `docs/EVALS.md` §2)
2. **Similarity score is unusable as a confidence signal** on a catalog this small — grounded
   and ungrounded questions overlap almost completely on BM25 score. That killed a planned
   "confidence from retrieval score" feature and moved confidence onto guard outcomes.
3. **Cheap latency wins were not where they looked.** Capping output tokens at 220 changed p50
   by under 1%; the tail is the shared LLM pool. The win that mattered was the version-keyed
   cache (p50 1.2 s → 2 ms on repeats), which matters *because* live chat asks the same six
   questions over and over — a product fact, not an engineering one.


## 8. Implementation status against this document

Read on 2026-09-14 against the code, not the other way round. ✓ built and exercised,
~ partial and named, ✗ not built and named.

| PRD requirement | Status | Where, or why not |
|---|---|---|
| §2 buyer question → claim-structured reply → guardrails against **current** state → card with provenance → one-keystroke send | ✓ | `src/pipeline/pipeline.ts`, `src/guardrails/`; exercised live on a real eBay Live show: admitted → allowed → card in <14 s with 8 cited facts |
| §2 "no reply the system cannot justify" | ✓ (after a real hole) | Two listing facts were **synthesised** from defaults for every lot — "$9.95 Ground Advantage", "general-release pair, 30-day return" — and passed every guard because a claim cited them. Removed; a lot with no real shipping or authenticity data now yields no fact and the copilot abstains. Blocking precision 0.962 → 1.000 |
| §2 operational problem → bounded, reversible action → preflight → approve → commit → hash-chained audit → undo | ✓ | `src/actions/`; two-phase against `MockMarketplace` by default, real eBay Sell Inventory when a seller connects and arms the show |
| §3 one seller, one show, one catalog | ~ | The product also monitors and prepares **other** sellers' shows (read-only), added on request. The seller's own path is now first on Shows ("Your show") rather than behind a paste-a-URL box |
| §4 every metric computed per show | ✓ | `src/shows/prdMetrics.ts`, on every report; aggregated across shows on Analytics → Overview |
| §4 "wrong replies reaching a buyer" | ✗ by design | Not self-measurable; the operator's "wrong?" flag is the floor, and is counted |
| §4 "operational edits within 60 s of the signal" | ~ | Count computed; latency to signal not |
| §5 five-rung ladder, promotion criteria checkable against own numbers | ✓ | `src/autonomy/`; criteria rendered with progress on Analytics → Autonomy. L4 stays locked while writes hit a mock |
| §5 a `block` never auto-sends; price and discount never on the L3 allow-list | ✓ | `src/autonomy/ladder.ts` |
| §6 pilot instrumentation — span breakdown, evidence, guard verdicts on every proposal | ✓ | persisted in `reply_proposals`, readable per reply in the console inspector |
| Delivery of a sent reply to the marketplace chat | ✗ | eBay Live exposes no chat-post API. A "sent" reply is recorded and audited, not delivered; stated in the README |
| §2 the copilot **perceives** the show — host speech with emotion and intent, what the camera shows | ✓ | `src/api/audioBridge.ts` → `show_transcript`, `show_frames`, `show_audio`; distributions kept whole (`src/shows/signals.ts`) |
| §4 post-session report the seller reads and acts on | ✓ | Five sections — Did it help · What the host did · Can I trust it · What the agent concluded · Fix before the next show — plus Replies, Actions, Audit and a playable Timeline (`/api/shows/:id/record`, `/timeline`, `/export`) |
| §5 next actions carried into the next show | ✓ | Readiness returns the last report's gaps on the same catalog (`carried`); the agent's typed next actions sit on the report (`src/shows/conclusion.ts`) |
| §5 promotion argued from evidence by topic | ✓ | Analytics → Topics: asked / answered / abstained / blocked / edited per intent against the allow-list constant |
