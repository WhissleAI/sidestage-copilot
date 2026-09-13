# SideStage — self-audit

A review of this system against the SideStage brief, written after driving it
against real eBay Live shows rather than by re-reading the code. Every finding
carries the evidence that produced it; where a number appears, it was measured on
a running instance, not estimated.

Four lenses, deliberately adversarial:

| Lens | Asks |
|---|---|
| **Reliability (eBay CTO)** | What breaks at ten shows, at hour three, when a dependency dies? |
| **Architecture (Google CTO)** | Is the data model honest? Are failures defined? Is anything load-bearing that shouldn't be? |
| **Risk (CXO)** | What could embarrass us — legally, contractually, in front of a buyer? |
| **Clarity (CPO)** | Does the operator understand what they are looking at in one glance? What is redundant? |

Severity: **P0** ships broken · **P1** ships embarrassing · **P2** ships imperfect.

---

## 1. Conformance to the brief

| Required | Status | Evidence |
|---|---|---|
| Ingests a live chat stream | **Yes** | Real eBay Live chat, deduped by eBay's per-comment UUID |
| Grounds replies in catalog, listing, policy data | **Yes** | Structured-first retrieval, hybrid R@1 0.842 / MRR 0.898 |
| Enforces price, availability, policy, tone guardrails before send | **Yes** | Six deterministic guards, 1.00 precision and recall over 46 labelled cases |
| Listing/inventory actions: push, swap, markdown, stock | **Partial** | All five kinds implemented with 2PC + rollback, but **never exercised on a real show** — see F-07 |
| On-demand product research | **Partial** | Works, single-digit ms — but it is **only reachable from the command palette**; the reply path never calls it. F-08 |
| Sub-2s reply latency | **Partial** | p50 982–1220 ms; p95 1950–3735 ms, 4–13% breaches |
| Depth in ≥1 area | **Three** | Retrieval, agentic-write safety, latency |
| PRD / TDD diffed against implementation | **Yes** | Divergences stated inline; this document extends that |

The two partials are honest gaps, not near-misses, and both are in the brief's
mandatory list. They are the first things a reviewer will probe.

---

## 2. P0 — ships broken

### F-01 · The audit chain is 99.5% ingestion noise

**Measured on one show:**

```
kinds  { action_committed: 199, reply_sent: 1 }
actors { system: 199, seller: 1 }
sample  action_committed | lot updated: #457 - SUNDAY - 9/13/26- MLB $.99 Starts
        action_committed | lot updated: #457 - SUNDAY - 9/13/26- MLB $.99 Starts
        action_committed | lot updated: #457 - SUNDAY - 9/13/26- MLB $.99 Starts
```

The hash-chained audit log exists for **write accountability** — who changed what,
when, and can it be undone. `src/shows/runtime.ts` writes an `action_committed`
entry every time the watcher observes the live lot's price move. Those are not
actions we took. They are observations.

Three separate failures in one bug:

1. **Semantic.** `action_committed` by actor `system` for something nobody
   committed. The vocabulary now lies.
2. **Clarity.** The operator's audit panel is a wall of identical green lines.
   The one entry that matters — a reply sent to a buyer — is buried under 199.
   This is visible in every screenshot of the console.
3. **Dilution of the strongest claim.** "Verify chain" is the most defensible
   thing in the submission. Verifying a chain of ingestion telemetry proves
   nothing worth proving.

**Fix:** ingestion observations are not audit events. Emit them as `listing`
stream events only, which the console already renders in the show rail. If a
record of lot movement is wanted, it belongs in a separate `observations` table
with no hash chain. Reserve the chain for: reply sent, reply blocked, action
proposed/committed/failed/rolled back, autonomy changed.

### F-02 · Every bodyless POST from the console returned 400 *(fixed, kept for the record)*

```
no body, no content-type header   → HTTP 200
empty body + application/json     → HTTP 400   ← what the console sent
```

`regenerate`, `dismiss`, `approve`, `reject`, `rollback`, `detach` and `activate`
all failed silently. The buttons did nothing and said nothing, because the client
threw away the response body and reported a bare status code.

This is the highest-severity class of bug in the whole system and it survived
because **nothing tested the console against the server** — the backend has 47
tests, the integration between them had zero. Fixed on both sides (client sends
no header without a body; server tolerates an empty JSON body), but the
underlying gap remains: see F-06.

### F-03 · If Chromium dies, every watched show stops silently

`src/ingest/ebaylive/watcher.ts` shares one browser across all shows and holds no
handler for its death. If the process crashes or is OOM-killed, every `scrape()`
throws, `onStatus` reports `connected: false` once per second, and nothing ever
recovers. The console shows a stale show that looks alive.

**Fix:** listen for `browser.on("disconnected")`, drop the shared handle, and let
the next tick re-acquire. The watchdog added for dead chat sockets (F-13) is the
right shape; this is the same idea one level down.

---

## 3. P1 — ships embarrassing

### F-04 · 113 KB on every console connect, most of it dead

```
hello frame: 113,511 bytes
  audit    200 entries, 199 of them lot-update noise (F-01)
  listings 43, of which 24 are observed lots — 23 sold out and never returning
```

A reviewer opening the console on a hotel network waits for 113 KB of mostly
garbage. Fixing F-01 removes most of it; the rest is F-05.

### F-05 · Sold-out observed lots are carried forever

24 observed lots, 23 of them `qty: 0`, permanently. They appear in the `hello`
payload, in the `catalog:lineup` fact the model reads, and in the knowledge-base
document uploaded to the Whissle agent. A show that runs for three hours
accumulates hundreds.

They are already excluded from inventory *search* (a fix made earlier), which is
the tell that they should not be in the lineup fact either. An ended lot is
history, not inventory.

**Fix:** mark an observed lot `ended` once it is sold out and the pinned lot has
moved on; exclude ended lots from `hello`, the lineup fact and the KB. Keep them
in the database — they are the show's history and the research service will want
them.

### F-06 · No test crosses the client/server boundary

47 backend tests, 6 evaluations, and not one of them issues an HTTP request the
way the console does. F-02 is the direct consequence. The guardrail and retrieval
suites are genuinely good; the seam they do not cover is the one that broke.

**Fix:** a small contract suite that boots the server, drives each REST route the
way the browser does (including the header the browser sends), and asserts the
SSE envelope shapes. Perhaps twenty tests. It would have caught F-02 in seconds.

### F-07 · The write path has never run against a real show

Every action kind is implemented, tested, two-phase committed and rollback-proven
— against `MockMarketplace`. On a monitored eBay show the copilot is read-only by
design (no seller credentials), so **the entire agentic-write spike is exercised
only by the simulated show**. That is defensible and it is documented, but the
brief lists inventory actions as mandatory, and a reviewer testing on a real
stream will never see one fire.

**Fix, in order of honesty:** (a) say this plainly in the README's core-workflow
section rather than leaving it to Known Limitations; (b) make the demo show's
action rail the scripted part of the walkthrough; (c) if a seller account is ever
available, wire the eBay Sell API behind the existing `MarketplaceAdapter` port.

### F-08 · Product research is orphaned

`ResearchService` is real, correct, fast (single-digit ms) and **never called by
the reply path**. It is reachable only from `Cmd+K`. So a buyer asking "is that a
good price?" gets an answer grounded in the listing, not in the comps the system
already has.

The brief asks for "on-demand product research with a sub-2-second reply-latency
target" — which we meet for the palette and miss entirely for the thing that
matters, the reply.

**Fix:** when the resolved intent is `comparison` or `market`, call
`ResearchService` during retrieval and add the comps as evidence. It costs
milliseconds and it is already grounded and guard-checkable.

### F-09 · `comparison` intent has no handler

Classified, counted, then treated like any other question. Same root cause as
F-08 and the same fix.

### F-10 · The show's real name is never used

```
title: 'eBay Live gmqxTwJPXDeKbGRE'
```

`onTitle` reads the page title on attach and writes it to the show row, and it is
not taking effect — the console header shows an event id to an operator who is
watching "Sunday Baseball Marathon! MLB Singles w/ Jacob". Small, but it is the
first thing on screen and it reads as unfinished.

### F-11 · `KbSync.scheduleSync` is dead code

Written, documented, debounced — never called. The knowledge base only syncs on
attach and on explicit catalog apply, so a lineup that grows during a show never
reaches the agent. Either wire it to the lot-observed path or delete it; carrying
a documented method that nothing calls is worse than either.

### F-12 · Unbounded in-memory growth

`Pipeline.proposals` is a `Map` that is never evicted; `seenActionKeys` likewise.
A busy eight-hour show accumulates every proposal it ever made. The chat ticker
and the watcher's `seen` set are both capped — these two were missed.

---

## 4. P2 — ships imperfect

### F-13 · The chat-feed watchdog is untested

The fix for the stuck feed (background throttling + a reload watchdog) is
verified by hand — 0 comments in 60s became 3 in 75s — but the watchdog's own
logic has no test. Its central judgement is "active show + silent chat = dead
socket", and that discrimination is exactly the kind of thing that rots.

### F-14 · No auth, no rate limiting on the API

Anyone who can reach port 8790 can drive every show, approve actions and detach
sessions. Correct for a local operator tool, stated in the README, and completely
wrong for anything deployed. Worth restating here because "it's local" stops
being true the moment someone demos it from a laptop on conference wifi.

### F-15 · Restart durability is inconsistent

Actions and the audit chain survive a restart (SQLite). Proposals, the reply
cache and the show context do not (in-memory). So after a crash the audit says a
reply was sent and the console cannot show you which one. Either persist
proposals or say plainly that they are ephemeral.

### F-16 · `views` is always 0 on observed lots

Rendered in the pinned-lot card as `views 0` for every eBay lot, because eBay
does not expose it in the player DOM. A metric that is structurally always zero
should not occupy a slot in the highest-value panel on screen.

---

## 5. Clarity, sleekness, redundancy

The operator console is dense by design. These are the places where density has
tipped into noise.

| # | Issue | Why it hurts | Fix |
|---|---|---|---|
| C-01 | **Audit panel is a wall of identical green lines** (F-01) | The one event that matters is invisible | Fix F-01 |
| C-02 | **8–16 provenance chips per card** | The trust surface becomes wallpaper; nobody reads sixteen chips mid-show | Show the top 4, collapse the rest behind "+12 more". The no-match case already proved one chip is enough |
| C-03 | **Chips repeat the same lot six times** — `Lot 439 · stock`, `Lot 439 · item`, … | The lot name is the redundant part, not the field | Group by lot: one chip per lot, fields as sub-labels |
| C-04 | **Autonomy ladder labels wrap** (`One-tap` over two lines) at common widths | The product's most important control looks broken | Abbreviate to `L0…L4` with the name in the hover, or give the ladder its own row |
| C-05 | **Title truncates to `eBay Live gmqx…`** (F-10) | Operator cannot tell which show they are on | Fix F-10, then truncate on the seller name instead |
| C-06 | **`stock 1 · sold 0 · views 0`** on observed lots | Two of three numbers are structurally meaningless | Show `stock` only when known; drop `views` for observed lots (F-16) |
| C-07 | **`P95 0ms`** before the first reply | Reads as broken instrumentation | Render `—` until there is a sample |
| C-08 | **Guardrail pills show `− price` for "did not apply"** | A dash next to five ticks reads as a failure | Use a distinct muted style and a tooltip: "no price claim to check" |
| C-09 | **"2 awaiting" counts blocked cards** the operator cannot send | Inflates the queue with work that is not actionable | Count only `ready` + `needs_review` |
| C-10 | **No empty state for a quiet show** | A working system looks broken when chat is slow — which is most of the time | "Listening · 47 messages, none needed a reply" beats a blank panel |
| C-11 | **Host-audio panel says "Not listening yet"** even when the bridge is open in another tab | The operator has already done the thing it is asking for | Reflect actual session state from the server, not the absence of transcripts |

C-02 and C-03 are the biggest wins. The provenance chips are the system's
trust argument, and right now they are the least readable thing on screen.

---

## 6. Whissle platform gaps

Prioritised. Nothing here is changed in `whissle_gateway_backend`; this is the
list of things the app works around today.

| # | Gap | What the app does instead | Suggested fix |
|---|---|---|---|
| **W-1** | **No per-agent KB namespacing.** A knowledge base is a flat corpus per agent. Serving several sellers meant either one agent with mixed corpora (a real tenancy leak, caught in this build) or one agent per seller. | One pre-created agent per catalog, `npm run seed:agent`. Costs an agent per seller and a full KB re-upload on any change. | A `namespace` or `collection` field on KB documents, and a per-turn filter on `search_knowledge_base`. Would let one agent serve many sellers safely. |
| **W-2** | **KB upload is replace-by-delete.** No upsert. Re-syncing a lineup means listing, deleting and re-uploading. | `KbSync.removePrevious` + upload. Racy, and expensive as catalogs grow. | `PUT /api/agents/{id}/kb/{externalId}` with caller-supplied ids. |
| **W-3** | **No token streaming on `chat/turn`.** The whole cold-path p95 problem. The console contract already specifies a streaming `drafting` state. | Emits the proposal once, complete. p95 1950–3735 ms. | SSE on `/api/agents/{id}/chat/turn`, same envelope the companion's `/api/chat/stream` already uses. This is the single highest-value platform change for this app. |
| **W-4** | **`content_guardrails` is state-blind.** A pure string matcher with no access to the caller's data, so a rule like "never say 'guaranteed authentic' **unless** this listing has a certificate" cannot be expressed. | Conditional rules stay app-side in Layer B; only unconditional ones are pushed. Documented asymmetry. | Allow a rule to be conditioned on a per-turn variable, or expose a "guardrail context" the matcher can read. |
| **W-5** | **No listen-only session without a bench endpoint.** The listen-only mode lives on `/api/bench/voice/start`. | Calls the bench endpoint in production. Works, but it is a benchmark door. | Promote `listen_only` to `/api/voice/start` or the embed session mint. |
| **W-6** | **Voice metadata needs a per-turn correlation id.** Emotion and intent arrive on their own frames, out of step with the transcript. | The bridge holds the most recent distribution and attaches it to the next final segment. Good enough at utterance granularity, wrong at sentence granularity. | Carry the transcript's segment id on the signal frame. |
| **W-7** | **Agent creation requires `tools` as objects.** `tools: ["search_knowledge_base"]` 422s; `[{name, enabled}]` works, and the error does not say so. | Documented in the seeder. | Accept bare strings, or return an error naming the expected shape. |

**W-3 is the one that matters.** It is the difference between meeting and missing
the brief's stated latency target, and it benefits every text agent on the
platform, not just this app.

---

## 7. What I would fix, in order

1. **F-01** — audit chain purity. One change, fixes C-01 and most of F-04.
2. **F-06** — a client/server contract suite. F-02 should never have reached a user.
3. **F-08 / F-09** — wire research into the reply path. Closes a mandatory brief item cheaply.
4. **F-05** — retire ended lots. Fixes the rest of F-04 and cleans the KB.
5. **C-02 / C-03** — make provenance chips readable. Biggest clarity win per line changed.
6. **F-03, F-10, F-11, F-12** — the small correctness set.
7. **W-3** — raise token streaming with the Whissle team; it is the latency answer.

---

## 8. What this audit says about the build

The parts that were designed carefully — the guardrail chain, the two-phase
commit, the retrieval ablation — hold up under adversarial reading. Every P0 and
P1 here is in the **connective tissue**: what gets written to the audit log, what
the client sends over the wire, what happens when a dependency dies, whether a
service that exists is actually called.

That is a familiar shape and worth stating plainly rather than defending: the
interesting mechanisms got tests and evals, and the boring seams between them got
neither. F-02 is the clearest example — 47 tests on the backend, zero across the
boundary where it actually broke.
