// A surface is WHERE a conversation happens.
//
// Until now there was one — an eBay Live show — and everything the copilot knew
// about it was spread across the places that happened to need it: the watcher
// knew how to read it, `ShowRuntime` knew how to start it, the guards assumed a
// catalog stood behind every reply, and preflight assumed every action was a
// listing write. None of that was wrong; all of it was eBay Live wearing the
// clothes of a general system.
//
// The cost showed up the first time a second surface was considered. Answering
// "can we reply in a subreddit?" meant reading five files, and the answer lived
// in none of them. So every surface now answers the same five questions in one
// place — how fast it moves, whether we may deliver a reply or only draft one,
// whether we can see and hear the operator, which actions exist there, and what
// grounds a claim — and the guards, the console and preflight read the answers
// instead of guessing.
//
// Adding a surface is: a capability row, a `parseTarget`, an `open`. Nothing in
// the reply path changes.

import type { ActionKind } from "../domain/types.js";
import type { CorpusKind } from "../retrieval/corpus.js";
import type { Fact } from "../retrieval/facts.js";
import type { ThreadContext } from "../ingest/threadContext.js";

export type SurfaceId =
  | "simulated" | "ebaylive" | "whatnot" | "tiktoklive"   // live commerce
  | "twitch" | "youtubelive"                              // live creator
  | "reddit" | "dm";                                      // asynchronous

export type Tempo = "live" | "async";

/** What a surface can DO, so the UI and the guards stop guessing. */
export interface SurfaceCapabilities {
  tempo: Tempo;
  /**
   * Can a reply be delivered BY US, or only drafted for a human to send?
   *
   * A contract, not a label. `api` is a claim that a code path exists which
   * puts our text in front of the person who asked — today that is exactly one
   * mechanism, Twitch's `post_reply` action. Anything else is `draft-only`, and
   * the server enforces it: `preflight` refuses `post_reply`, the rooms route
   * refuses to store a posting switch, `Pipeline.send` refuses to record a
   * delivery, and the ladder refuses to auto-send. Declaring `api` for a
   * surface that has no such path is how the console spent months toasting
   * "Reply sent to @buyer" for replies no buyer ever received.
   */
  delivery: "api" | "draft-only";
  /** Does this surface carry the operator's audio / video? */
  perception: { audio: boolean; video: boolean };
  /** Which action kinds this surface supports at all (a subset of ActionKind). */
  actions: readonly ActionKind[];
  /** Which corpora ground a reply here (see retrieval/corpus.ts). */
  corpora: readonly CorpusKind[];
  /** Rules the COMMUNITY imposes, retrieved per room/subreddit/channel. */
  communityRules: boolean;
}

/** One live or polled connection to a surface. Replaces the ad-hoc watcher wiring. */
export interface SurfaceAdapter {
  readonly id: SurfaceId;
  readonly capabilities: SurfaceCapabilities;
  /** Human label for the console: "eBay Live", "Twitch", "Reddit". */
  readonly label: string;
  /** Resolve a pasted link / handle / id into a session target, or null. */
  parseTarget(input: string): SurfaceTarget | null;
  /** Start watching. Emits through the same callbacks the eBay watcher already uses. */
  open(t: SurfaceTarget, ev: SurfaceEvents): Promise<SurfaceConnection>;
  /**
   * What this room FORBIDS — the constraints every draft written here is
   * checked against, as facts with `corpus: "community"`.
   *
   * Deliberately not a retrieval. `GuardInput.community` used to be a filter
   * over the retriever's own results, and the retriever's index is the seller's
   * listings and policies — so a subreddit's rules had no route into it and
   * `communityRuleGuard` returned n/a on every real watch, however many rules
   * had been fetched. A rule is not retrievable grounding: it is never an
   * answer to the question, it must not be ranked against the question, and it
   * has to be in force whether or not it happens to resemble what was asked.
   * It is a per-room input of its own, and this is where it comes from.
   *
   * Synchronous and cache-only, because it is called on the reply path: an
   * adapter answers with what it already knows and warms anything it does not
   * in the background, so a draft is never delayed by a rules fetch and never
   * composed without rules that were already in hand.
   *
   * @param t    the session's target — the room it was attached to.
   * @param room the room THIS message was written in, when the surface said.
   *   A profile watch spans rooms, and the rules that bind a reply are the
   *   rules of the room the reply lands in, not of the watch.
   */
  constraintsFor?(t: SurfaceTarget, room?: string | null): Fact[];
  /**
   * The conversation ABOVE this message — the opening post, then the branch
   * down to it, oldest first.
   *
   * The asynchronous counterpart to `ShowContextEngine`. "The last ninety
   * seconds" is an empty window in a subreddit: a comment sits under a post and
   * a branch of replies written over three days by different people, and a
   * draft written without them answers the words instead of the conversation —
   * which reads, correctly, as a bot.
   *
   * Asynchronous because it is a fetch, and on the reply path: a surface that
   * cannot rebuild a branch cheaply should return null rather than make a buyer
   * wait. A failure is not fatal — the caller composes without it.
   *
   * `rules` are passed in rather than fetched here so that the thread the
   * composer sees and the constraints the guards enforce are the same set,
   * from one read.
   */
  threadFor?(
    t: SurfaceTarget,
    m: { id: string; threadId?: string; parentId?: string; room?: string },
    rules: Fact[],
  ): Promise<ThreadContext | null>;
}

export interface SurfaceTarget {
  /** Stable id within the surface: an eBay event id, a Twitch channel, a subreddit or thread. */
  externalId: string;
  /** Display title when the adapter already knows it. */
  title?: string;
  /** The operator or author whose room this is. */
  handle?: string;
  /** Free-form, adapter-specific (a thread permalink, a Whatnot lot id). */
  meta?: Record<string, string>;
}

export interface SurfaceEvents {
  onStatus?(s: { connected: boolean; detail: string }): void;
  onTitle?(title: string): void;
  /** A buyer/viewer/commenter message. `threadId` groups an async conversation. */
  onMessage?(m: {
    id: string; author: string; text: string; at?: string;
    threadId?: string; parentId?: string; meta?: Record<string, unknown>;
  }): void;
  /** Something on sale / on screen changed (a lot, a game, a pinned item). */
  onItem?(i: {
    externalRef: string; title: string; priceCents?: number;
    qty?: number; soldOut?: boolean; url?: string;
    /** Surface-specific truth the five common fields cannot carry — an eBay
     *  lot's high bidder and countdown, a Whatnot lot id. Dropping it would
     *  have changed what eBay Live records; see ebaylive/adapter.ts. */
    meta?: Record<string, unknown>;
  }): void;
  onViewers?(n: number): void;
  onEnded?(why: string): void;
  /**
   * The watcher has stopped trying, and the room did not end.
   *
   * Distinct from `onEnded` on purpose, and the distinction is the whole
   * point: `onEnded` means the show is over and the session should be
   * finished; this means WE gave up while the show is very probably still
   * running. Conflating them would write a report for a show that is still on
   * air. Keeping them apart is what lets "it stopped answering mid-show"
   * become a row rather than a conversation with the seller.
   */
  onGaveUp?(g: { reason: string; detail: string; reloads?: number; quietMs?: number }): void;
}

export interface SurfaceConnection { stop(): Promise<void>; }

/**
 * The surface exists, we know how to talk to it, and we cannot right now.
 *
 * A typed error rather than a generic one because the operator's next move
 * depends entirely on WHICH variable is missing, and a 500 that says "failed to
 * open twitch" sends them to the logs for something the attach route could have
 * told them in the response. The route turns this into a 409 naming the
 * variable (see docs/SURFACES.md).
 */
export class SurfaceUnavailable extends Error {
  constructor(
    readonly surface: SurfaceId,
    message: string,
    /** The environment variable that would fix it, when there is one. */
    readonly missing?: string,
  ) {
    super(message);
    this.name = "SurfaceUnavailable";
  }
}

// ── the capability table ──────────────────────────────────────────────────────
//
// Static data, deliberately NOT read off the adapter registry. Guards and
// preflight ask "what can this surface do" on the hot path and on rows loaded
// from the database, long after — and sometimes before — the adapter that
// serves the surface was registered. A safety check whose answer depends on
// module import order is not a safety check.
//
// An adapter declares these same objects as its `capabilities`, so the table
// and the adapter cannot drift.

/** eBay Live as it behaves today, byte for byte. Every field here is a
 *  description of existing behaviour, not a new decision. */
export const EBAYLIVE_CAPABILITIES: SurfaceCapabilities = {
  tempo: "live",
  // `draft-only`, and it always was.
  //
  // eBay publishes no chat-post API for a Live event — that absence is the
  // entire reason this surface is read by a scraped browser session rather
  // than a client. `docs/EBAY_LIVE.md` has said "Replies are not delivered"
  // since the surface landed, and `docs/PRD.md` listed delivery as ✗. Only
  // this row said otherwise, and because the console renders its Send button
  // and its "Reply sent to @buyer" toast off this row, the reference
  // surface's most-used button reported a success that never happened and the
  // answered-rate metric counted replies nobody received.
  //
  // What actually happens is worth stating, because it is real and it is what
  // the product is for: the reply is composed against the seller's catalog,
  // checked by eight guards, recorded, audited — and a human posts it.
  delivery: "draft-only",
  perception: { audio: true, video: true },
  actions: ["push_listing", "swap_pinned", "markdown_price", "adjust_stock", "end_listing"],
  corpora: ["listing", "policy", "qa", "community"],
  // eBay Live has no per-room rule corpus to retrieve. Set false so
  // `communityRuleGuard` returns n/a here and the reference surface is
  // untouched by a guard written for subreddits.
  communityRules: false,
};

/** The scripted show. Identical to eBay Live by design: the simulated source
 *  exists to exercise the live-commerce path, so a capability that differed
 *  would make the demo test something production does not do. */
export const SIMULATED_CAPABILITIES: SurfaceCapabilities = {
  ...EBAYLIVE_CAPABILITIES,
};

/**
 * Whatnot and TikTok Live: live commerce read through a browser, and nothing
 * more. The difference from eBay Live is not the tempo, it is what we HOLD.
 *
 * · `delivery: "draft-only"` — neither platform exposes a way for us to post
 *   into a room's chat. Automating a keystroke into the seller's own browser
 *   would be a way, and it is the kind of way that gets an account banned, so
 *   the reply is written for a human to send and the code cannot be configured
 *   out of that.
 * · `perception: false` — we read the DOM, not the stream. The audio and video
 *   are in a player we never decode, so the host-signal work (pace, dead air,
 *   what the host just said) has nothing to run on here and must not be
 *   offered as if it did.
 * · The five listing writes are gone. Every one of them ends at a marketplace
 *   we hold seller credentials for; we hold none for Whatnot or TikTok, so a
 *   markdown here would change OUR row while the platform kept selling at the
 *   old price — a write that reports success and changes nothing a buyer can
 *   see. What is left is the two kinds that only ever write to records we own:
 *   marking a moment, and handing a question to the human.
 * · `communityRules: false` — a room's rules on these platforms are said out
 *   loud by the host, not published anywhere we can retrieve per room.
 */
export const SCRAPED_LIVE_CAPABILITIES: SurfaceCapabilities = {
  tempo: "live",
  delivery: "draft-only",
  perception: { audio: false, video: false },
  actions: ["mark_highlight", "flag_for_human"],
  corpora: ["listing", "policy", "qa"],
  communityRules: false,
};

export const SURFACE_CAPABILITIES: Record<SurfaceId, SurfaceCapabilities> = {
  simulated: SIMULATED_CAPABILITIES,
  ebaylive: EBAYLIVE_CAPABILITIES,
  whatnot: SCRAPED_LIVE_CAPABILITIES,
  tiktoklive: SCRAPED_LIVE_CAPABILITIES,
  twitch: {
    tempo: "live",
    delivery: "api",
    perception: { audio: true, video: true },
    actions: ["create_clip", "mark_highlight", "run_poll", "shoutout", "pin_message", "post_reply"],
    corpora: ["schedule", "sponsor", "product", "qa", "community"],
    communityRules: true,
  },
  youtubelive: {
    tempo: "live",
    delivery: "api",
    perception: { audio: true, video: true },
    actions: ["mark_highlight", "pin_message", "post_reply"],
    corpora: ["schedule", "sponsor", "product", "qa", "community"],
    communityRules: true,
  },
  reddit: {
    tempo: "async",
    // draft-only IN CODE, not by configuration. A copilot that can post to a
    // subreddit on its own is one bug away from being the vendor spam every
    // subreddit has a rule against, and no setting should be able to grant it.
    delivery: "draft-only",
    perception: { audio: false, video: false },
    // `post_reply` is absent deliberately, and its absence is a second lock on
    // the same door: `delivery` already refuses it, and an action a surface
    // does not declare is refused by preflight before delivery is even read.
    // Undisclosed automation replying as a person breaks Reddit's own rules,
    // so the only thing this surface hands a human is a draft — and
    // `flag_for_human` is how anything that should not be drafted at all
    // (bait, a moderator matter) reaches one.
    actions: ["flag_for_human"],
    corpora: ["product", "policy", "qa", "community"],
    communityRules: true,
  },
  dm: {
    tempo: "async",
    delivery: "draft-only",
    perception: { audio: false, video: false },
    actions: ["send_dm", "flag_for_human"],
    corpora: ["listing", "policy", "product", "qa"],
    communityRules: false,
  },
};

/** What a surface can do. Unknown ids answer as live commerce, which is what
 *  every row written before this column existed actually was. */
export function capabilitiesOf(id: SurfaceId | string | null | undefined): SurfaceCapabilities {
  return SURFACE_CAPABILITIES[(id ?? "ebaylive") as SurfaceId] ?? EBAYLIVE_CAPABILITIES;
}

/** Does this surface have anything of this kind to be grounded in? */
export function hasCorpus(caps: SurfaceCapabilities | null | undefined, kind: CorpusKind): boolean {
  return (caps ?? EBAYLIVE_CAPABILITIES).corpora.includes(kind);
}
