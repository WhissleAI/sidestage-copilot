# Running SideStage on a real eBay Live show

The copilot is not limited to the seeded demo. It attaches to a **real eBay Live
stream**, reads the real buyer chat, tracks the real lot on the block, and answers
grounded in the seller's real catalog.

```bash
npm run dev                                   # server on :8790
npm run demo:ebaylive -- <eventId|showUrl>    # attach + import + ask
```

Find a show at [ebay.com/ebaylive](https://www.ebay.com/ebaylive) (or on the console's
Discover tab, which needs the house session described below), open one, and copy the URL —
it looks like `https://www.ebay.com/ebaylive/events/gmqxTwJPXDeKbGRE/stream`.

---

## What is actually real

Verified against *"Sunday Baseball Marathon! MLB Singles w/ Jacob"* by Curated Cards
and Collectibles, ~250 concurrent viewers.

| | |
|---|---|
| **Buyer chat** | Real, live, deduped by eBay's own per-comment UUID |
| **Lots** | Real title, price, high bidder, countdown, sold state |
| **Price movement** | Real. A single lot's version hit **v19** in one watch — nineteen live bid increments |
| **Whissle agent** | Production `chat/turn` (streamed), per-turn grounding context, one agent per stream |
| **Knowledge base** | The show's catalog really is uploaded to the agent |
| **Host audio** | Listen-only Whissle session mints; capture needs one operator click |
| **Replies** | Drafted and guarded, re-guarded at send. **Never posted back** — the seller pastes them |

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

Every `/api/*` route needs a seller session (`POST /api/auth/register` or `/login`
returns a `token`):

```bash
curl -X POST localhost:8790/api/shows/attach \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://www.ebay.com/ebaylive/events/<eventId>/stream"}'
```

Each attached show is a `ShowRuntime` with its own pipeline, retriever, executor and
audit chain, scoped in one Postgres database by `show_id` (the show-per-SQLite-file
store is gone). Watch several at once (`MAX_WATCHED_SHOWS`, default 6); every SSE
payload carries `showId`. **The show belongs to the account that attached it:** every
show-bound route answers 404 to any other account, and the Shows list and the SSE
`shows` event are cut to the caller's own.

Attached shows are **read-only**. We hold no seller credentials for someone else's
stream, so every write action fails preflight on `show is yours to edit`. That flag is
set at attach and nothing clears it — even for a seller who has connected their own
eBay account and armed the show's write target — so today no action commits to eBay
from an attached stream. The copilot still drafts replies; it just cannot act.
Proposing a markdown we could never commit would be theatre.

Attaching a show that was **prepared** (Discover → Prepare) reuses its catalog and its
agent; an unprepared show gets a fresh agent of its own, grounded from the stream.

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
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data-binary @fixtures/ebay-card-show-catalog.json
```

CSV works too (`content-type: text/csv`, header row naming the fields; prices may be
dollars or cents). A seller who has connected eBay can instead import their own
listings (`POST /api/ebay/import`), and preparing a show from Discover builds its
catalog from the host's public listings. Re-importing the same SKU **updates in place**
— and a price change goes through `mutateListing`, so the version bumps and the
staleness guard treats an imported change exactly like a live one.

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
open http://localhost:8790/audio-bridge?showId=<showId>&token=<token>
```

Pick the eBay Live tab, tick **Share tab audio**. The page publishes that audio into a
Whissle **listen-only** session — STT and emotion metadata, no LLM, no TTS, the bot
never speaks — and transcripts feed the rolling show-context engine. One downscaled
keyframe every 12 s goes to the show's agent for a one-line reading of what is on
camera; that reading is show context, never citable provenance.

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
into the DOM, live, with no sign-in. `src/ingest/ebaylive/watcher.ts` drives a browser
and reads it. **The browser is real Google Chrome in headless mode** (`acquireBrowser`:
`channel: "chrome"`, the bundled Playwright build only where no Chrome exists). Not a
preference: the bundled headless shell crashed its renderer on every attach on the
deployed box while the same attach worked on a laptop, and eBay Live streams nothing
to it. One browser is shared across shows; if it dies, `browser.on("disconnected")`
drops the handle and the next tick relaunches.

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
- **A silent feed on an active show is treated as a dead socket** and the page is
  reloaded, a bounded number of times, with the reason on the `source` event.

If eBay opens the real API — and the challenge *is* from eBay, so this may be one
conversation away — `watcher.ts` is the only file that changes. It emits into the same
`ChatSource` port the simulated source uses.

### Discovery: the live grid, and the session it needs

The player page is public; the **grid** of what is on air is not. Measured: a signed-out
headless browser on `ebay.com/ebaylive`, waited out to forty seconds with scrolling,
finds **zero** event links; the same page signed in has fifty, with viewer counts,
seller handles, titles and tags. So Discover reads the grid through a **house session**
(`src/ingest/ebaylive/session.ts`):

1. A person signs in once, in a real browser: `npm run ebay:signin` (tick "Stay signed
   in"). Nothing in the code ever reads a credential; the window is theirs.
2. The session is exported as Playwright storage state with `npm run ebay:export` —
   `data/ebay-session.json`, gitignored, in the same category as a password. On a
   developer's laptop the persistent Chrome profile (`data/ebay-profile`) is used
   directly; on a server only the exported jar travels, because macOS Chrome encrypts
   cookies with the Keychain and a Linux Chrome cannot read them.
3. **The grid is read through one fixed address.** eBay ends a session it sees from a
   second address — measured on 2026-09-14, and the earlier diagnosis "eBay refuses
   datacenter IPs" was wrong (the README has the full account). `EBAY_DISCOVERY_PROXY`
   routes the discovery browser — only that browser, never the API client or the player
   attach — through a fixed-IP residential or ISP proxy; the sign-in is done through the
   same variable, so the session only ever appears from one place.
4. **It is kept warm.** `src/sellers/following.ts` re-reads the grid every
   `DISCOVERY_REFRESH_MIN` minutes (default 5) whenever a session exists, and matches
   followed sellers against it. Every answer carries `checkedAt`.
5. **It reports its state honestly** (`/api/home`, `/api/shows/discover`): `ok`,
   `pending` (this process has not read yet — the first read is a minute out),
   `signed-out` (eBay's header said "Sign in or register": the session ended, sign in
   again), `stale` (the last good grid is old), `no-session`, `stale-session`, or
   `blocked` (a shrug). An empty grid is never shown as "nobody is on air".

The grid is the same for every seller, so one session serves every account on the
host. Attaching by URL needs none of this — the operator has the URL, because they are
watching the show.

### Known limitations of this path

1. **The full lot list needs sign-in.** Hence the catalog import above, or Prepare,
   which builds a catalog from the host's public listings through the house session
   when the Browse seller filter is not honoured.
2. **Discovery needs the house session and its fixed address.** Without them the Discover
   tab says `no-session` or `signed-out`; it does not pretend the grid is empty.
3. **Selector drift.** A front-end deploy that renames the chat feed's class prefix
   breaks ingestion. The watcher reports it on the `source` event rather than dying,
   but it would need a fix.
4. **Writes are impossible on a stream you do not own.** By design, enforced at preflight.
   A stream is yours when the eBay username behind your consent matches its seller
   handle; that is the only thing that clears `read_only` at attach.
5. **The watcher does not know when a show ends.** It keeps polling until the seller
   detaches the show (which writes the report and, a day later, retires the agent).
6. **Replies are not delivered.** There is no chat-post API; a "sent" reply is recorded
   and audited, and the seller pastes it into the show's chat.
7. **Terms of service.** Automated access to eBay is restricted. This is fine for a
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
