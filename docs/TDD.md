# SideStage — Technical Design

Every section states what was chosen, what was rejected, and the constraint that forced it.
Where the implementation diverges from this document it says so inline.

```
 chat source ─┐                       ┌── retrieve ──┐
              ├─ admit / classify ────┤              ├─ compose (claims+factIds) ─ guardrail chain ─┬─ allow  → suggest / auto-send
 host audio ──┘   gate + rate cap     └── show ctx ──┘        Whissle agent        deterministic    ├─ revise → ONE repair pass ─┘
  (listen-only)                             ▲                                                      └─ block  → needs you
                                            │
                        action proposer ─ preflight ─ approve ─ 2PC commit ─ audit (hash chain) ─ rollback
                                                                     │
                                                        MarketplaceAdapter (Mock | eBay/Shopify shape)
```

## 1. Streaming ingestion

`ChatSource` is a two-method port (`src/ingest/sources.ts`): emit `{author, text, externalId}`,
and stop. `SimulatedShowSource` replays a seeded script — the demo, the evals and the benchmark
all drive from it, which is why the numbers are comparable run to run. `TwitchChatSource` reads
a real public live chat over anonymous IRC-over-WebSocket, which is what demonstrates the
pipeline survives a real firehose rather than a tidy fixture.

**Admission runs before anything expensive.** Roughly 55% of live chat is reaction — `W`,
`LETS GOOO`, emotes. `src/ingest/classify.ts` classifies intent by cue matching and gates on it;
dropped messages still appear in the console ticker with the reason, they simply never become
proposals. A token bucket caps proposals per minute so a chat burst cannot outrun either the
LLM pool or the seller's attention.

- **Rejected: an LLM classifier.** It costs a network round trip *before* the round trip that
  drafts the reply, and a 2-second budget has room for exactly one. Live-commerce chat is
  unusually tractable — a small, stable question vocabulary — so cue matching gets most of the
  way at zero latency. Measured: the classifier is under 1 ms at p99.
- **Rejected: replying to everything and letting the seller filter.** That is the same
  attention problem the product exists to solve, relocated.
- **Fixed during the build:** questions without a question mark ("can you hold it til friday")
  were being classified as hype and silently dropped. `INTERROGATIVE` now admits a leading
  question word. Found by the benchmark hanging, not by a test — the test came after.

**Real eBay Live ingestion.** `EbayLiveWatcher` attaches to a live eBay Live show and reads its
buyer chat and current lot from the player DOM — eBay publishes no Live API. Each watched show is
a `ShowRuntime` with its own SQLite file, pipeline and audit chain. A lot's price moving on air
bumps the listing version, so the staleness guard and the version-keyed cache run against **real**
auction movement. Full design, verification and limits: [`EBAY_LIVE.md`](EBAY_LIVE.md).

**Host audio.** Show context comes from what the seller is *saying*, which the catalog cannot
supply: the catalog knows what the Chicago 1s are, not that she just explained the cracked
leather is factory-intended. `WhissleClient.startListenSession()` opens a Whissle **listen-only**
voice session — STT plus emotion metadata, no LLM, no TTS, the bot never speaks — and
`/audio-bridge` publishes captured tab audio into it. The `wsk_` key stays server-side; the
browser gets only a room token. **Constraint, not divergence:** browsers require an operator
gesture to release tab audio, so capture is a page the seller clicks, never something the backend
can start.

## 2. Catalog grounding

The load-bearing decision: **the model never receives "the catalog". It receives a numbered list
of individually addressable facts and must cite one per claim.**

`src/retrieval/facts.ts` decomposes each listing into seven facts with stable ids —
`listing:lst_aj1_chi_10#price`, `#availability`, `#authenticity`, and so on — plus one fact per
policy clause, per past Q&A entry, and a market-median fact per SKU. 81 facts for an 8-lot
catalog.

Three things this buys that free-text RAG cannot:

1. A guard can check a claim against **the exact fact it cites**, which is a decidable question.
2. A listing fact carries the **`version` it was read at**, so a stale read is *provable*, not
   suspected. This is the entire mechanism behind §4's signature guard.
3. The console renders provenance chips a human can actually verify.

### Retrieval: structured-first, then hybrid similarity

`src/retrieval/retriever.ts`. Slot resolution (`slots.ts`) maps the question to
`(listing, attribute, policy topic)`; resolved slots get a **deterministic field lookup**.
Whatever is left goes to two similarity legs — **BM25** and **character-trigram cosine** — fused
with **Reciprocal Rank Fusion** (k=60).

- **Rejected: pure vector search.** Buyer questions in commerce are overwhelmingly about a
  specific *attribute* of a specific *item*. The right answer is a field lookup, not the most
  similar paragraph, and a field lookup is exact, cheap and verifiable. Measured:
  structured-only reaches R@1 0.842 on its own; the similarity legs alone reach 0.526.
- **Rejected: a neural embedder.** It is the second leg's obvious implementation and a drop-in
  at the `Embedder` seam. It is not here because the trigram leg is measurably sufficient for
  what the second leg is *for* — typo tolerance (§ EVALS 3) — and adding a model dependency for
  a measured non-improvement is the wrong trade at this size. **This is a real limitation at
  larger catalogs**, where lexical recall degrades and paraphrase matters more.
- **Rejected: RRF over three legs including structured.** Structured hits are categorically
  different from similarity hits — they are *exact*, not *ranked* — so they are scored directly
  rather than fused, and ranked by whether they answer the **primary** resolved field.
- **Fixed during the build:** policy-led questions ("do i pay customs to the uk") ranked the
  listing's own shipping line above the governing clause. Fields in `POLICY_LED` now let the
  clause lead. R@1 0.737 → 0.842.

**Abstention** is driven by *slot resolution failing*, with a weak-BM25 backstop — **not** by a
similarity threshold, because measured over the labelled set ungrounded questions score BM25
2.6–5.7 and grounded ones 2.0–10.7. Those distributions overlap almost completely. A confidence
signal derived from retrieval score would have been noise presented as certainty.

### Grounding is re-read at guard time, not reused

Retrieval hands the composer a snapshot. The guards re-read `repo.listings()` **fresh**. The gap
between the two is the thing the system is built to catch.

## 3. The Whissle agent, and why it is omni-channel

Whissle is the only LLM provider. `POST /api/agents/{id}/chat/turn` routes to the gateway's
`services/text_turn.py::run_turn` — the **channel-agnostic brain**: the same prompt, knowledge
base, tools and dispositions the voice path runs. One agent serves buyer-chat text here, the
embed widget, and a voice session, and they cannot drift because there is one configuration.

Two doors, for two jobs (`src/llm/whissle.ts`):

- `chatTurn` → the production, billable door. Takes an optional per-turn **`context`** field,
  composed *under* the agent's persona and KB and never stored. That is where this app injects
  the retrieved facts and live show state.
- `utilityTurn` → `POST /api/bench/agent-turn`, the injected-`system` door, used only for the
  internal JSON-only show-context summariser, where the seller persona would fight a
  "return only JSON" instruction.

`new_conversation: true` on every reply turn: each buyer question is independent and a reply
must never inherit the previous buyer's thread.

**The split of responsibility is deliberate.** The agent carries **identity and policy** — the
persona, the voice guide, the never-say list, the tool-approval gate — so it travels across
channels. This app carries **state** — this lot, this price, this version, right now — injected
per turn. A knowledge base cannot be re-indexed fast enough to be trusted mid-show, so
`agentSpec.ts` uploads only *stable* facts to the KB and explicitly says prices and quantities
are not in that document.

## 4. Guardrails — two layers, one policy object

`src/guardrails/policy.ts` is one configurable object (`GUARDRAIL_POLICY_PATH` overrides it)
projected into **two enforcement points that cannot drift**:

### Layer A — in the Whissle agent (preventive, channel-portable, state-blind)

`npm run seed:agent` pushes `content_guardrails` onto the agent:
`{enabled, never_say[], on_violation, redact_pii}`. The gateway's `services/content_guard.py`
enforces it on the live reply in **both** `text_turn` and the voice `ContentGuardProcessor`, so
the identical rule holds on every channel — and it fires even when this app is not in the loop.
It also pushes `action_policy: {send_email: "approve", send_sms: "approve"}`, which makes the
gateway **hold** a sensitive tool call and raise an approve/discard affordance instead of firing
it — human-in-the-loop built into the platform rather than bolted on here.

Verified by read-back: `seed:agent` re-reads `/api/agents/{id}/guardrails` and prints what is
actually armed (15 never-say rules, PII redaction on), rather than what we hoped we sent.

What Layer A **cannot** do: know that the pinned lot's price changed four seconds ago.

### Layer B — in this app (detective, state-aware, deterministic)

Six guards in `src/guardrails/guards.ts`, run against **current** catalog state. All of them
run, always — even after one has blocked — so the operator sees the complete picture and the
eval can measure each guard's precision independently.

| Guard | What it decides |
|---|---|
| `price` | Every money amount traces to a fact **at the listing's current version**, or is the buyer's own number, or is a discount inside the floor and the cap. |
| `availability` | No claiming stock that is not there; stated counts match; "last one" only when quantity is literally 1. |
| `policy` | The never-say list, plus: a claim about a policy topic needs that clause in evidence. |
| `claim_grounding` | Every cited `factId` was actually in evidence (a fabricated citation **blocks**), and each claim is lexically connected to the fact it cites (weak support **revises**). |
| `tone` | Length, markdown, emoji, hype, profanity — from the seller's voice guide. |
| `pii` | No email, phone, card-like number or street address into public chat. |

**The asymmetry between the layers is the interesting part.** Rules marked `unlessCertified`
("100% authentic") are deliberately **not** pushed to the agent: the gateway's guard is a pure
string match with no catalog access, so pushing it there would blanket-block the phrase even on
a listing that genuinely carries a CheckCheck certificate. Those rules live only in Layer B,
where `listing.authenticated` and `certId` are in hand. Asserted in
`test/copilot.test.ts`.

**The signature check.** `priceGuard` compares the `listingVersion` on the cited fact against
the live listing's `version`. A markdown landing between grounding and send produces a reply
that is fluent, on-topic, cites a real fact, and is wrong. Nothing in the text gives it away —
only the version does. `npm run demo:stale-price` forces exactly that race.

- **Rejected: an LLM judge.** A guard that needs a model to decide is a second opinion, not a
  guardrail: it adds a network hop inside the budget, and it fails in correlated ways with the
  model it is checking.
- **Rejected: regex-only content filtering.** It cannot express "this price is stale", which is
  the failure that actually costs money.
- **Guards fail closed.** A guard that throws returns `block` (`chain.ts`). A crashing safety
  check that silently passes is worse than no check.
- **The repair pass is bounded to exactly one**, and only for `revise`. Unbounded repair is how
  a latency budget dies, and a draft that fails twice is a draft the seller should look at.

## 5. Latency budget

Target: **p95 < 2000 ms**, admit → rendered. Allocation:

| Stage | Budget | Measured p50 | Why |
|---|---|---|---|
| admit + classify | 120 ms | **< 1 ms** | local regex and token work |
| retrieve | 150 ms | **1 ms** | in-process index, no network |
| compose | 1400 ms | **~1200 ms** | the only network hop, and all of the variance |
| guard | 80 ms | **1 ms** | deterministic, no I/O |
| headroom | 250 ms | | |

Everything except `compose` is local **by design**: the only way to hold a sub-2s budget with a
remote LLM in the path is to spend nothing else on I/O.

**Measured, three runs of 24 questions** (`npm run bench -- 24`):

| | p50 | p95 | breaches |
|---|---|---|---|
| cold | 982–1220 ms | **1950–3735 ms** | 4–13% |
| cached | ~2 ms | ~1100 ms | 0% |

**The cold p95 misses the budget, and the reason is not local.** ~99% of total time is the
single LLM hop, and the tail is the shared hosted pool queueing: capping output tokens at 220
(from 400) moved p50 by under 1% while p95 swung from 1693 ms to 3733 ms between consecutive
runs. **Divergence from plan:** the intended fix is token streaming so the seller sees text
while it is generated — the frontend contract specifies a `drafting` status with a streaming
draft, and the backend does not implement it; proposals are emitted once, complete.

**The reply cache is the win that mattered.** Live chat asks the same six questions repeatedly,
and `src/latency/cache.ts` keys on normalised question terms **plus the version of every listing
the answer was grounded in**. So a markdown does not expire cached entries — it makes their keys
*unreachable*. There is no TTL race to lose. A reply that failed a guardrail is never cached,
because a blocked verdict is a decision about one moment's state.

- **Rejected: caching on question text alone with a TTL.** Any TTL long enough to help is long
  enough to serve a pre-markdown price.
- **Rejected: speculative pre-drafting of likely questions.** It multiplies LLM spend against a
  shared pool that is already the bottleneck.

## 6. Actions: auditability and rollback

A listing edit is a write to a system we do not own, so `MarketplaceAdapter`
(`src/actions/marketplace/port.ts`) is an explicit two-phase protocol, not `updateListing()`.

`src/actions/executor.ts`, ordered so every failure has a defined outcome:

1. **Idempotency** — a key of `(kind, listingId, version, params)`. A second Approve returns the
   first result; a double-tap cannot mark down twice.
2. **Reserve** — optimistic lock on `(listing, expectedVersion)`. If the remote moved, fail here,
   **before** anything changed.
3. **Apply** — the only step that mutates remote state. On failure: cancel the reservation, mark
   failed, audit. Nothing else moved.
4. **Record locally** — the listing mutation **and** the idempotency ledger row in **one SQLite
   transaction**. If this throws we hold a remote write with no local record, which is the
   genuinely dangerous state, so the remote write is immediately **compensated**.
5. **Confirm** — release the reservation once the result is durable locally.

**Rollback is first-class, not a retry.** Prior state is captured at **preflight** and is the
sole input to compensation. A rollback appends a *new* audit entry and moves the version
forward; it never rewinds history.

**Preflight runs before the action is shown**, and its checklist is rendered on the card — floor
price, discount cap, cost basis, non-negative stock, plausibility of the jump, per-show action
budget, write rate. An approval button with no visible constraints is how sellers learn not to
trust a copilot.

**The audit log** (`src/actions/audit.ts`) is append-only and **hash-chained**: each entry hashes
the previous hash with its own payload, so editing any historical row breaks every hash after it.
`verify()` reports the exact seq where the chain parts, and the console exposes it as a
**Verify chain** button. `test/actions.test.ts` tampers with a committed row and asserts detection.

`MockMarketplace` is a real two-phase participant with injectable latency, injectable apply
failures and genuine optimistic-concurrency conflicts. The rollback tests force all three — a
rollback path that is never exercised is a rollback path that does not work.

- **Rejected: write locally, sync to the marketplace later.** The seller's dashboard and the
  buyer's screen would disagree, which is the exact failure the guardrails exist to prevent.
- **Rejected: a generic undo stack.** Marketplace writes are not all invertible the same way;
  each action kind carries its own inverse derived from its own snapshot.

## 7. Marketplace integration

`MarketplaceAdapter` has six methods. A real eBay or Whatnot adapter differs in authentication
and rate limits, not in shape: eBay's Sell Inventory API is a natural fit for reserve/apply
(offer revision with a concurrency token), and both platforms rate-limit writes, which is what
the per-show action budget and per-minute write rate already model.

Comps for product research are seeded rows; a live implementation replaces `Repo.comps()` with a
sold-listings feed. The service itself is pure arithmetic over those rows — median, spread,
position against the floor — and runs in **single-digit milliseconds**, leaving the entire LLM
budget for the reply that quotes it.

## 8. Two boundaries that are deliberate, not unfinished

**Nothing posts back to a public chat.** `TwitchChatSource` has no send path by construction.
Auto-posting into a chat you do not own is outbound content published to strangers on the
seller's behalf, it trips platform spam detection, and it is against Twitch's and YouTube's
terms. On a channel the seller owns and authenticates, it is a legitimate copilot — and that
path authenticates as them and is opt-in.

**Price and discount are never auto-answered**, at any autonomy rung. They move during a show,
and they are where a wrong answer costs real money.

## 9. What I would do next, in order

1. **Token streaming end to end** — the honest fix for the cold-path p95, and the frontend
   already expects it.
2. **Wire the listen-only audio session to browser capture** — the show-context engine is built
   and consuming a script; this is the missing half.
3. **A real marketplace adapter** behind the existing port, to find out what the two-phase
   protocol looks like against an API that was not designed for it.
4. **Per-seller guardrail policy in the database** rather than a JSON file, so a pilot seller can
   tighten their own never-say list without a deploy.
5. **A neural embedder at the `Embedder` seam**, once a catalog is large enough that lexical
   recall degrades — measured, not assumed.
