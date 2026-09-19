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

## The follow-up inbox is a surface with no feed

`dm` is the odd one, and deliberately. Every other surface is a place a
conversation is happening; this one is a place a conversation already happened
and stopped. On `ebay_47tK1SX0VsiHEXN1` — a real fragrance auction — 190
comments produced 60 answerable drafts from 29 distinct buyers and the seller
sent none of them. That is not a number for a report. It is 29 people who asked
about a specific item and left.

So `parseTarget` takes `show:<showId>` or `inbox:<handle>`, and `open()` throws
`SurfaceUnavailable` naming `POST /api/shows/:showId/followups` instead —
because an inbox built out of a show that has ENDED has nothing to hold a socket
open for. It is the one wired adapter `/api/surfaces` reports as not attachable.

Selection (`src/surfaces/dm/followups.ts`) is pure over the persisted
`ShowRecord`: a buyer is a follow-up when the copilot could have answered them,
they never got the answer, the seller did not settle it with a committed action
on the listing they asked about, and the question was not hype. One row per
buyer, not per question — two messages three hours later reads as a stranger who
wants something.

Drafting (`src/surfaces/dm/drafts.ts`) runs `Pipeline.dryRun`, not a second
composer. Between the question and the follow-up the lot has very likely sold,
and a standalone drafter would quote a price on something that is gone; running
a three-hour-old question through the live guard chain against the catalog as it
stands now is the only thing that makes answering it safe. A blocked draft is
never stored — `followups.status` has no room for one, and a row that must be
explained before it can be used is not "ready to send".

Delivery is `draft-only` in code. eBay exposes no messaging API to us and
Instagram's is behind an app review this project has not applied for, so
`POST /api/followups/:id/sent` records a human's claim that they sent it from
their own account. `sent_at` is stamped once, by `COALESCE`, so a retried press
cannot move when a buyer was actually contacted.
## Reddit: monitor, ground, draft — never post

`src/surfaces/reddit/` is the first asynchronous surface, and the first one
where we deliberately built less than we could.

**Reddit is monitor-and-draft. Posting is off in code, not in configuration.**
Undisclosed automation replying as a person breaks Reddit's own rules and is
reputationally fatal; the value is a grounded draft with its sources, which a
human sends from their own account. The code says it three times so that no
single edit undoes it quietly: `delivery` is a constant in `adapter.ts`, the
action list is `["flag_for_human"]` and does not contain `post_reply` at all,
and preflight refuses any action a surface does not declare. A row in
`surface_rooms` cannot reach any of the three.

| | |
|---|---|
| `adapter.ts` | `parseTarget` for a subreddit, a user or a thread; `open` starts the poller and warms the room's rules |
| `api.ts` | the OAuth script-app client — token cache, the User-Agent Reddit rate-limits by, and `x-ratelimit-*` pacing |
| `poll.ts` | a subreddit's new posts, a profile's comments, or one thread; deduped by fullname |
| `thread.ts` | the comment tree, and the branch above a message as a `ThreadContext` |
| `rules.ts` | `/r/<sub>/about/rules` as `community` facts, cached an hour |

Three decisions are worth knowing before changing anything here.

**Every id is a fullname.** `t3_…` for a post, `t1_…` for a comment — the ids
Reddit's own `parent_id` and `link_id` point at. The thread engine rebuilds a
branch by following parents, so the ids it walks and the ids the platform links
with have to be the same strings. Short ids would mean translating at every
boundary and getting it wrong at one of them.

**A 429 is a bug in our pacing, not an outcome.** Reddit reports the remaining
budget and the seconds to reset on every response, including the token mint. The
client waits before the request that would have spent the last of it rather than
discovering the limit by being refused, because by the time a 429 arrives the
request has been counted and the account is closer to a block.

**The rules of the room are constraints, never answers.** `rules.ts` turns each
rule into one fact with its number and short name in the label, so a blocked
draft reads "r/mechmarket rule 3 — No vendor self-promotion (community:mechmarket#3)"
and the operator's "says who" is answerable from the card. They are cached for
an hour and warmed at attach, because a draft path that fetched them would
either block on a network call or compose without them.

**Some messages should not be drafted for at all.** `src/ingest/classify.ts`
gained a third axis alongside topic and speech act: is this person **asking**,
**complaining**, or **baiting**. They need three different answers. A question
has one. A grievance needs acknowledgement first, and a reply that cheerfully
restates the returns policy to somebody on their third unanswered email makes it
worse. Bait has no correct answer at all, because answering is the thing being
solicited — so it never becomes a draft; `admit` refuses it and raises
`flag_for_human`, which is the only action this surface has. An asked accusation
("is this a scam?") is one of the commonest honest questions a buyer asks and is
`asking`; the asserted one ("this is a scam") is the verdict looking for an
argument.

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
