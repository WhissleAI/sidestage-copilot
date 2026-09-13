# What SideStage is missing, and in what order

A plan, not a promise. Written after auditing the running system ([`REVIEW.md`](REVIEW.md))
and checking what the Whissle platform actually supports rather than what it
plausibly might.

Sequenced by **what a reviewer or a pilot seller hits first**, not by what is
most interesting to build.

---

## 0 · The finding that changes the shortest path

**Whissle already has hybrid visual intelligence, and we are throwing the pixels
away.**

`services/visual_perception.py` (MediaPipe) gives fast geometric signals every
second; `services/visual_understanding.py` sends a periodic keyframe to a vision
model and folds a one-line scene reading into the same `[VISUAL CONTEXT]` block
the agent already sees. The `look` tool re-reads the latest keyframe to answer a
specific question about **whatever is on the user's camera or shared screen right
now**. Gated on `agent.video_enabled` and `visual_mode == "hybrid"`, server-side,
hard-throttled.

And in our own audio bridge:

```js
stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
var audio = stream.getAudioTracks()[0];
stream.getVideoTracks().forEach(function (t) { t.stop(); });   // ← we discard it
```

We request video **because Chrome will not offer tab audio without it**, then stop
the track immediately. For a *live selling* show that is the wrong instinct: the
host is holding the item up to camera, and the single most common question —
"what's that one?" — is answerable from the frame and from nothing else.

**This is the cheapest high-value item on this list**: publish the track we
already have, set `video_enabled`, and the visual reading joins the transcript in
the same rolling context the replies are already grounded in.

Two honest caveats. The ambient loop is throttled and costs a vision call per
interval, so it is a per-show setting, not a default. And a screen reading is a
*sense of the view*, not a catalog fact — it belongs in show context alongside the
transcript, and must never be citable as provenance for a price.

---

## 1 · P0 — correctness the audit already found

From [`REVIEW.md`](REVIEW.md), in fix order. These come before any new surface,
because building an analytics page on top of a corrupt audit log is building on sand.

| # | Item | Why first |
|---|---|---|
| F-01 | Audit chain is 99.5% ingestion noise | Corrupts the vocabulary, buries real events, and dilutes the strongest claim in the submission. Also fixes most of the 113 KB `hello` payload |
| F-06 | No test crosses the client/server seam | The 400-on-every-bodyless-POST bug shipped because 53 tests stop at the boundary where it broke |
| F-08/09 | Research is orphaned; `comparison` unhandled | A mandatory brief item is half-met. Cheap: call it during retrieval, add comps as evidence |
| F-05 | Sold-out lots carried forever | 23 of 24 observed lots are dead and still in `hello`, the lineup fact and the KB |
| F-03 | Browser death is silent | Every watched show stops and the console keeps showing a stale show that looks alive |

---

## 2 · Making it an application, not a demo

The four things you named. Ordered by how much they unblock.

### 2.1 Postgres

SQLite-per-show was the right call for a prototype — a show is a clean tenant
boundary and file isolation is free. It is the wrong call the moment there is more
than one process or more than one operator.

- One Postgres schema, `show_id` as a real column with row-level scoping
- Keeps the per-show *isolation* property by policy rather than by filesystem
- Migrations already run through a tracked `schema_migrations` table, so the
  runner does not change — only the driver and the tenancy predicate

**Sequenced first** because guest accounts, settings and analytics all want shared,
queryable, multi-process state, and porting them twice is waste.

### 2.2 Guest accounts + auth

Today: **no auth at all.** Anyone who can reach port 8790 drives every show,
approves actions and detaches sessions. Correct for a local tool, wrong the moment
it is demoed from conference wifi.

- A guest account that can **watch** a show and see proposals, but cannot send,
  approve or act — the read-only rung below `L1 Suggest`
- Session cookie for the console, `wsk_`-style key for programmatic access
- Every command route carries an actor; the audit chain already has `actorType`
  and currently only ever writes `seller` or `system`

This makes the audit log mean something. "Who approved that markdown" is not
answerable today.

### 2.3 Settings

There is a real configuration surface hiding in the code with no UI:

- The **guardrail policy object** (`src/guardrails/policy.ts`) — never-say list,
  discount cap, reply length, PII redaction. Already file-overridable via
  `GUARDRAIL_POLICY_PATH`; it should be editable and per-seller
- **Autonomy defaults** and the undo window
- **Latency budget**, proposal rate cap, action budget per show
- **Catalog management** — today a JSON file on disk

The policy object is the interesting one, because editing it should visibly change
what the agent is allowed to say — Layer A re-pushed to the Whissle agent, Layer B
re-read in process.

### 2.4 Analytics, including Whissle agent statistics

You asked specifically what the agent knows and does. All of it exists and none
of it is surfaced:

| Source | What it gives |
|---|---|
| `/api/agents/{id}/guardrails` | What is **actually armed** on the agent — never-say count, PII redaction, tool-approval policy. Currently only printed by `seed:agent` |
| `/api/agents/{id}/kb` | The documents the agent can retrieve, per catalog |
| `/api/sessions` + `/api/sessions/{id}/trace` | **Per-turn: which provider and model answered, whether it failed over, per-tool args and citations, token cost, latency, action-integrity catches.** This is the richest unused source we have |
| Our own `Metrics` | Answered rate, guardrail block rate per guard, latency percentiles, cache hit rate, actions committed vs rolled back |

An analytics page should answer three questions a seller actually has: *did the
copilot help* (answered rate, time-to-answer, GMV per hour vs baseline), *can I
trust it* (block rate per guard, rollbacks, replies I edited), and *what is it
costing me* (tokens, calls, per-reply cost from the session trace).

The PRD already defines these metrics; nothing renders them.

---

## 3 · Whissle platform asks

From [`REVIEW.md`](REVIEW.md) §6, restated with status.

| # | Ask | Status |
|---|---|---|
| **W-3** | Token streaming on `chat/turn` | **PR open** — [gateway #1101](https://github.com/WhissleAI/whissle_gateway_backend/pull/1101). The p95 answer |
| **W-1** | Per-agent KB namespacing | Worked around with one agent per catalog. Costs an agent per seller |
| **W-2** | KB upsert by caller-supplied id | Replace-by-delete today; racy and slow as catalogs grow |
| **W-4** | Conditional `content_guardrails` | Certificate-conditional rules stay app-side; documented asymmetry |
| **W-5** | `listen_only` off the bench endpoint | We call a benchmark door in production |
| **W-6** | Correlation id on signal frames | Metadata is attached to the next final segment — right at utterance granularity, wrong at sentence granularity |
| **W-7** | Agent create should accept bare tool names | `["search_knowledge_base"]` 422s with no hint |

---

## 4 · Suggested order

1. **F-01 audit purity** — one change, unblocks analytics and fixes the payload
2. **Publish the video track** — the pixels are already in hand
3. **F-06 contract tests** — stop shipping silent client/server breakage
4. **F-08/09 research in the reply path** — closes a mandatory brief item
5. **Postgres** — before anything multi-user is built on SQLite
6. **Auth + guest accounts** — makes the audit log answer "who"
7. **Analytics page** — now that the audit is clean and the session trace is wired
8. **Settings** — last, because it is a UI over things that should be stable first

Items 1–4 are days. Items 5–8 are the difference between a challenge submission
and a product, and should not be started before the submission is in.

---

## 5 · What I would *not* build

- **Auto-posting to marketplace chat.** Deliberate boundary, not a gap
  ([`TDD.md`](TDD.md) §8)
- **A second LLM provider.** Whissle-only is a stated constraint and the
  abstraction already exists at `LlmPort` if that changes
- **Multi-show side-by-side in one console.** The registry supports many shows;
  the operator attention model does not. One show, switchable
- **A mobile console.** A seller running a show is already holding a phone with
  the marketplace app on it
