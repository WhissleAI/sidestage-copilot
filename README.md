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
  migrates on boot (`src/db/pg_migrations/`, 15 migrations, tracked in
  `schema_migrations`). Override with `DATABASE_URL`. The test suite uses its own
  database (`TEST_DATABASE_URL`, default `sidestage_test`), created by `scripts/ensure-test-db.mjs`.

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
of Whissle platform gaps, plus dated fix logs. Read it before the code: it says
where this is weak more precisely than the Known Limitations section below.

## TDD

**[`docs/TDD.md`](docs/TDD.md)** — streaming ingestion, catalog grounding, the two-layer
guardrail architecture, action auditability and rollback, tenancy, the latency budget with
measured numbers, and the marketplace integration. Alternatives considered and rejected are
recorded per decision, as are the places the implementation diverges from this document.

## Prototype

Runnable locally, and hosted — see **Deployed** below.

**It runs on real eBay Live shows.** Attach to a live stream, import the seller's
catalog, and the copilot answers real buyers grounded in real inventory while the live
lot's price moves under it:

```bash
npm run dev                                   # server on :8790
npm run ebay:shows                            # what is on air (needs the house session, see below)
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

`ebay` is the real Sell Inventory API (`src/actions/marketplace/ebay.ts`), and
arming it takes two deliberate steps: the seller connects their eBay account
(Settings → eBay, an OAuth consent they complete in a browser — no key can stand
in for it), and then the show is switched over with
`POST /api/shows/:id/write-target {"target":"ebay"}`. Connecting grants the
capability; it does not arm it, and arming refuses without a live token for the
show's owner. The choice is persisted on the show row, so a show that was
writing to eBay comes back writing to eBay after a restart, never quietly to the
mock. Two caveats the adapter does not paper over: eBay exposes no version on
an offer, so the optimistic lock is value-based (read at reserve, re-read at
apply, refuse if it moved) rather than version-based; and ending a listing
WITHDRAWS the offer rather than deleting it, because the undo window promises
reversibility and a deleted offer is not reversible. `push_listing` and
`swap_pinned` are about what is on screen in the show, which eBay Live exposes
no API for — on the eBay adapter they are local no-ops, recorded as such.

**Read this before expecting a real markdown to land.** A show attached from an
eBay Live link is read-only (`read_only` on the show row) unless the eBay
username behind the seller's consent matches the show's seller handle — the one
proof we accept that the account watching is the account selling. On anyone
else's show preflight refuses every write with *"show is yours to edit"*,
whatever its write target. So if you attach to a live eBay show and
watch the ACTIONS rail, you will correctly see *"0 pending · no action
proposals"* — that is the safety boundary working, not a broken feature. The
consequence, stated plainly: **no action has yet committed through the eBay
adapter on a live show.** The adapter is exercised by `test/ebay.test.ts` with an
injected fetcher (value-based conflict, withdraw-not-delete, no-connection
message), not by a seller's listing. REVIEW.md F-07 stays open.

**To exercise writes, use the seeded demo show** (`Friday Night Grails — Ep. 42`).
It is opt-in — start the server with `DEMO_SHOW=1` — because a fake show is the
worst possible empty state. There the copilot owns the listings and will propose
markdowns, stock fixes and pinned-lot swaps, each with a preflight checklist, an
audit entry and one-keystroke undo:

```bash
npm run demo:stale-price   # the failure path: a markdown lands mid-draft and PriceGuard blocks the stale quote
```

```bash
# ── backend ──────────────────────────────────────────────────────────────────
git clone https://github.com/WhissleAI/sidestage-copilot && cd sidestage-copilot
npm install
cp .env.example .env          # add your WHISSLE_API_KEY (a wsk_ workspace secret key)

npm run seed                  # catalog, policies, market comps, past Q&A
npm run seed:agent            # creates the Whissle agent + pushes its guardrails,
                              # then prints the WHISSLE_AGENT_ID to put in .env
DEMO_SHOW=1 npm run dev       # http://localhost:8790, with the scripted show on air

# ── operator console ─────────────────────────────────────────────────────────
git clone https://github.com/WhissleAI/live-commerce-copilot && cd live-commerce-copilot
npm install
printf 'VITE_API_BASE=http://localhost:8790\nVITE_USE_MOCKS=false\n' > .env.local
npm run dev                   # http://localhost:3000
```

With `DEMO_SHOW=1` the backend runs a **simulated live show** — scripted buyer chat at a
realistic mix (~55% reaction, which the admission gate filters) plus a scripted host
transcript feeding the rolling show context. Without it, nothing is watched until you attach
a show, and the console says so rather than animating. Register a seller account on the
landing page (or `POST /api/auth/register`), open the console and it fills with real,
grounded, guarded proposals.

**Drive the core workflow:**

1. Watch a proposal card appear. Read the **provenance chips** — each is a `factId` that was
   actually retrieved — and the six **guardrail pills**.
2. Press `Enter` to send it, or `E` to edit it first. An edited draft is re-guarded at send
   against the facts it was grounded in and the listings as they stand now; a block refuses the
   send with the reason (HTTP 409).
3. Type a question into the chat composer at the bottom left (`can you do 340`,
   `size 10 still there`, `are the pandas legit`) and watch it go through the same path.
4. Approve the **markdown** action when it appears in the right rail, read its preflight
   checklist, then press `U` to roll it back. Open the audit log and press **Verify chain**.
5. `⌘J` for product research — comps, median, and where the listing sits against it.
   (`⌘K` is the shell's command palette: navigation, actions, and a way to find a show.)

**Everything is curl-able**, which is usually the fastest way to check a claim. Every `/api/*`
route except the front door needs a session, so mint one first:

```bash
curl -s localhost:8790/health
TOKEN=$(curl -s -X POST localhost:8790/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"********"}' | jq -r .token)
curl -sN "localhost:8790/api/stream?token=$TOKEN"       # the SSE event stream
curl -s -X POST localhost:8790/api/chat/inject -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"author":"mia_k","text":"whats the lowest on the chicagos?"}'
curl -s localhost:8790/api/proposals -H "authorization: Bearer $TOKEN" | jq '.[-1]'   # grounding, guards, span breakdown
curl -s localhost:8790/api/audit/verify -H "authorization: Bearer $TOKEN"
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
npm test     # ~170 tests over test/*.test.ts (Node's test runner) — actions, audit chain, guardrails,
             # proposer, contract suite over the real routing table, tenancy, eBay client/adapter,
             # account-deletion signatures, session record, signals
npm run eval # 6 evaluations — guardrail precision/recall, retrieval ablation
npm run bench -- 24   # latency: per-stage p50/p95/p99, cold vs cached
```

`npm test` and `npm run eval` need **no LLM credentials** — every deterministic subsystem is
testable without a network — but they do need a local Postgres (`pretest` creates the test
database). `npm run bench` and `npm run demo:stale-price` exercise the real reply path and
need the Whissle agent.

Results and methodology: **[`docs/EVALS.md`](docs/EVALS.md)**.

## Source code

This repository. Start here:

| Path | What it is |
|---|---|
| `src/pipeline/pipeline.ts` | **the core loop** — admit → classify → cache → retrieve → compose (streamed) → guard → ladder; `send()` re-guards edits and refuses blocks |
| `src/retrieval/` | structured-first grounding: `facts.ts` (addressable facts), `slots.ts` (slot resolution), `bm25.ts`, `retriever.ts` (RRF fusion) |
| `src/guardrails/` | `policy.ts` (one configurable policy), `guards.ts` (the six deterministic guards), `chain.ts` |
| `src/actions/` | `preflight.ts`, `executor.ts` (two-phase commit, undo window, rollback, compensation), `audit.ts` (hash chain), `proposer.ts`, `marketplace/` (`port.ts`, `mock.ts`, `ebay.ts`) |
| `src/llm/` | `whissle.ts` (the agent client, JSON and streaming doors), `streamAgent.ts` (one agent per stream), `agentGc.ts` (retires finished shows' agents), `agentSpec.ts` + `seedAgent.ts` |
| `src/autonomy/` | `ladder.ts` (the five-rung copilot-to-automation ladder), `promotion.ts` (criteria from the seller's own reports) |
| `src/auth/accounts.ts` | register / login / logout / me; scrypt; bearer sessions |
| `src/api/` | `routes.ts` (auth, tenancy and seller-only preHandlers, every REST route), `hub.ts` (SSE fan-out, per-client show list), `audioBridge.ts` |
| `src/db/` | `pg.ts` (the pool, `tx()`), `pg_migrations/`, `seed.ts` |
| `src/ingest/ebaylive/` | real eBay Live ingestion — `watcher.ts` (chat + lots, real Chrome), `discovery.ts` (the live grid), `session.ts` (house session + proxy), `sellerListings.ts` |
| `src/ingest/ebay/` | the eBay Developer APIs — `client.ts` (Browse, Taxonomy, Marketplace Insights), `oauth.ts` (seller consent), `seal.ts` (tokens at rest), `deletion.ts` (account-deletion notices), `import.ts` |
| `src/shows/` | `runtime.ts` (one isolated pipeline per show, write target), `registry.ts`, `sessionRecord.ts` (what a show leaves behind), `signals.ts`, `catalogImport.ts`, `prepareEvent.ts`, `conclusion.ts`, `prdMetrics.ts`, `analytics.ts` |
| `src/sellers/following.ts` | followed sellers, and the poller that keeps the live grid warm |
| `src/llm/kbSync.ts` | pushes a show's catalog into the Whissle agent's knowledge base |
| `src/latency/` | span instrumentation and the version-keyed reply cache |

## Access notes / credentials

The LLM credential is a **Whissle workspace secret key** (`wsk_…`), the sole LLM provider.
Put it in `.env` as `WHISSLE_API_KEY`; `npm run seed:agent` does the rest and prints the
`WHISSLE_AGENT_ID`. Required scopes: `agent:read`, `agent:write`, `agent:chat`, `kb:write`.

eBay is optional and layered: an application keyset (`EBAY_APP_ID`, `EBAY_CERT_ID`,
`EBAY_DEV_ID`, `EBAY_ENV`) unlocks Browse and Taxonomy; a registered RuName (`EBAY_RUNAME`)
lets a seller consent to their own listings; `EBAY_TOKEN_KEY` seals those tokens at rest;
`EBAY_DELETION_VERIFICATION_TOKEN` + `EBAY_DELETION_ENDPOINT` answer eBay's account-deletion
challenge, which a production keyset requires. See `.env.example`.

**Reviewers.** The hosted prototype at https://sidestage.whissle.ai needs no credential of
yours: register with any email and a password, or use the shared reviewer account named in
the submission. The path that exercises the core loop, in order:

1. **Home → Discover** lists eBay Live shows on air right now (read through the house session;
   the badge says when the grid was last read). **Prepare agent** on one — the busiest is best —
   which builds the show's catalog and its own agent (about a minute), then **Monitor**, and the
   console opens on it. Preparing is mandatory: an attach without it answers 409. A show you do not own is monitored **read-only**: every buyer question
   is classified, grounded, drafted and guarded, and a reply is sent to the record and the
   audit chain rather than to eBay, which exposes no chat-post API either way.
2. In the **console**: J/K move the queue, Enter sends, E edits (an edited draft is re-guarded
   at send), X dismisses; the pills on each card are the six guards; the inspector (I) shows
   the facts a claim cites. ⌘J asks the research card a question about the lot on screen.
3. **End session** builds the report: answered rate, time to answer, blocked replies with the
   guard that blocked them, the audit chain, and the timeline of what was on screen.
4. **Settings → Dry run** puts any question through the same pipeline and guards against the
   catalog as it stands, without a show. **Analytics** and **Cost** roll finished shows up.

Locally, `DEMO_SHOW=1 npm run dev` runs the scripted show (deterministic, no eBay), and
`npm run demo:stale-price` forces the mid-show markdown that `PriceGuard` must catch. The
live reply path needs a Whissle workspace key (`WHISSLE_API_KEY`, `wsk_…`); `npm test` and
`npm run eval` do not — they cover retrieval, all six guardrails, two-phase commit, rollback,
idempotency, the audit chain, tenancy and the eBay adapter from fixtures.

## Accounts and tenancy

Every seller registers with an email and a password (`POST /api/auth/register`, `/login`,
`/logout`, `GET /api/auth/me`; scrypt, no native dependency; `sst_` bearer tokens, 30 days).
There is no guest kind any more (migration 015 ended every guest session): a visitor sees the
landing page, and every `/api/*` route except the front door, health, eBay's own callbacks
(`/api/ebay/callback`, `/api/ebay/account-deletion`) and the audio-bridge page answers
`401 sign in to use SideStage` without a session. The stream and the audio bridge carry the
session as a `token` query parameter because neither can set a header. Every non-GET route
additionally requires a seller account (a second preHandler answers 403), so a route added
later cannot be left open by omission.

**A show belongs to the account that attached it** (`owner_account_id`, set at attach). Any
route that names a show — path, query or body — answers **404** to anyone else, 404 rather
than 403 because another seller's show should not even be confirmed to exist. Lists are cut
to the caller: `/api/shows`, `/api/reports`, `/api/home`, `/api/cost`, analytics, catalogs, and
the SSE `shows` event is filtered per client in `src/api/hub.ts`. `/api/shows/prepared` is
deliberately workspace-wide: a preparation's agent and catalog are workspace resources.
Rows written before ownership existed have no owner and stay visible to everyone — that is
documented legacy, not a policy. Audit entries for a send, an approval or a rollback record
`seller:<handle>` rather than a literal "seller". Six contract tests in `test/tenancy.test.ts`
hold this boundary.

## Deployed

| | |
|---|---|
| Frontend | https://sidestage.whissle.ai (also https://sidestage-five.vercel.app; Vercel, TanStack Start on the Nitro `vercel` preset; `/privacy` and `/terms` are pages of the app) |
| Backend | https://35-173-35-240.sslip.io (one t3.small in us-east-1: Postgres 16 + app + a real Chrome, in Docker Compose behind Caddy, which issues the certificate for the sslip.io name) |
| eBay keyset | **production** (`EBAY_ENV=production`). It lacks the Marketplace Insights grant, so sold comps degrade to asking prices and every surface says so |
| eBay consent | `POST /api/ebay/connect` → eBay OAuth → `GET /api/ebay/callback`; the `state` is pinned to the account that asked. Access and refresh tokens are sealed with AES-256-GCM under `EBAY_TOKEN_KEY` before they reach Postgres (`src/ingest/ebay/seal.ts`); a process with no key stores plaintext and warns once |
| eBay account deletion | `GET/POST /api/ebay/account-deletion` answers eBay's Marketplace Account Deletion challenge and notices (`src/ingest/ebay/deletion.ts`) — eBay keeps a production keyset disabled until this exists. A notice is honoured only after its `x-ebay-signature` (ECDSA over the raw body, public key fetched from eBay's Notification API by key id) verifies; an unsigned or forged notice is acknowledged with 200 and ignored. Token in `EBAY_DELETION_VERIFICATION_TOKEN`; the registered URL in `EBAY_DELETION_ENDPOINT`, byte-for-byte |
| eBay redirect | RuName registered with accepted URL `…/api/ebay/callback` on the backend, declined URL `/settings` on the frontend, privacy `/privacy` |

`scripts/deploy-aws.sh up` creates the key pair, security group and instance and deploys;
`scripts/deploy-aws.sh deploy` rsyncs this checkout plus `.env` and `data/` and restarts the
stack. The sync excludes `data/shows`, `data/ebay-profile` and `fixtures/catalogs/ebay-*` —
the last because those catalogs are written **by the app** on the box when a show is prepared
or imported, and an earlier deploy with `--delete` wiped them and left `prepared_shows` rows
pointing at files that no longer existed.

**The eBay Live house session.** The live grid renders nothing to an anonymous visitor, so
discovery reads it through one signed-in session shared by every account on the host. It
travels as `data/ebay-session.json` (Playwright storage state), never as the Chrome profile —
macOS Chrome encrypts cookies with the Keychain and a Linux Chrome cannot read them. From a
datacenter IP eBay answers every first request with a JavaScript challenge
(`/splashui/challenge`); real Chrome passes it on its own, which is why the image installs
Google Chrome and never Playwright's headless shell, for the watcher and for discovery alike.
The watcher (a show's `player.html`) was confirmed working from the box this way. The signed-in
grid needs one more thing, and the first diagnosis of it was wrong. It was recorded here as
"eBay refuses the grid from a datacenter IP". Measured on 2026-09-14: a session that read 224
events from the laptop at 13:00 read zero from the box — and then zero from the laptop too,
headed or headless, proxied through a home connection or not — while the seller's own Chrome
showed 96 events. eBay's header on every one of those failing reads said "Sign in or register":
**eBay had ended the session** after seeing it from a second address, and the anonymous grid
(with its "technical issue" banner) is what a signed-out browser gets. Discovery reads that
header and reports `signed-out` rather than `blocked`; before the first read of a process it
reports `pending`, not a refusal. The durable setup follows from it: a fixed-IP residential or
ISP proxy in `EBAY_DISCOVERY_PROXY`, the sign-in done THROUGH it (`npm run ebay:signin` honours
the same variable, tick "Stay signed in"), the export shipped with `npm run ebay:export` and
`deploy`, and the server reading through the same address ever after — one session, one
address, kept warm by the discovery poller (`DISCOVERY_REFRESH_MIN`, default 5). The proxy
routes only the discovery browser, never the API client or the player attach. Attaching by
link, reports, analytics and the eBay consent flow all run deployed without it.

### The box, and what it can hold

One t3.small (2 GB) runs Postgres, the app, a real Chrome and Caddy. On
2026-09-18 that box wedged: every port accepted a TCP connection and nothing
ever answered, because it was paging 3.2 million reads every three hours and
no process could make progress. No OOM kill fired — swap absorbed the growth,
so nothing was killed, everything was starved. The cause was the discovery
browser: every five-minute poll left four defunct `[chrome]` entries behind,
because Node as PID 1 does not reap orphaned grandchildren and the persistent
path closed the context without closing the browser.

Three things hold it now: `init: true` gives the app container a PID 1 that
reaps, `closeAll` in `src/ingest/ebaylive/session.ts` closes the browser as
well as the context and logs a close that fails, and `mem_limit` on each
service means a leak in one can no longer starve the others — the app is
OOM-killed and restarted while Postgres and Caddy keep serving. Discovery's
Chrome also passes `--disable-dev-shm-usage` now, which the watcher always did.

## Known limitations or broken paths

Stated plainly, because these are the things a reviewer would otherwise find.

1. **The cold-path p95 misses the 2-second budget, sometimes.** Measured over three runs of 24
   questions: p50 **982–1220 ms** (stable), p95 **1950–3735 ms**, budget breaches **4–13%**.
   Roughly 99% of it is the single LLM hop, and the tail is the shared hosted pool queueing, not
   anything local — capping output tokens at 220 changed p50 by under 1%. The cached path is
   comfortably inside (p50 ~2 ms, p95 ~1.1 s). Token streaming to the console **is** implemented
   (`chatTurnStream` in `src/llm/whissle.ts`, `onPartial` in `src/pipeline/pipeline.ts`): the
   operator watches the draft form, but the guards judge the complete draft, so time-to-send is
   unchanged by design. Measured on 2026-09-15 on the hosted stack: proposals 0.5–1.5 s;
   product research 0.22–0.28 s; a **dry run on a cold path took 4.3 s**, over budget.
2. **Marketplace writes default to `MockMarketplace`, and no live action has committed through
   the eBay adapter yet.** Arming a show to eBay is real (consent, sealed tokens, write target
   persisted per show), but a show attached from a stream is read-only at attach and never
   cleared, so preflight refuses every write on it. The mock is a real two-phase participant
   with injectable latency, injectable apply failures and genuine optimistic-concurrency
   conflicts — the rollback tests force all three. The live adapter speaks the same port against
   the Sell Inventory API (`bulk_update_price_quantity` for price and quantity, `withdraw` /
   `publish` for end and its undo, 429/503 backoff, value-based lock), and `push_listing` /
   `swap_pinned` are no-ops on it. The undo window is enforced on rollback; a compensation
   that itself fails marks the action failed with a message naming the listing to check on eBay.
3. **L4 auto-act is a policy lock, not a code lock.** Settings refuse `L4_AUTO_ACT` as a
   starting rung, and the ladder only ever auto-commits `markdown_price` and `adjust_stock`
   after preflight. But `POST /api/autonomy` will move a show to L4 whatever its write target;
   the stated rule — L4 only while writes hit the mock — is not checked against the write target
   in code.
4. **No neural embeddings.** The second retrieval leg is character-trigram cosine, not a
   learned embedding. `docs/EVALS.md` measures exactly what it buys (nothing on clean questions;
   it halves degradation on misspelled ones). An ONNX MiniLM is a drop-in at the same seam.
5. **Host audio needs one operator click — and once it is on, the show is kept.** The listen-only
   Whissle session mints correctly and the bridge page publishes tab audio into it, but Chrome
   will not hand over tab audio without a person ticking "Share tab audio", so the copilot cannot
   start hearing a show by itself. With the bridge open, every finalised utterance is stored with
   its emotion and intent **distributions**, the frames the agent read are kept with their reading,
   and the audio is kept in ten-second Opus chunks under `data/shows/<showId>/` — all of it
   deleted with the show. The report's Timeline tab plays it back; nothing else reads the bytes.
   Chunk numbering is the server's (a bridge reopened mid-show used to overwrite the first
   minutes with its new chunk 0 — measured 2026-09-15), and each kept frame gets a fuller
   reading from the show's agent after the show (`src/shows/frameDescriber.ts`), which the
   timeline shows beside the utterance it was taken during. **The listen session used to end at five
   minutes** (measured the same day: ninety seconds of speech-level chunks after the last
   utterance, and the gateway's log showed `connect 17:40:31.577 … disconnect 17:45:31.563`,
   flush reason `task.on_pipeline_finished`). Cause: pipecat's `PipelineTask` cancels a pipeline
   that has seen none of its idle-timeout frames for 300 s, and a listen-only pipeline never
   emits the bot-speech or user-speech frames it watched. Fixed in the gateway
   (whissle_gateway_backend PR #1105: the listen-only task is keyed on transcription with a
   30-minute bound, the timeout logs its cause, and a listen session is recorded as a `calls`
   row with `to_number = listen`, so `/api/sessions/{room}` resolves and the report's platform
   summary can match it). This side keeps its own guard regardless: the backend flags loud
   audio with no transcript for 45 s (`listen` event), the console says so instead of showing a
   frozen last line, and the bridge mints a new session and republishes the same track, up to
   five times.
6. **eBay Live ingestion is a scrape, not an API — and discovery needs the house session.**
   eBay publishes no Live chat, lot or schedule API, so `src/ingest/ebaylive/` drives real
   Chrome over eBay's own pages: the watcher reads a show's public `player.html` (no sign-in),
   discovery reads the live grid, which renders **nothing** to an anonymous visitor (measured:
   zero event links at forty seconds, against 224 for a signed-in session). The session is a
   person's sign-in (`npm run ebay:signin`), exported as a cookie jar, read through the fixed-IP
   proxy described under Deployed, and refreshed on a schedule; Discover says `signed-out`,
   `pending`, `stale` or `blocked` rather than pretending nobody is on air. Subject to selector
   drift on an eBay deploy and to eBay's terms on automated access. **The watcher does not
   detect a show ending on its own**: a show ends when the seller detaches it (or the process
   stops); until then it keeps polling. Full details and limits in
   [`docs/EBAY_LIVE.md`](docs/EBAY_LIVE.md).
7. **A monitored show's lineup must be imported or prepared.** eBay Live renders only the lot on
   the block; the full list needs sign-in. Without a catalog the copilot honestly abstains on
   everything except the current lot.
8. **Chat replies are drafted, never delivered.** eBay Live exposes no chat-post API and the
   scrape has no send path by construction, so a "sent" reply is recorded and audited and the
   seller pastes it into the show's chat themselves. See `docs/TDD.md` §8 for why that is a
   deliberate boundary rather than an unfinished feature.
9. **Comparables prefer SOLD prices and fall back to asking — and production has only asking.**
   Marketplace Insights (completed sales, 90 days) is limited-release; the production keyset is
   not granted it, so the client narrows its scopes once (`invalid_scope`), sold lookups switch
   off with one sentence on the catalog surface, and comparables come from active listings
   through Browse, labelled as asking prices. The two are never averaged together: asking prices
   skew high, and a seller holding firm against a number they believe is a sale price is being
   misled. Market lookups are fetched in the background and served from cache, never on the
   request path: one sandbox Browse call measured 0.7–4.6 seconds against a 2-second budget.
10. **The eBay application unlocks the catalog, not the live stream.** Browse and Taxonomy need
    only an application key; the seller's own listings need their consent (`EBAY_RUNAME` plus an
    OAuth sign-in). eBay Live has no API in any tier, so discovery and the watcher stay a scrape.
    The scopes stored on a connection are the scopes **requested**, not what eBay granted.
11. **Preparing a show reads the seller's listings two ways, and says which.** One seller has
    three names: a display name on the Live card, a Live-page slug in the seller link, and the
    account username that actually keys their listings. Preparation resolves the username from
    the Live seller page, then tries the Browse API seller filter — which eBay silently drops
    for a seller it does not know, returning the whole market with a 200 and a warning in the
    body. That warning is treated as a failure, never as a result. The fallback reads the
    seller's public results page through the house session (skipping "Shop on eBay" filler and
    the seller's own "Live show link" placeholders), and the catalog records that it came from a
    page read rather than the API.
12. **A show ends on silence, not on eBay's say-so.** Sellers reuse event ids and the player
    page for a finished show reads as live the next week, so the watcher finishes a session
    after fifteen minutes with no chat, no viewer change and no lot (`END_SILENCE_MS`), writing
    the report as a detach would. A host who pauses the stream for longer than that gets a
    finished session and must re-attach.
13. **Prompt inputs are quoted and bounded, not sandboxed.** Buyer text, author names, host
    transcript and the camera reading go into the per-turn context as JSON-quoted, length-capped,
    control-stripped strings labelled "data, not instructions" (`quoted()` in
    `src/compose/prompts.ts`). That is a bound on injection, not a proof against it; the guards
    are the backstop.
14. **Reports before 2026-09-15 carry no drafted replies.** Proposals were meant to be persisted
    from the session-record work onward, but the INSERT never ran until it was fixed that day;
    chat, actions, audit, transcript, frames and audio for those shows are intact.
15. **The agent's conclusion is written, not measured.** At the end of a show the show's own agent
    is handed the report's numbers, the gaps, a sample of what the host said and what the camera
    showed, and asked for a summary, an outcome and typed next actions (`src/shows/conclusion.ts`).
    It can only cite that evidence, but it is still a model writing prose: read the counts first.
    The platform's own end-of-session summary is pulled beside it when the gateway produced one,
    matched by room and then by agent and time window — the report says which.
16. **Host distributions describe the seller's delivery, not sentiment.** The emotion and intent
    heads measure the host. Read as sentiment they say nothing; read as a trajectory of delivery
    — explaining, asking the room, driving the sale; calm, steady, high energy; rising or
    settling — they say how the seller worked the show. `src/ingest/hostStyle.ts` turns them
    into that: a style line in the reply context ("match that delivery, never a reason to make a
    claim"), a "How the host worked the show" section with a two-minute trajectory on the report,
    and a line in the agent's conclusion. "Excited 41%" is still 41% of the mass across every
    utterance, not "excited 41% of the time", and the head degrades on low-arousal states; both
    stay printed on the surface. Pace is estimated from word count over utterance timing when the
    gateway sends no `words_per_minute`, which it did not on 2026-09-15.
19. **What the host says is evidence.** An utterance from the last two minutes that shares a
    content word or a number with the question becomes a citable `host:` fact beside the catalog's
    (`src/retrieval/hostFacts.ts`; "10men" and "ten men" are normalised to meet). It carries no
    listing price and no version, so the price guard keeps its own rules; the reply says "the host
    just said". Until 2026-09-15 "10men slides?" was deferred while the transcript held the answer.
20. **Cost is per seller, on a shared key.** The backend holds one Whissle key, so the wallet is
    shared and its balance is not shown. A seller's Cost page sums their own shows: the wallet's
    movement while a show ran alone counts as that show's spend; a show that overlapped another is
    priced by its metered calls at the average cost per call learned from the shows that ran alone
    (`GET /api/cost`, `show_costs.account_id`). Every figure names its basis.
17. **One Whissle agent per stream, and the workspace caps agents at fifty.** A show's agent is
    retired a day after its report (`src/llm/agentGc.ts`, every six hours), a preparation nobody
    attached is dropped after two days, and hitting the cap triggers one retirement pass and one
    retry before the operator is told. Re-preparing a show retires the old agent. Fifty
    concurrent unfinished shows would still hit it.
18. **CORS is wide open.** Correct for a console on another origin talking to a bearer-token
    API; wrong the day cookies are involved.
