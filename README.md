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

**Where a write lands is a per-show choice, and the show says which.** Every
action runs the same two-phase protocol, hash-chain audit and undo window
through `MarketplaceAdapter`; what differs is the adapter behind it.

`mock` is the default for every show, including a seller's own. It is a
simulator that injects latency, apply failures and optimistic-concurrency
conflicts so the rollback path is genuinely exercised rather than theoretical.

`ebay` is the real Sell Inventory API, and arming it takes two deliberate steps:
the seller connects their eBay account (Settings → eBay, an OAuth consent they
complete in a browser — no key can stand in for it), and then the show is
switched over. Connecting grants the capability; it does not arm it. Two caveats
the adapter does not paper over: eBay exposes no version on an offer, so the
optimistic lock is value-based (read at reserve, re-read at apply, refuse if it
moved) rather than version-based; and ending a listing WITHDRAWS the offer
rather than deleting it, because the undo window promises reversibility and a
deleted offer is not reversible.

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

## Accounts

Every seller registers with an email and a password (`POST /api/auth/register`, `/login`,
`/logout`; scrypt, no native dependency). There is no guest door any more: a visitor sees the
landing page, and every `/api/*` route except the front door, health and eBay's own callbacks
answers `401 sign in to use SideStage` without a session. The stream and the audio bridge
carry the session as a `token` query parameter because neither can set a header.

## Deployed

| | |
|---|---|
| Frontend | https://sidestage.whissle.ai (also https://sidestage-five.vercel.app; Vercel, TanStack Start on the Nitro `vercel` preset; `/privacy` and `/terms` are pages of the app) |
| Backend | https://35-173-35-240.sslip.io (one t3.small in us-east-1: Postgres + app + a real Chrome, in Docker Compose behind Caddy, which issues the certificate for the sslip.io name) |
| eBay account deletion | `GET/POST /api/ebay/account-deletion` answers eBay's Marketplace Account Deletion challenge and notices (`src/ingest/ebay/deletion.ts`) — eBay keeps a **production** keyset disabled until this exists. Token in `EBAY_DELETION_VERIFICATION_TOKEN`; the registered URL in `EBAY_DELETION_ENDPOINT`, byte-for-byte |
| eBay redirect | RuName registered with accepted URL `…/api/ebay/callback` on the backend, declined URL `/settings` on the frontend, privacy `/privacy` |

`scripts/deploy-aws.sh up` creates the key pair, security group and instance and deploys;
`scripts/deploy-aws.sh deploy` rsyncs this checkout plus `.env` and `data/` and restarts the
stack. The eBay Live session travels as `data/ebay-session.json` (Playwright storage state),
never as the Chrome profile — macOS Chrome encrypts cookies with the Keychain and a Linux Chrome
cannot read them. Sign in locally with `npm run ebay:signin`, export the jar with `npm run ebay:export`,
then `deploy` again. From a datacenter IP eBay answers every first request with a JavaScript
challenge (`/splashui/challenge`); real Chrome passes it on its own, which is why the image
installs Chrome and never Playwright's headless shell. The watcher (a show's `player.html`) was
confirmed working from the box this way. The signed-in live grid needs one more thing, and the
first diagnosis of it was wrong. It was recorded here as "eBay refuses the grid from a datacenter
IP". Measured on 2026-09-14: a session that read 224 events from the laptop at 13:00 read zero
from the box — and then zero from the laptop too, headed or headless, proxied through a home
connection or not — while the seller's own Chrome showed 96 events. eBay's header on every one of
those failing reads said "Sign in or register": **eBay had ended the session** after seeing it
from a second address, and the anonymous grid (with its "technical issue" banner) is what a
signed-out browser gets. Discovery now reads that header and reports `signed-out` rather than
`blocked`. The durable setup for a hosted copilot follows from it: a fixed-IP residential or ISP
proxy in `EBAY_DISCOVERY_PROXY`, the sign-in done THROUGH it (`npm run ebay:signin` honours the
same variable, tick "Stay signed in"), the export shipped, and the server reading through the
same address ever after — one session, one address, kept warm by the periodic discovery read.
The grid is the same for every seller, so one such session serves every account on the host.
Attaching by link, reports, analytics and the eBay consent flow all run deployed without it.

## Known limitations or broken paths

Stated plainly, because these are the things a reviewer would otherwise find.

1. **The cold-path p95 misses the 2-second budget, sometimes.** Measured over three runs of 24
   questions: p50 **982–1220 ms** (stable), p95 **1950–3735 ms**, budget breaches **4–13%**.
   Roughly 99% of it is the single LLM hop, and the tail is the shared hosted pool queueing, not
   anything local — capping output tokens at 220 changed p50 by under 1%. The cached path is
   comfortably inside (p50 ~2 ms, p95 ~1.1 s). **The fix is token streaming to the console, which
   is specified in the frontend contract and not implemented in the backend** — proposals are
   emitted once, complete, rather than streaming. See `docs/TDD.md` §5.
2. **Marketplace writes default to `MockMarketplace`**, and reach real eBay listings only when a
   seller connects their account and switches a show to it. The mock is a real two-phase
   participant with injectable latency, injectable apply failures and genuine
   optimistic-concurrency conflicts — the rollback tests force all three. The live adapter
   (`src/actions/marketplace/ebay.ts`) speaks the same port against the Sell Inventory API; its
   optimistic lock is value-based because eBay publishes no offer version, which is a narrower
   guarantee than the mock's and is documented as such in the file.
3. **No neural embeddings.** The second retrieval leg is character-trigram cosine, not a
   learned embedding. `docs/EVALS.md` measures exactly what it buys (nothing on clean questions;
   it halves degradation on misspelled ones). An ONNX MiniLM is a drop-in at the same seam.
4. **Host audio needs one operator click — and once it is on, the show is kept.** The listen-only
   Whissle session mints correctly and the bridge page publishes tab audio into it, but Chrome
   will not hand over tab audio without a person ticking "Share tab audio", so the copilot cannot
   start hearing a show by itself. With the bridge open, every finalised utterance is stored with
   its emotion and intent **distributions**, the frames the agent read are kept with their reading,
   and the audio is kept in ten-second Opus chunks under `data/shows/<showId>/` — all of it
   deleted with the show. The report's Timeline tab plays it back; nothing else reads the bytes.

5. **eBay Live ingestion is a scrape, not an API — and discovery needs a signed-in session.**
   eBay publishes no Live chat, lot or schedule API, so `src/ingest/ebaylive/` drives a browser
   over eBay's own pages. The live grid and a seller's schedule render **nothing** to an
   anonymous visitor (measured: zero event links at forty seconds, against 224 for a signed-in
   session), so `npm run ebay:signin` opens a window where the operator signs in once; the
   browser profile persists under `data/` (gitignored) and discovery drives it directly. One
   process at a time can hold that profile, so sign in with the server stopped. It must
   be **real Chrome in new-headless mode** — eBay blocks Playwright's bundled headless shell on
   the same profile. Subject to selector drift on an eBay deploy and to eBay's terms on
   automated access. Full details and limits in [`docs/EBAY_LIVE.md`](docs/EBAY_LIVE.md).
6. **A monitored show's lineup must be imported.** eBay Live renders only the lot on the block;
   the full list needs sign-in. Without a catalog import the copilot honestly abstains on
   everything except the current lot.
7. **Chat replies are drafted, never delivered.** Nothing posts back to eBay or Twitch. Both
   live sources are read-only by construction with no send path — see `docs/TDD.md` §8 for why
   that is a deliberate boundary rather than an unfinished feature.
8. **Comparables prefer SOLD prices and fall back to asking.** Marketplace Insights (completed
   sales, 90 days) is used where it answers; where it does not — sandbox carries no sales history
   at all — the comparables come from active listings through Browse and every surface labels
   them as asking prices. The two are never averaged together: asking prices skew high, and a
   seller holding firm against a number they believe is a sale price is being misled. Market
   lookups are fetched in the background and served from cache, never on the request path: one
   sandbox Browse call measured 0.7–4.6 seconds against a 2-second end-to-end budget.
9. **The eBay application unlocks the catalog, not the live stream.** Browse and Taxonomy need
   only an application key; the seller's own listings need their consent (`EBAY_RUNAME` plus an
   OAuth sign-in). eBay Live has no API in any tier, so discovery and the watcher stay a scrape.
10. **Preparing a show reads the seller's listings two ways, and says which.** One seller has
    three names: a display name on the Live card ("GoldStandardAuction"), a Live-page slug in the
    seller link ("q_EImPfySam"), and the account username ("gold_standard_guy") that actually keys
    their listings. Preparation resolves the username from the Live seller page, then tries the
    Browse API seller filter — which a **sandbox** key rejects for every real seller, and which
    eBay then silently drops while returning the whole market with a 200 and a warning in the
    body. That warning is treated as a failure, never as a result. The fallback reads the
    seller's public results page through the signed-in profile (skipping "Shop on eBay" filler
    and the seller's own "Live show link" placeholders), and the catalog records that it came
    from a page read rather than the API.
11. **The agent's conclusion is written, not measured.** At the end of a show the show's own agent
    is handed the report's numbers, the gaps, a sample of what the host said and what the camera
    showed, and asked for a summary, an outcome and typed next actions (`src/shows/conclusion.ts`).
    It can only cite that evidence, but it is still a model writing prose: read the counts first.
    The platform's own end-of-session summary is pulled beside it when the gateway produced one,
    matched by room and then by agent and time window — the report says which.

12. **Host distributions are probability mass, and the head is honest about arousal.** "Excited
    41%" on the report is 41% of the mass across every utterance, not "excited 41% of the time",
    and the gateway's own note says the emotion head degrades on low-arousal states. Both are
    printed on the surface rather than smoothed away.

8. **No auth, no tenancy.** Shows are isolated per SQLite file, but anyone who can reach the
   port can drive every show. CORS is wide open, which is correct for a local operator tool and
   wrong for anything deployed.
9. **The `comparison` intent has no dedicated handler.** It retrieves and answers like any other
   question rather than running a structured spec diff, even though `ResearchService` can produce one.
