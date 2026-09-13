# Running SideStage on a real eBay Live show

The copilot is not limited to the seeded demo. It attaches to a **real eBay Live
stream**, reads the real buyer chat, tracks the real lot on the block, and answers
grounded in the seller's real catalog.

```bash
npm run dev                                   # server on :8790
npm run demo:ebaylive -- <eventId|showUrl>    # attach + import + ask
```

Find a show at [ebay.com/ebaylive](https://www.ebay.com/ebaylive), open one, and copy
the URL — it looks like `https://www.ebay.com/ebaylive/events/gmqxTwJPXDeKbGRE/stream`.

---

## What is actually real

Verified against *"Sunday Baseball Marathon! MLB Singles w/ Jacob"* by Curated Cards
and Collectibles, ~250 concurrent viewers.

| | |
|---|---|
| **Buyer chat** | Real, live, deduped by eBay's own per-comment UUID |
| **Lots** | Real title, price, high bidder, countdown, sold state |
| **Price movement** | Real. A single lot's version hit **v19** in one watch — nineteen live bid increments |
| **Whissle agent** | Production `chat/turn`, per-turn grounding context |
| **Knowledge base** | The show's catalog really is uploaded to the agent |
| **Host audio** | Listen-only Whissle session mints; capture needs one operator click |
| **Replies** | Drafted and guarded. **Never posted back.** |

Real chat from that show, and what the copilot answers:

```
Q  any red sox
A  Yes, we have Boston Red Sox cards — Mookie Betts 2015 Topps Chrome Refractor
   ($92, 1 left), Rafael Devers 2017 Topps Update RC ($38), and Roman Anthony
   2025 Bowman Chrome 1st ($155).
   [ready] conf 0.95 · 3.1s · grounded in: tonight's lineup, Betts · item, Devers · item

Q  any lakers jerseys
A  We don't have any Lakers jerseys in tonight's lineup.
   [ready] conf 0.95 · 0.9s · grounded in: tonight's lineup
```

The second one is the more important result. "We don't have that" is a **grounded**
answer citing the lineup fact — not a fallback, and not a guess.

---

## 1. Attach

```bash
curl -X POST localhost:8790/api/shows/attach \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.ebay.com/ebaylive/events/<eventId>/stream"}'
```

Each attached show gets its **own SQLite file** (`data/shows/<showId>.db`) and its own
pipeline, retriever, executor and audit chain. Watch several at once
(`MAX_WATCHED_SHOWS`, default 6); every SSE payload carries `showId`.

Attached shows are **read-only**. We hold no seller credentials for someone else's
stream, so every write action fails preflight on `show is yours to edit`. The copilot
still drafts replies — it just cannot act. Proposing a markdown we could never commit
would be theatre.

## 2. Import the catalog

This is the step that makes monitoring useful, and it exists because of a real
limitation: **eBay Live only renders the lot currently on the block.** The full lineup
sits behind an Items panel that requires sign-in. Watching from outside, the copilot
learns the catalog one lot at a time — and until it does, the honest answer to
"how much on the Griffey" is "the host will cover that shortly".

The answer is not to scrape harder. A seller running SideStage on their own show
already has their catalog — it is their inventory:

```bash
curl -X POST localhost:8790/api/shows/<showId>/catalog \
  -H 'content-type: application/json' \
  --data-binary @fixtures/ebay-card-show-catalog.json
```

CSV works too (`content-type: text/csv`, header row naming the fields; prices may be
dollars or cents). Re-importing the same SKU **updates in place** — and a price change
goes through `mutateListing`, so the version bumps and the staleness guard treats an
imported change exactly like a live one.

Two sources of truth, cleanly split:

| | |
|---|---|
| **Imported catalog** | what exists, what it is, what it costs at open |
| **Live stream** | what is on screen right now, at what price, sold or not |

The import also pushes the lineup to the **Whissle agent's knowledge base**, so the
agent can search it with `search_knowledge_base` for anything the per-turn facts
missed. Prices go in marked *indicative only* — a KB cannot be re-indexed between two
bids, so anything that moves during a show is never answered from it.

## 3. Host audio (optional)

```
open http://localhost:8790/audio-bridge?showId=<showId>
```

Pick the eBay Live tab, tick **Share tab audio**. The page publishes that audio into a
Whissle **listen-only** session — STT and emotion metadata, no LLM, no TTS, the bot
never speaks — and transcripts feed the rolling show-context engine.

This is the capability the brief itself does not have. The catalog knows what a card
is; it does not know the host just said *"this one's a jersey patch, numbered to 25,
last one tonight"*. A buyer who types "is that numbered?" four seconds later is asking
about that.

The `wsk_` key never leaves the server — the browser gets only a short-lived room
token. Capture **cannot** be started from the backend: browsers require an operator
gesture to hand a page tab audio, which is a good property, not a gap.

---

## How the ingestion works, and its honest status

eBay Live has **no public API** for show chat or lots. The Developer Program covers
Browse, Sell, Feed and Media; there is no Live surface. Only telemetry goes over HTTP
on the show page — chat rides a WebSocket.

What the page does expose is a same-origin player at
`/ebaylive/events/{eventId}/player.html` that renders both the chat and the current lot
into the DOM, live, with no sign-in. `src/ingest/ebaylive/watcher.ts` drives a headless
browser and reads it.

**That is a prototype ingestion path, not a supported integration.** It is honest about
what it does:

- **Read-only by construction.** There is no code path that posts a comment or a bid.
- **Polls at a human cadence** (1s), with images, media and fonts blocked — which is
  what makes watching several shows at once practical.
- **Selectors match class PREFIXES**, because eBay ships hashed CSS-module names
  (`chatMessage-BPsSWw`) that change every deploy. The stable parts are those prefixes
  and `li[data-id]`, a server-issued UUID per comment and therefore the natural dedupe key.
- **The backlog is suppressed on attach**, so a freshly attached show does not replay
  an hour of chat through the reply pipeline.

If eBay opens the real API — and the challenge *is* from eBay, so this may be one
conversation away — `watcher.ts` is the only file that changes. It emits into the same
`ChatSource` port the simulated source uses.

### Known limitations of this path

1. **The full lot list needs sign-in.** Hence the catalog import above.
2. **Discovery is best effort.** The eBay Live index lazy-mounts its grid and navigates
   through click handlers rather than links, so `/api/shows/discover` often surfaces
   channel ids rather than event ids. Attaching by URL is the reliable path — and the
   operator has the URL, because they are watching the show.
3. **Selector drift.** A front-end deploy that renames the chat feed's class prefix
   breaks ingestion. The watcher reports it on the `source` event rather than dying,
   but it would need a fix.
4. **Writes are impossible on a stream you do not own.** By design, enforced at preflight.
5. **Terms of service.** Automated access to eBay is restricted. This is fine for a
   prototype you run yourself; anything beyond that needs a partner or official route.

### Bugs this path found in the copilot itself

Pointing the system at real traffic broke it in three ways an eval set had not:

| Bug | Effect |
|---|---|
| Actions collided on `idempotency_key` after a restart, because the in-memory dedupe set was empty while the DB still held prior actions | **Crashed the server.** `propose()` now returns the existing action — the same intent at the same version *is* the same action |
| `priceGuard` read a **$9.95 shipping charge** as an item-price commitment and blocked a correct reply for being below the floor | Amounts stated verbatim by any grounding fact are now recognised; regression case added to the eval suite |
| The agent wrote fact ids **inline in the reply text** a buyer would see | Ids are stripped from `answer` and kept in `claims`; regression test added |

A fourth was self-inflicted and caught the same way: the inventory-search path supplied
only identity/price/availability facts, so the model cited a `#condition` fact it had
never been handed and the grounding guard correctly blocked it. Matched lots now get
the same fact set an attribute question would.
