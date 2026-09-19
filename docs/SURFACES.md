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
| Whatnot | none — real Chrome via `openContext`, reusing `EBAY_DISCOVERY_PROXY` | works, subject to Cloudflare; a challenge is reported by name |
| TikTok Live | `TIKTOK_LIVE_ENABLED` — a person deciding to run it, not a credential | registered and resolvable; `open()` refuses, naming the switch |

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
## Whatnot and TikTok Live are read, not spoken to

Both are the eBay Live problem again: no public API for the chat of a room, a
React app that renders it, and a browser as the only reader. What they are not
is eBay Live's *position* — we hold no seller credentials on either platform,
and neither exposes a way for us to post into a room.

So both declare `SCRAPED_LIVE_CAPABILITIES`: live tempo, `draft-only` delivery,
`perception: false` (we read the DOM; the audio and video are in a player we
never decode, so the host-signal work has nothing to run on here), and only two
actions — `mark_highlight` and `flag_for_human`. The five listing writes are
gone on purpose. Every one of them ends at a marketplace we hold credentials
for, and a markdown here would change our row while the platform kept selling
at the old price: a write that reports success and changes nothing a buyer can
see.

### One loop, two selector tables

`src/surfaces/scrapeWatcher.ts` is the poll loop — backlog suppression, dedupe,
the silence watchdog, the reload, the crashed-renderer recovery — and it is
shared. The constants in it are the eBay watcher's, re-declared with their
reasoning because that file keeps them private and is frozen. Each surface
contributes a `ScrapeSpec`: a URL, a selector table, and how to read its
numbers.

`src/surfaces/scrapeDom.ts` holds the one thing that reads a page. It is handed
to `page.evaluate`, which serialises it with `toString()`, so it closes over
nothing and takes its selectors as data — which is also what lets the test run
it outside a browser.

### The fixtures are the contract

`test/fixtures/*.html` are hand-trimmed pages of the shape each selector table
assumes, not captures of real rooms. Two reasons: a capture would put a real
seller's chat in the repo, and neither page can be re-captured on demand —
Whatnot answered a plain GET with a Cloudflare challenge (403, `<title>Just a
moment...</title>`, measured 2026-09-18) and TikTok Live is off by default.

When a platform changes its markup, change the fixture and the selectors in the
same commit. The suite then tells you whether the extractor still works,
instead of a live room at 9pm on a Friday.

`test/domlite.ts` is the DOM those tests run against: enough of `Element` to
satisfy the extractor, over an HTML string, no dependency and no browser.
Checked against real Chromium on 2026-09-18 — identical output, field for
field, on all four fixtures.

### A wall is a named failure, not a quiet room

Both extractors look for the sign-in wall and the bot challenge BEFORE they
look for chat, because a challenge page has a perfectly good DOM with no
messages in it. Without the check, the busiest room in the world reads as
silent and the operator watches a feed that was never going to move. The
watchdog also declines to reload while a wall is up: a reload cannot answer a
challenge, it can only ask for one again.

### TikTok Live ships off

`TIKTOK_LIVE_ENABLED` is unset by default and `open()` refuses while it is,
naming the variable the way a missing key does. Not because the adapter is
unfinished — because TikTok can drop any session into a verification challenge
at any moment, including one that has been reading a room for an hour, and the
browser on the other side of that challenge belongs to a real seller's account.
A retry loop against that page is how a temporary challenge becomes a
restricted account. The switch is a person saying "I am here, run it".

It is still registered, still resolves a pasted link, and still reports its
capabilities: a surface that vanished from the UI when its switch was off would
leave the console unable to say why it cannot run.
## Twitch: chat in, clips and polls out

`src/surfaces/twitch/` is the first surface that sells nothing, which is the
whole reason the abstraction exists. There is no catalog, so no price can be
stale and no lot can run out — the listing guards find no `listing` corpus and
return `n/a` on their own. What grounds an answer instead is a schedule, a
sponsor brief and the channel's own chat rules (`corpus.ts`), and the actions
are the ones a creator actually takes: a clip, a stream marker, a poll, a
shoutout, an announcement, a reply.

| file | what it is |
|---|---|
| `adapter.ts` | `parseTarget` for a link, an `@handle` or a bare login; `open()` starts chat |
| `chat.ts` | EventSub over WebSocket (`channel.chat.message`), IRC over TLS behind `CHAT_TRANSPORT` |
| `api.ts` | the six Helix calls the actions need, plus the app and user grants |
| `actions.ts` | a `MarketplaceAdapter` for the creator kinds — the existing executor runs unchanged |
| `corpus.ts` | schedule, sponsor and channel rules as facts with the right `CorpusKind` |
| `oauth.ts` | the consent round trip, so nobody pastes a refresh token |

**EventSub is primary; IRC is the documented fallback.** IRC still works and is
frozen: the structured event carries typed fragments instead of a tag soup, it
carries the same `message_id` that `DELETE /helix/moderation/chat` takes — the
only reason a posted reply is undoable at all — and it authenticates with the
same user token as every write. IRC survives for the case EventSub cannot
serve: a websocket session caps at 300 subscriptions and one chat read is one
subscription, so a deployment watching hundreds of channels from one process
runs out where an IRC connection just joins another channel. Nobody is watching
hundreds of channels yet, so the switch is a constant rather than a setting.

**Twitch is registered LAST** (`registry.ts`). It is the only adapter that
accepts a bare word, and `demo` is both a valid Twitch login and how an operator
asks for the scripted show. Narrower claims resolve first.

**The undo is not uniform, and the refusal says so.** A poll is archived and a
posted message is deleted, so those two roll back properly. Helix lists exactly
two clip endpoints, Create and Get — there is no delete — and a stream marker,
a shoutout and an announcement cannot be withdrawn either. `compensate` throws
with the clip URL and where to go, rather than reporting a rollback it did not
perform. The executor marks such an action `failed` while the write stands;
distinguishing "irreversible" from "failed to reverse" on the card needs a flag
on the action row, and is Wave C.

**`pin_message` posts an announcement.** Helix has no pin. An announcement is
the closest a bot gets: the line is highlighted and stays legible in the
scrollback, which is what "pin this" is asking for. The kind is named after the
intent and the call after the platform.

**A sponsor's prohibitions are emitted as constraints.** `sponsorGuard` only
checks that a sponsored claim CITES an approved fact, so a draft that cites the
brief correctly and then calls the board waterproof would pass it. Each
`mustNotClaim` entry is therefore also emitted as a `community` fact phrased as
a quoted prohibition, which is the corpus the chain treats as a rule rather than
an answer. The label names the sponsor, so "says who" still answers correctly.

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
