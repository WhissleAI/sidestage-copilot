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

**DONE — and not the way this section proposed.** Publishing the track into the
listen-only LiveKit session turned out to be the wrong route: the gateway's
ambient loop writes its reading into `[VISUAL CONTEXT]` for the *next LLM turn*,
and a listen-only session has no LLM turn, so the understanding would never come
back to us. Server-side decode would also have needed `VIDEO_CONTEXT_URL` and
the separate video sidecar.

What actually works is smaller: the bridge keeps the track it already has,
samples ONE downscaled keyframe every 12s, and posts it to
`POST /api/shows/:id/visual/frame`. The backend asks the show's own agent
through the normal `chat/turn` door with `images` — the gateway routes that to
its `analyze_image` tool, which is what makes it work on a text-first model — and
the one-line reading becomes show context beside the transcript. Zero gateway
changes; measured on a live show, a frame read back as "Louis Vuitton tote".

Both caveats from the original note survive as enforced rules rather than prose:
the read is throttled server-side (8s floor, because a client's throttle is a
request not a guarantee), and the reading is **never citable as provenance**.
It tells the model WHICH item the buyer means; a price, a size or a certificate
still has to come from a grounding fact or it is not said. Asserted in
`copilot.test.ts`.

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

### 2.1 Postgres — **DONE**

SQLite-per-show was the right call for a prototype — a show is a clean tenant
boundary and file isolation is free. It is the wrong call the moment there is more
than one process or more than one operator.

- One Postgres schema, `show_id` as a real column with row-level scoping
- Keeps the per-show *isolation* property by policy rather than by filesystem
- Migrations already run through a tracked `schema_migrations` table, so the
  runner does not change — only the driver and the tenancy predicate

**Sequenced first** because guest accounts, settings and analytics all want shared,
queryable, multi-process state, and porting them twice is waste.

**Shipped.** One database, `show_id` a real column, and `Repo` constructed WITH a
show id so tenancy is structural rather than remembered. Every layer that touched
SQL became async; `retrieve()` stayed synchronous by holding the listing snapshot
its index was built from — which also closed a latent inconsistency where slot
resolution read listings live while the fact index lagged a rebuild behind.

Three real bugs the move exposed, none of them visible under show-per-file:

1. **`idempotency_key` was globally unique.** The key hashes (kind, listing,
   version, params), so two shows selling the same catalog produce the SAME key
   — the second show could never propose an action the first had. Scoped to
   `(show_id, idempotency_key)` in migration 002.
2. **`jsonb` cannot hold a hashed payload.** It normalises key order and
   whitespace, so the audit `detail` we hashed going in was not the `detail`
   coming back, and `verify()` reported a break in a chain nobody had touched.
   `detail` is now `text` holding the exact bytes (migration 003). Evidence you
   reformat is evidence you cannot verify.
3. **Promises serialise to `{}`.** `hello` and `/health` shipped empty objects
   where a value used to be, and TypeScript could not see it because the sites
   were inside object literals. Caught by reading the wire, not the types.

### 2.2 Guest accounts + auth — **DONE**

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

**Shipped.** `accounts` + `auth_sessions` + a bearer token the console mints on
first load. A guest may read every route and change nothing; the six command
routes (send, dismiss, regenerate, approve, reject, rollback, autonomy) require
a seller, enforced in one place so a route added later is not left open by
omission. `audit.actor_id` now references the account, and the console shows
which it is acting as — amber "watching · take control" for a guest, the
operator's name once claimed. Five contract tests cover the boundary.

### 2.3 Settings — **DONE**

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

**Shipped, and it is the policy object only.** `/settings` edits the never-say
list, the discount cap, the reply-length cap and the voice switches. A save is
four steps, not a database write: persist the override, re-arm Layer B in this
process, re-push Layer A to every catalog agent, and **read back** what the
gateway says is armed. That last step is the one that matters — pushing config
and assuming it took is how you end up believing in a guardrail that is not
there, and the page shows `never_say_count: 15` straight from
`/api/agents/{id}/guardrails` rather than echoing what was sent.

The page also renders the asymmetry rather than hiding it: 17 rules are checked
in Layer B, 15 are armed on the agent, and the two `unlessCertified` rules carry
an `app-only` badge with the reason. Two guards on the input, both of which
protect the reply path rather than the form: a seller-authored regex that does
not compile is refused (a guard that throws returns `block` — every reply, until
someone read the logs), and the discount cap is clamped, because a cap of 100%
is not a setting, it is an outage.

### 2.4 Analytics, including Whissle agent statistics — **DONE**

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

**Shipped as `/analytics`, in exactly those three sections**, plus a fourth for
what the agent itself did. The session trace was the unused source and is now the
most useful thing on the page: per turn it names the provider and model that
answered, whether it failed over, the latency and the tokens. Measured on the
demo agent — 25 turns, p50 810 ms, p95 1549 ms, one model (`gpt-oss-120b` via
`local`), 148.7k tokens. "The copilot is slow" and "hop 0 went to gpt-oss-120b,
took 916 ms on 3,830 input tokens" are different sentences and only one of them
is actionable.

Audit-chain integrity is rendered *inside* "can I trust it" rather than beside it,
because that is the question it answers. `stop_reason: max_tokens` is called out
in amber: a truncated reply to a buyer is not a neutral fact.

---

## 3 · Whissle platform asks

From [`REVIEW.md`](REVIEW.md) §6, restated with status.

| # | Ask | Status |
|---|---|---|
| **W-3** | Token streaming on `chat/turn` | **SHIPPED** — [gateway #1101](https://github.com/WhissleAI/whissle_gateway_backend/pull/1101) merged and deployed to AWS 2026-09-13. `POST /api/agents/{id}/chat/turn/stream` is live: `open` → (`delta`\|`tool`)* → `done`, where `done` carries the byte-identical body the JSON door returns. SideStage does not consume it yet — see §4 |
| **W-8** | Attribute METERING to an agent | **NARROWER THAN FIRST FILED.** `/api/orgs/{org}/usage/sessions` returns `agent_id: null` for every text session and `/usage/events` carries no agent field — so the *metering* rows cannot be attributed. But `/api/sessions` **does** carry `agent_id` and accepts `?agent_id=`, and `/api/sessions/{id}/trace` gives per-hop provider, model, failover, latency and token usage. Per-agent attribution is therefore possible, just through the calls API rather than the billing API, and at the cost of an N+1 (list, then trace each). The ask is to carry `agent_id` on the usage rows so the two views agree; the analytics page uses the trace path in the meantime |
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

### Done since this was written

1–4 are complete: **F-01** (observations no longer enter the hash chain), **F-05**
(a sold-out lot becomes `ended`, so every existing filter stops carrying it, and
`hello` dropped from 113 KB to ~34 KB), **F-03** (Chromium death drops the shared
handle and the next tick relaunches), **F-06** (a 15-case contract suite drives
the real routing table — it found two bugs on its first run: malformed JSON
answered 500 instead of 400, and an in-flight draft wrote to a database that
shutdown had already closed), and **F-08/09** (comparison and "is that a good
price" questions now pull comps into the evidence set on the reply path).

**Cost visibility** landed alongside them: `GET /api/billing` and a `cost` panel
in the console, built on the wallet and usage endpoints plus this app's own
meter. That is the answer to "how are we paying for Whissle agents" — and W-8
above is what it ran into.

**W-3 is consumed.** `chatTurnStream` takes the streaming door and the pipeline
re-emits the proposal as the answer forms, so the operator watches it arrive
instead of a spinner. Three properties held deliberately:

- **The guards still judge the COMPLETE draft.** `done` carries the
  authoritative reply and that is what the chain runs on. Streaming shortens
  time-to-first-token, never time-to-send — a partially generated reply has been
  checked by nothing and must never be sendable. Asserted in `copilot.test.ts`.
- **`done` wins over the deltas.** A stream that ends without it is an error, not
  a reply assembled from fragments: answering from a partial accumulation hands
  the guards a truncated draft that looks whole.
- **404 falls back to the JSON door.** An older gateway in front of this app
  should lose the narration, not the reply.

Measured against production: first token at ~1.0 s on a reply that completes in
~1.1 s. The honest caveat is that the gateway emits coarse deltas (2 for a short
reply), so on one-sentence answers the win is small; it grows with the length of
the reply.

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
