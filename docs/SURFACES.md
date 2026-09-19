# Surfaces

A **surface** is where a conversation happens. There has only ever been one —
an eBay Live show — and everything SideStage knew about it was spread across
whichever file needed it: the watcher knew how to read it, `ShowRuntime` knew
how to start it, the guards assumed a catalog stood behind every reply, and
preflight assumed every action was a listing write.

None of that was wrong. All of it was eBay Live wearing the clothes of a
general system, and the cost showed up the first time somebody asked whether we
could answer in a subreddit: the answer meant reading five files and lived in
none of them.

Every surface now answers the same five questions, in `src/surfaces/types.ts`:

| | |
|---|---|
| **tempo** | `live` (the last ninety seconds are the context) or `async` (the thread is) |
| **delivery** | `api` (we can send) or `draft-only` (a human sends) |
| **perception** | Does it carry the operator's audio and video? |
| **actions** | Which `ActionKind`s exist here at all |
| **corpora** | What grounds a claim here (see `src/retrieval/corpus.ts`) |
| **communityRules** | Does the room impose its own rules, fetched per room? |

## What reads the answers

* **Guards** — `priceGuard` and `availabilityGuard` return `n/a` on a surface
  with no `listing` corpus. A Twitch reply quoting "$169" is not a stale listing
  price, and a guard that fired on it would block every sponsored reply that
  names a number. `communityRuleGuard` and `sponsorGuard` are the reverse: n/a
  on live commerce, live everywhere the corpus exists.
* **Preflight** — an action a surface does not declare is refused before
  anything else is measured. Every other check is an argument about degree, and
  those arguments are nonsense when the action does not exist here.
* **The console** (Wave C) — capabilities drive which columns a session has. No
  lot rail on Twitch, a thread panel on Reddit, no latency meter on an async
  surface.

## The capability table is static

It is data in `types.ts`, not something read off the adapter registry. Guards
ask it on the hot path and about rows loaded from the database, sometimes before
the adapter that serves that surface was imported. A safety check whose answer
depends on module import order is not a safety check. An adapter declares the
same object as its `capabilities`, so the two cannot drift.

## Writing an adapter

One directory under `src/surfaces/<id>/`, exporting a `SurfaceAdapter`:

```ts
export const twitchAdapter: SurfaceAdapter = {
  id: "twitch",
  label: "Twitch",
  capabilities: capabilitiesOf("twitch"),
  parseTarget(input) { /* a link or a handle, or null */ },
  async open(target, ev) { /* emit through ev.onMessage / onItem / … */ },
};
```

Register it in `src/surfaces/registry.ts`. `resolve(input)` tries every adapter
in registration order, and eBay Live is first because it has the tightest
pattern and is the surface a mistyped link most likely belongs to.

Ship with it: a **fixture-driven test that needs no network and no key**, and a
paragraph here.

### Keys are read from `.env`, and absence is a first-class state

`capabilities` still resolve without a key — the console can show what a surface
would do. `open()` throws `SurfaceUnavailable(surface, message, missing)`, which
the attach route turns into a 409 naming the variable. A 500 saying "failed to
open twitch" sends the operator to the logs for something the response could
have told them.

| Surface | Variables | Without them |
|---|---|---|
| Twitch | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_BOT_REFRESH_TOKEN` | adapter and tests ship; `open()` 409s naming the variable |
| Reddit | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD`, `REDDIT_USER_AGENT` | same |
| YouTube Live | `YOUTUBE_API_KEY` (+ an OAuth client for posting) | same |
| Whatnot / TikTok | none — Playwright, reusing `EBAY_DISCOVERY_PROXY` | works, subject to the page |

## eBay Live is a delegation, not a rewrite

`src/surfaces/ebaylive/adapter.ts` opens `src/ingest/ebaylive/watcher.ts` and
renames its callbacks. The watcher is the integration — the hashed-class
selectors, the background-throttling flags, the dead-socket watchdog, the
"Target crashed" recovery, the fifteen-minute end-of-show silence — and all of
it was won against a real page on a real box. None of it is repeated in the
adapter and none of it moved.

A lot's high bidder and countdown ride in `onItem`'s `meta`, because they feed
`upsertObservedLot` and dropping them would have changed what eBay Live records.

## Posting is off until a human turns it on

`surface_rooms` (migration 019) records a person deciding we may speak in a
particular subreddit, channel or conversation. Default false; a room with no row
reads as **off**, not unknown; `post_reply` is refused at preflight with
"posting is off for r/mechmarket — the draft is yours to send".

`reddit` is `draft-only` in code, where no setting can reach it, and the route
refuses to store `posting: true` for a draft-only surface rather than storing a
switch that shows as on and is refused every time.

The asymmetry is the whole argument: the undo window can delete a comment, it
cannot unsee it, and one wrong post costs an account that has been in a
community for years.
