# SideStage — Technical Design

Every section states what was chosen, what was rejected, and the constraint that forced it.
Where the implementation diverges from this document it says so inline, marked **Divergence**.
Last diffed against the code on 2026-09-15.

```
 chat source ─┐                       ┌── retrieve ──┐
              ├─ admit / classify ────┤              ├─ compose (claims+factIds, streamed) ─ guardrail chain ─┬─ allow  → suggest / auto-send
 host audio ──┘   gate + rate cap     └── show ctx ──┘        Whissle agent                  deterministic    ├─ revise → ONE repair pass ─┘
  (listen-only)                             ▲                                                                └─ block  → needs you
                                            │                                                  send ─ re-guard an edited draft ─ refuse a block
                        action proposer ─ preflight ─ approve ─ 2PC commit ─ audit (hash chain) ─ rollback (inside the undo window)
                                                                     │
                                                        MarketplaceAdapter (Mock | eBay Sell Inventory)
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
buyer chat and current lot from the player DOM — eBay publishes no Live API. It launches
**real Google Chrome** (`acquireBrowser` in `watcher.ts`: `channel: "chrome"`, falling back to
Playwright's bundled build only on a machine with none), because the bundled headless shell
crashed its renderer on every attach on the deployed box and eBay Live streams nothing to it.
One browser is shared across shows; `browser.on("disconnected")` drops the handle and the next
tick relaunches. Each watched show is a `ShowRuntime` with its own pipeline, retriever, executor
and audit chain, scoped in **one Postgres database** by `show_id` (see §6a). A lot's price
moving on air bumps the listing version, so the staleness guard and the version-keyed cache run
against **real** auction movement. **Known limit:** the watcher does not detect a show ending;
a session ends when the seller detaches it. Full design, verification and limits:
[`EBAY_LIVE.md`](EBAY_LIVE.md).

**Discovery needs a signed-in session, read through a fixed address.** The live grid renders
nothing to an anonymous visitor. `src/ingest/ebaylive/session.ts` holds one house session (a
person's sign-in, exported as Playwright storage state), opens it in real Chrome through
`EBAY_DISCOVERY_PROXY` — only the discovery browser, never the API client or the player attach
— and `src/sellers/following.ts` re-reads the grid every `DISCOVERY_REFRESH_MIN` minutes
(default 5) to keep it warm. A read that comes back with eBay's "Sign in or register" header is
reported as `signed-out`; a process that has not read yet reports `pending`; neither is
rendered as "nobody is on air".

**Host audio.** Show context comes from what the seller is *saying*, which the catalog cannot
supply: the catalog knows what the Chicago 1s are, not that she just explained the cracked
leather is factory-intended. `WhissleClient.startListenSession()` opens a Whissle **listen-only**
voice session — STT plus emotion metadata, no LLM, no TTS, the bot never speaks — and
`/audio-bridge` publishes captured tab audio into it. The `wsk_` key stays server-side; the
browser gets only a room token. **Constraint, not divergence:** browsers require an operator
gesture to release tab audio, so capture is a page the seller clicks, never something the backend
can start.

**What a show leaves behind** (`src/shows/sessionRecord.ts`, `signals.ts`): chat messages with
their admission verdict, every reply proposal with its guards and decision, actions, the audit
chain, the host transcript with emotion and intent distributions, the frames the agent read and
ten-second audio chunks — all in Postgres (media bytes on disk under `SHOW_MEDIA_DIR`), all
deleted with the show. **Divergence, historical:** the proposal INSERT did not run until
2026-09-15, so reports generated before that date carry no drafted replies.

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

**Product research on the reply path.** For `comparison` and market-price questions,
`researchEvidence()` in the pipeline calls `ResearchService` during retrieval and adds the comps
as evidence, deduped against what retrieval already found. Comps come from
`src/shows/catalogMarket.ts`: sold prices through Marketplace Insights where the keyset is
granted it, otherwise active listings through Browse labelled as asking — never averaged
together. Lookups run in the background and are served from cache; nothing on the reply path
waits on eBay. Measured on 2026-09-15 on the hosted stack: research answers in 0.22–0.28 s.

### Grounding is re-read at guard time, not reused

Retrieval hands the composer a snapshot. The guards re-read `repo.listings()` **fresh**. The gap
between the two is the thing the system is built to catch.

## 3. The Whissle agent, and why it is omni-channel

Whissle is the only LLM provider. `POST /api/agents/{id}/chat/turn` routes to the gateway's
`services/text_turn.py::run_turn` — the **channel-agnostic brain**: the same prompt, knowledge
base, tools and dispositions the voice path runs. One agent serves buyer-chat text here, the
embed widget, and a voice session, and they cannot drift because there is one configuration.

Three doors, for three jobs (`src/llm/whissle.ts`):

- `chatTurnStream` → `POST /api/agents/{id}/chat/turn/stream`, the production door the reply
  path uses. Wire contract `open` → (`delta` | `tool`)* → `done`, where `done` carries the
  byte-identical body the JSON door returns. Falls back to `chatTurn` on 404 from an older
  gateway.
- `chatTurn` → the JSON door. Takes an optional per-turn **`context`** field, composed *under*
  the agent's persona and KB and never stored. That is where this app injects the retrieved
  facts and live show state.
- `utilityTurn` → `POST /api/bench/agent-turn`, the injected-`system` door, used only for the
  internal JSON-only show-context summariser, where the seller persona would fight a
  "return only JSON" instruction.

`new_conversation: true` on every reply turn: each buyer question is independent and a reply
must never inherit the previous buyer's thread.

**One agent per stream** (`src/llm/streamAgent.ts`). Several shows sharing one agent meant
several shows writing their lots into one knowledge base — five dead show corpora on one agent,
each answerable with total confidence about lots that sold days ago. So a show owns its agent:
created at attach (or reused from a preparation), retired a day after the show's report by
`src/llm/agentGc.ts` (boot + every six hours; preparations nobody attached go after two days).
The workspace caps agents at fifty; hitting the cap runs one retirement pass and retries once
before the operator is told. Re-preparing an event retires its previous agent.

**The split of responsibility is deliberate.** The agent carries **identity and policy** — the
persona, the voice guide, the never-say list, the tool-approval gate — so it travels across
channels. This app carries **state** — this lot, this price, this version, right now — injected
per turn. A knowledge base cannot be re-indexed fast enough to be trusted mid-show, so
`agentSpec.ts` uploads only *stable* facts to the KB and explicitly says prices and quantities
are not in that document.

**Untrusted text into the prompt** is JSON-quoted, length-capped and control-stripped, and
labelled "data, not instructions" (`quoted()` in `src/compose/prompts.ts`). That bounds
injection; it does not sandbox it. The guards in §4 are the backstop.

## 4. Guardrails — two layers, one policy object

`src/guardrails/policy.ts` is one configurable object (`GUARDRAIL_POLICY_PATH` overrides it;
`/settings` edits it per seller) projected into **two enforcement points that cannot drift**:

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

**Guards at send.** Send is the last moment the guards can act, so they do
(`Pipeline.send()`). A proposal whose verdict is `block` cannot be sent whatever the client
asks — the console hides the button, but a keystroke or a curl is not the console — and the
refusal is `SendRefused`, answered as HTTP 409 with the reason. An **edited** draft is a new
draft: it is re-run through the whole chain against the facts the original was grounded in and
the listings as they stand now; a block refuses the send, a revise is recorded. The audit entry
carries `verdictAtSend` and `guardsAtSend`, so what was actually checked is what the record
says was checked.

- **Rejected: an LLM judge.** A guard that needs a model to decide is a second opinion, not a
  guardrail: it adds a network hop inside the budget, and it fails in correlated ways with the
  model it is checking.
- **Rejected: regex-only content filtering.** It cannot express "this price is stale", which is
  the failure that actually costs money.
- **Guards fail closed.** A guard that throws returns `block` (`chain.ts`). A crashing safety
  check that silently passes is worse than no check.
- **The repair pass is bounded to exactly one**, and only for `revise`. Unbounded repair is how
  a latency budget dies, and a draft that fails twice is a draft the seller should look at.
- **Divergence:** the policy object is armed **process-wide**. Attaching a show arms Layer B with
  that seller's settings, so with two sellers live at once the last to attach wins. Per-show
  policy is the next step.

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
runs.

**Streaming is implemented.** The gateway's streaming door shipped as
[gateway #1101](https://github.com/WhissleAI/whissle_gateway_backend/pull/1101) and the pipeline
consumes it: `composer.draft()` takes an `onPartial` callback, and every delta re-emits the
proposal on the SSE stream with `status: "drafting"` and the draft so far
(`src/pipeline/pipeline.ts`). Three properties held deliberately: the guards judge the
**complete** draft that `done` carries, never an accumulation of deltas; a stream that ends
without `done` is an error, not a reply; and a 404 falls back to the JSON door. Streaming
shortens time-to-first-token — measured first token at ~1.0 s on a reply completing in ~1.1 s —
and leaves time-to-send unchanged, which is the point: a partially generated reply has been
checked by nothing and must never be sendable. **Divergence from the budget above:** measured
on 2026-09-15 on the hosted stack, proposals arrive in 0.5–1.5 s, research in 0.22–0.28 s, and a
dry run on a cold path took 4.3 s — the cold path can still exceed 2 s.

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

Five action kinds: `markdown_price`, `adjust_stock`, `end_listing`, `swap_pinned`,
`push_listing`. `src/actions/executor.ts`, ordered so every failure has a defined outcome:

1. **Idempotency** — a key of `(kind, listingId, version, params)`, unique per show. A second
   Approve returns the first result; a double-tap cannot mark down twice. `propose()` returns
   the existing action for a repeated intent, so a restarted process cannot collide with rows
   already on disk.
2. **Reserve** — optimistic lock on `(listing, expectedVersion)`. If the remote moved, fail here,
   **before** anything changed.
3. **Apply** — the only step that mutates remote state. On failure: cancel the reservation, mark
   failed, audit. Nothing else moved.
4. **Record locally** — the listing mutation **and** the idempotency ledger row in **one Postgres
   transaction** (`tx()` in `src/db/pg.ts`; the repo is rebound to the transaction client). If
   this throws we hold a remote write with no local record, which is the genuinely dangerous
   state, so the remote write is immediately **compensated**. If the compensation itself fails,
   the two ARE out of step and the action fails loudly, naming the listing to check on eBay —
   that is the one state this design must never describe as handled.
5. **Confirm** — release the reservation once the result is durable locally.

**Rollback is first-class, not a retry.** Prior state is captured at **preflight** and is the
sole input to compensation. A rollback appends a *new* audit entry and moves the version
forward; it never rewinds history. **The undo window is enforced**: past `undoableUntil`
(`UNDO_WINDOW_S`, default 90; per-seller in settings, clamped 10–600), a rollback is refused
with the time the window closed — past it, undoing is a new decision and should be proposed as
one.

**Preflight runs before the action is shown**, and its checklist is rendered on the card —
ownership (a monitored stream refuses every write), floor price, discount cap, cost basis,
non-negative stock, plausibility of the jump, per-show action budget, write rate. An approval
button with no visible constraints is how sellers learn not to trust a copilot.

**The audit log** (`src/actions/audit.ts`) is append-only and **hash-chained**: each entry hashes
the previous hash with its own payload, so editing any historical row breaks every hash after it.
`detail` is stored as `text` holding the exact bytes hashed — `jsonb` normalises key order and
broke verification of untouched chains (migration 003). `verify()` reports the exact seq where
the chain parts, and the console exposes it as a **Verify chain** button. `test/actions.test.ts`
tampers with a committed row and asserts detection. A send, an approval or a rollback is
attributed to `seller:<handle>`, never a literal "seller".

`MockMarketplace` is a real two-phase participant with injectable latency, injectable apply
failures and genuine optimistic-concurrency conflicts. The rollback tests force all three — a
rollback path that is never exercised is a rollback path that does not work.

- **Rejected: write locally, sync to the marketplace later.** The seller's dashboard and the
  buyer's screen would disagree, which is the exact failure the guardrails exist to prevent.
- **Rejected: a generic undo stack.** Marketplace writes are not all invertible the same way;
  each action kind carries its own inverse derived from its own snapshot.

## 6a. Storage, tenancy and authorization

**One Postgres database** (`src/db/pg.ts`; migrations in `src/db/pg_migrations/`, tracked in
`schema_migrations`, run on boot). It replaced a SQLite-file-per-show store: accounts,
settings and cross-show analytics all want shared, multi-process state, and a show stays a
tenant boundary by scoping — `show_id` is a real column and `Repo` is constructed **with** a
show id, so a query cannot forget it — rather than by filesystem. Three bugs the move exposed
are in [`ROADMAP.md`](ROADMAP.md) §2.1.

**Accounts** (`src/auth/accounts.ts`): a seller registers with an email and a password (scrypt,
N=2¹⁴, parameters travel in the hash); sessions are `sst_` bearer tokens that expire in the
query, not in JavaScript. There is no guest kind any more; migration 015 ended every guest
session.

**Three hooks in `src/api/routes.ts`, in order:**

1. `onRequest` resolves the actor from `Authorization: Bearer` (or a `token` query parameter
   for the SSE stream and the audio bridge, which cannot set headers) and answers
   `401 sign in to use SideStage` on every path except `/health`, `/api/auth/register|login`,
   `/api/ebay/callback`, `/api/ebay/account-deletion` and `/audio-bridge`.
2. A `preHandler` reads the show id from path, query or body and answers **404** — not 403,
   because another seller's show should not be confirmed to exist — when the show has an owner
   who is not the caller. `owner_account_id` is set at attach; rows written before ownership
   existed have no owner and stay visible to everyone (documented legacy).
3. A second `preHandler` refuses every non-GET request without a seller account (403), so a
   route added later that forgets its own check is still not an open write.

Lists are cut to the caller — `/api/shows`, `/api/reports`, `/api/home`, `/api/cost`,
`/api/analytics*`, `/api/catalogs` (seeds are everyone's; imports and preparations are the
caller's) — and the SSE `shows` event is filtered per client in `src/api/hub.ts`. **Divergence,
deliberate:** `/api/shows/prepared` is workspace-wide, because a preparation's agent runs on the
workspace's Whissle key and its catalog sits in the shared directory. Six contract tests in
`test/tenancy.test.ts` hold the boundary.

**Secrets at rest.** eBay access and refresh tokens are sealed with AES-256-GCM under
`EBAY_TOKEN_KEY` (`src/ingest/ebay/seal.ts`); a row written before the key existed is still
readable; a process with no key stores plaintext and warns once. **Divergence:** the scopes
stored on a connection are the scopes *requested*, not what eBay granted.

**Inbound from eBay.** The Marketplace Account Deletion endpoint answers the challenge with
`sha256(code + token + endpointUrl)` and honours a notice only after `x-ebay-signature`
(ECDSA over the **raw** body, key fetched from eBay's Notification API by key id) verifies;
that route keeps its own content-type parser so the bytes signed are the bytes checked. A
forged notice is acknowledged with 200 and ignored, because eBay retries on anything else.

## 7. Marketplace integration

`MarketplaceAdapter` has six methods — `get`, `reserve`, `apply`, `confirm`, `cancel`,
`compensate` — and two implementations behind one port. Which one a show writes to is an
explicit per-show choice, persisted on the show row (`write_target`), armed by
`POST /api/shows/:id/write-target` and restored on restart, so a show that was writing to eBay
never quietly comes back writing to a mock.

**`EbayMarketplace`** (`src/actions/marketplace/ebay.ts`) is the Sell Inventory API behind the
same two-phase protocol:

- **Authentication** is the seller's own consent (`src/ingest/ebay/oauth.ts`): `sell.inventory`
  is the scope that matters; access tokens last two hours and are refreshed from the sealed
  refresh token when they age out. Arming refuses without a live token for the show's owner.
- **Reserve** reads the offer by SKU (`GET /sell/inventory/v1/offer?sku=`) and refuses with a
  `MarketplaceConflict` if eBay's price or quantity already differs from our row. **Apply**
  re-reads and refuses if the offer moved between the two reads. That is a **value-based** lock,
  because an offer carries no ETag and no revision — narrower than the mock's version lock (a
  change that lands and reverts between reads is invisible) and the strongest guarantee the API
  supports; the committed audit entry carries the `before` snapshot and the remote reading.
- **Writes:** `markdown_price` and `adjust_stock` go through
  `POST /sell/inventory/v1/bulk_update_price_quantity` (quantity is set on the inventory item
  and the offer together, or the offer keeps advertising stock the item no longer has).
  `end_listing` is `POST …/offer/{id}/withdraw`, never `deleteOffer`, because the undo window
  promises reversibility and a deleted offer is not reversible; compensation republishes.
  **`push_listing` and `swap_pinned` are local no-ops on eBay** — they are about what is on
  screen in the show, which eBay Live exposes no API for — and the executor records them as
  such.
- **Rate limits:** a 429 or 503 backs off (400 ms × 2ⁿ plus jitter) and retries twice before
  the action is marked failed. The per-show action budget and per-minute write rate in preflight
  model the same limit from our side.
- **Compensation** puts back exactly the price, quantity and published state captured at
  preflight; the executor's undo window (§6) governs when it may run.

**Divergence, and the honest status:** a show attached from an eBay Live stream is marked
`read_only` at attach and nothing clears it, so preflight refuses every write on it whatever its
write target — and the seeded demo show has no owner account, so it cannot be armed. The
adapter is therefore reachable in code and exercised by `test/ebay.test.ts` with an injected
fetcher (conflict on a moved remote, withdraw-not-delete, no-connection message), but **no
action has committed through it on a live show**. REVIEW.md F-07 remains open on that basis.

**Comparables** come from `src/shows/catalogMarket.ts` over `src/ingest/ebay/client.ts`: sold
prices from Marketplace Insights (`item_sales/search`) where the keyset is granted it; the
production keyset is not, so the client narrows its scopes once on `invalid_scope`, sold
lookups switch off with one sentence on the catalog surface, and comps are active listings
through Browse labelled as asking prices. The research service itself is pure arithmetic over
those rows — median, spread, position against the floor — and runs in **single-digit
milliseconds**, leaving the entire LLM budget for the reply that quotes it.

## 8. Two boundaries that are deliberate, not unfinished

**Nothing posts back to a public chat.** eBay Live exposes no chat-post API, the watcher is a
read of the player DOM with no send path, and `TwitchChatSource` has none by construction. A
"sent" reply is recorded and audited; the seller pastes it into the show's chat. Auto-posting
into a chat you do not own is outbound content published to strangers on the seller's behalf,
it trips platform spam detection, and it is against the platforms' terms. On a channel the
seller owns and authenticates, it would be a legitimate copilot — and that path would
authenticate as them and be opt-in.

**Price and discount are never auto-answered**, at any autonomy rung. They move during a show,
and they are where a wrong answer costs real money. **Divergence, stated:** L4 auto-act is
locked as a *starting* rung (settings clamp to L0–L3) and the ladder only ever auto-commits
`markdown_price` and `adjust_stock` after preflight, but `POST /api/autonomy` will set L4 on a
show whatever its write target — "L4 only against the mock" is a rule the seller keeps, not
one the code checks.

## 9. What I would do next, in order

1. **Per-show guardrail policy** rather than a process-wide one, so two sellers live at once
   each run under their own never-say list and discount cap.
2. **Clear `read_only` for a stream the connected eBay account provably owns**, so an armed
   show can commit a markdown through the eBay adapter on air — the first live exercise of the
   two-phase protocol against an API not designed for it (F-07).
3. **End-of-show detection in the watcher**, so a session closes and its agent retires without
   the seller remembering to detach.
4. **Evict finished proposals and action keys from memory** (F-12) and wire or delete
   `KbSync.scheduleSync` (F-11).
5. **A neural embedder at the `Embedder` seam**, once a catalog is large enough that lexical
   recall degrades — measured, not assumed.
