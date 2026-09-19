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

export type SurfaceId =
  | "simulated" | "ebaylive" | "whatnot" | "tiktoklive"   // live commerce
  | "twitch" | "youtubelive"                              // live creator
  | "reddit" | "dm";                                      // asynchronous

export type Tempo = "live" | "async";

/** What a surface can DO, so the UI and the guards stop guessing. */
export interface SurfaceCapabilities {
  tempo: Tempo;
  /** Can a reply be delivered by us, or only drafted for a human to send? */
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
  delivery: "api",
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
