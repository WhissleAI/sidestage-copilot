# SideStage — a live selling copilot

A real-time AI copilot for a **solo live-commerce seller**. It reads the buyer chat during a
live selling show, drafts replies grounded in the seller's catalog, listings and policies,
**enforces price, availability, policy and tone guardrails before anything is sent**, and
proposes bounded, reversible listing and inventory actions — markdowns, stock fixes, swapping
the lot on screen — each with a preflight checklist, a hash-chained audit entry and one-keystroke
undo.

Two repositories:

| | |
|---|---|
| **Backend (this repo)** | `WhissleAI/sidestage-copilot` — ingestion, grounding, guardrails, actions, audit, API |
| **Operator console** | `WhissleAI/live-commerce-copilot` — the React console the seller drives |

---

## Prerequisites

- Node 20+
- **Postgres 14+** running locally. `createdb sidestage` once; the server
  migrates and seeds the demo show on boot. Override with `DATABASE_URL`.

## PRD

**[`docs/PRD.md`](docs/PRD.md)** — the single user, the pain, the first workflow, the
copilot-to-automation ladder with its promotion criteria, a 3–5 seller pilot design, and the
GMV and operator-load metrics.

## Guardrails

**[`docs/GUARDRAILS.md`](docs/GUARDRAILS.md)** — what each of the six guards
checks, what it deliberately lets through, the two-layer split with the Whissle
agent, and the measured precision/recall. Read this to understand the pills on
every proposal card.

## Roadmap

**[`docs/ROADMAP.md`](docs/ROADMAP.md)** — what is missing and in what order,
including the Whissle platform asks and one finding worth the click: the audio
bridge already captures the show's video and discards it, while Whissle's hybrid
visual intelligence is sitting right there.

## Self-audit

**[`docs/REVIEW.md`](docs/REVIEW.md)** — an adversarial review of this system
against the brief, written after driving it on real eBay Live shows. 16 findings
with measured evidence, a clarity pass over the console, and a prioritised list
of Whissle platform gaps. Read it before the code: it says where this is weak
more precisely than the Known Limitations section below.

## TDD

**[`docs/TDD.md`](docs/TDD.md)** — streaming ingestion, catalog grounding, the two-layer
guardrail architecture, action auditability and rollback, the latency budget with measured
numbers, and the marketplace integration shape. Alternatives considered and rejected are
recorded per decision, as are the places the implementation diverges from this document.

## Prototype

Runnable locally. There is no hosted deployment — see **Known limitations**.

**It runs on real eBay Live shows.** Attach to a live stream, import the seller's
catalog, and the copilot answers real buyers grounded in real inventory while the live
lot's price moves under it:

```bash
npm run dev                                   # server on :8790
npm run ebay:shows                            # what is on air (best effort)
npm run demo:ebaylive -- <eventId|showUrl>    # attach + import catalog + ask real questions
```

See **[`docs/EBAY_LIVE.md`](docs/EBAY_LIVE.md)** for how that works, what is real, and
what its limits are.

### One thing to know before you test the write path

**Listing and inventory actions run against `MockMarketplace`, never a real
marketplace.** All five kinds are implemented, two-phase committed, hash-chain
audited and rollback-proven — against a simulator that injects latency, apply
failures and optimistic-concurrency conflicts so the rollback path is genuinely
exercised rather than theoretical.

They cannot run against a real one here for a structural reason, not an
unfinished one: a show you do not own is monitored **read-only**, because we
hold no seller credentials for someone else's stream. Preflight refuses every
write on such a show. So if you attach to a live eBay show and watch the ACTIONS
rail, you will correctly see *"0 pending · no action proposals"* — that is the
safety boundary working, not a broken feature.

**To exercise writes, use the seeded demo show** (`Friday Night Grails — Ep. 42`,
listed under "Open a show"). There the copilot owns the listings and will
propose markdowns, stock fixes and pinned-lot swaps, each with a preflight
checklist, an audit entry and one-keystroke undo:

```bash
npm run demo:stale-price   # the failure path: a markdown lands mid-draft and PriceGuard blocks the stale quote
```

The eBay Sell API adapter is a documented shape behind the existing
`MarketplaceAdapter` port, not a live integration.

```bash
# ── backend ──────────────────────────────────────────────────────────────────
git clone https://github.com/WhissleAI/sidestage-copilot && cd sidestage-copilot
npm install
cp .env.example .env          # add your WHISSLE_API_KEY (a wsk_ workspace secret key)

npm run seed                  # catalog, policies, market comps, past Q&A
npm run seed:agent            # creates the Whissle agent + pushes its guardrails,
                              # then prints the WHISSLE_AGENT_ID to put in .env
npm run dev                   # http://localhost:8790

# ── operator console ─────────────────────────────────────────────────────────
git clone https://github.com/WhissleAI/live-commerce-copilot && cd live-commerce-copilot
npm install
printf 'VITE_API_BASE=http://localhost:8790\nVITE_USE_MOCKS=false\n' > .env.local
npm run dev                   # http://localhost:3000
```

The backend starts a **simulated live show** immediately — scripted buyer chat at a realistic
mix (~55% reaction, which the admission gate filters) plus a scripted host transcript feeding
the rolling show context. Open the console and it fills with real, grounded, guarded proposals.

**Drive the core workflow:**

1. Watch a proposal card appear. Read the **provenance chips** — each is a `factId` that was
   actually retrieved — and the six **guardrail pills**.
2. Press `Enter` to send it, or `E` to edit it first.
3. Type a question into the chat composer at the bottom left (`can you do 340`,
   `size 10 still there`, `are the pandas legit`) and watch it go through the same path.
4. Approve the **markdown** action when it appears in the right rail, read its preflight
   checklist, then press `U` to roll it back. Open the audit log and press **Verify chain**.
5. `Cmd+K` for product research — comps, median, and where the listing sits against it.

**Everything is curl-able**, which is usually the fastest way to check a claim:

```bash
curl -s localhost:8790/health
curl -sN localhost:8790/api/stream                    # the SSE event stream
curl -s -X POST localhost:8790/api/chat/inject \
  -H 'content-type: application/json' \
  -d '{"author":"mia_k","text":"whats the lowest on the chicagos?"}'
curl -s localhost:8790/api/proposals | jq '.[-1]'     # grounding, guards, span breakdown
curl -s localhost:8790/api/audit/verify
```

### The failure path, on demand

```bash
npm run demo:stale-price
```

Forces the race this system exists for: a markdown lands in the window between a reply being
grounded and being sent. The draft is fluent, on-topic and cites a real fact — and quotes a
price that stopped being true four seconds ago. Watch `PriceGuard` catch it by listing version,
the repair pass re-ground, and both events land in the audit chain.

### Tests, evaluations and the benchmark

```bash
npm test     # 41 unit tests — actions, audit chain, ingest, cache, ladder, proposer
npm run eval # 6 evaluations — guardrail precision/recall, retrieval ablation
npm run bench -- 24   # latency: per-stage p50/p95/p99, cold vs cached
```

`npm test` and `npm run eval` need **no credentials** — every deterministic subsystem is
testable without a network. `npm run bench` and `npm run demo:stale-price` exercise the real
reply path and need the Whissle agent.

Results and methodology: **[`docs/EVALS.md`](docs/EVALS.md)**.

## Source code

This repository. Start here:

| Path | What it is |
|---|---|
| `src/pipeline/pipeline.ts` | **the core loop** — admit → classify → cache → retrieve → compose → guard → ladder |
| `src/retrieval/` | structured-first grounding: `facts.ts` (addressable facts), `slots.ts` (slot resolution), `bm25.ts`, `retriever.ts` (RRF fusion) |
| `src/guardrails/` | `policy.ts` (one configurable policy), `guards.ts` (the six deterministic guards), `chain.ts` |
| `src/actions/` | `preflight.ts`, `executor.ts` (two-phase commit + rollback), `audit.ts` (hash chain), `proposer.ts`, `marketplace/` |
| `src/llm/` | `whissle.ts` (the agent client), `agentSpec.ts` + `seedAgent.ts` (agent config, incl. its guardrails) |
| `src/autonomy/ladder.ts` | the five-rung copilot-to-automation ladder |
| `src/ingest/ebaylive/` | real eBay Live ingestion — `watcher.ts` (chat + lots), `discovery.ts` |
| `src/shows/` | `runtime.ts` (one isolated pipeline per show), `registry.ts`, `catalogImport.ts` |
| `src/llm/kbSync.ts` | pushes a show's catalog into the Whissle agent's knowledge base |
| `src/api/audioBridge.ts` | host-audio capture into a Whissle listen-only session |
| `src/latency/` | span instrumentation and the version-keyed reply cache |

## Access notes / credentials

The only credential is a **Whissle workspace secret key** (`wsk_…`), which is the sole LLM
provider. Put it in `.env` as `WHISSLE_API_KEY`; `npm run seed:agent` does the rest and prints
the `WHISSLE_AGENT_ID`.

Reviewers: a scoped key has been shared with the submission. If you do not have one,
`npm test` and `npm run eval` still run in full — they cover retrieval, all six guardrails,
two-phase commit, rollback, idempotency and the audit chain — and the recorded walkthrough
shows the live reply path.

Required scopes: `agent:read`, `agent:write`, `agent:chat`, `kb:write`.

## Known limitations or broken paths

Stated plainly, because these are the things a reviewer would otherwise find.

1. **The cold-path p95 misses the 2-second budget, sometimes.** Measured over three runs of 24
   questions: p50 **982–1220 ms** (stable), p95 **1950–3735 ms**, budget breaches **4–13%**.
   Roughly 99% of it is the single LLM hop, and the tail is the shared hosted pool queueing, not
   anything local — capping output tokens at 220 changed p50 by under 1%. The cached path is
   comfortably inside (p50 ~2 ms, p95 ~1.1 s). **The fix is token streaming to the console, which
   is specified in the frontend contract and not implemented in the backend** — proposals are
   emitted once, complete, rather than streaming. See `docs/TDD.md` §5.
2. **Marketplace writes go to `MockMarketplace`**, not a live eBay or Whatnot account. It is a
   real two-phase participant with injectable latency, injectable apply failures and genuine
   optimistic-concurrency conflicts — the rollback tests force all three — but it is not a
   network integration. The adapter interface is in `src/actions/marketplace/port.ts`.
3. **No neural embeddings.** The second retrieval leg is character-trigram cosine, not a
   learned embedding. `docs/EVALS.md` measures exactly what it buys (nothing on clean questions;
   it halves degradation on misspelled ones). An ONNX MiniLM is a drop-in at the same seam.
4. **Host audio needs one operator click.** The listen-only Whissle session mints correctly and
   transcripts feed the show context, but browsers require a user gesture to hand a page tab
   audio, so `/audio-bridge` is a page the seller opens and clicks once. It cannot be started
   from the backend — by us or anyone.
5. **eBay Live ingestion is a scrape, not an API.** eBay publishes no Live chat or lot API, so
   `src/ingest/ebaylive/watcher.ts` drives a headless browser over the show's own player DOM.
   Read-only by construction, but it is subject to selector drift on an eBay deploy and to
   eBay's terms on automated access. Full details and limits in
   [`docs/EBAY_LIVE.md`](docs/EBAY_LIVE.md).
6. **A monitored show's lineup must be imported.** eBay Live renders only the lot on the block;
   the full list needs sign-in. Without a catalog import the copilot honestly abstains on
   everything except the current lot.
7. **Chat replies are drafted, never delivered.** Nothing posts back to eBay or Twitch. Both
   live sources are read-only by construction with no send path — see `docs/TDD.md` §8 for why
   that is a deliberate boundary rather than an unfinished feature.
8. **No auth, no tenancy.** Shows are isolated per SQLite file, but anyone who can reach the
   port can drive every show. CORS is wide open, which is correct for a local operator tool and
   wrong for anything deployed.
9. **The `comparison` intent has no dedicated handler.** It retrieves and answers like any other
   question rather than running a structured spec diff, even though `ResearchService` can produce one.
