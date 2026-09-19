// One question, asked of every surface, answered in one shape.
//
// Discover used to be an eBay Live noun: a grid of shows, scraped, with the
// other six surfaces absent and a comment explaining that their discovery pages
// were "behind a login or an app review". That is true of Whatnot and TikTok
// and plainly wrong about the two with public APIs — an app token lists live
// Twitch streams without a single user signing in, and Reddit's script grant
// searches subreddits and threads. The door was open; nobody tried it.
//
// So a discovery source is a small, uniform contract, and the honesty rules
// live in the types rather than in each surface's good intentions:
//
//   · `why` is REQUIRED and non-opaque. A card that cannot say which of the
//     operator's interests put it on screen, and where the match was, does not
//     belong on screen. The one exception is a caller explicitly asking for
//     everything live on one surface, which is a different question.
//   · `viewers`, `startedAt` and `host` are nullable and must be null when the
//     source did not say. A fabricated audience is worse than a blank one: the
//     operator sorts by it.
//   · A surface that cannot answer returns a source with `unavailable` and NO
//     hits — never an omitted source. A missing tab reads as a broken product
//     rather than as a door the platform never opened, and `missing` names the
//     environment variable exactly as `SurfaceUnavailable` spells it so the
//     operator reads one string here and in the surface table.

import type { SurfaceId } from "../surfaces/types.js";

/** Where an interest was found. Ordered by how much it means — see `WHERE_WEIGHT`. */
export type MatchWhere = "title" | "category" | "host" | "room" | "body";

/** Why this is in front of the operator. Never a score. */
export interface Why {
  term: string;
  where: MatchWhere;
}

export interface DiscoverHit {
  surface: SurfaceId;
  /** Stable per surface, and the ATTACH TARGET: whatever the paste box would
   *  accept for this thing. An id a client cannot act on is a card that lies. */
  id: string;
  title: string;
  host: string | null;
  url: string;
  startedAt: string | null;
  liveNow: boolean;
  viewers: number | null;
  why: Why[];
  /** What the operator can do with it, given the surface. */
  action: "prepare" | "attach" | "watch-room" | "open";
}

export interface SourceUnavailable {
  /** One plain sentence an operator can act on. */
  reason: string;
  /** The environment variable that would fix it, spelled as the refusal spells
   *  it. Null where the gap is not a variable — a timeout, a platform with no
   *  index to read. */
  missing: string | null;
}

export interface DiscoverSourceResult {
  surface: SurfaceId;
  /** One plain sentence: how this list was obtained. The operator should be
   *  able to tell an API from a scrape without reading the code. */
  method: string;
  hits: DiscoverHit[];
  unavailable: SourceUnavailable | null;
}

/** Everything a source needs to answer. */
export interface SourceRequest {
  /** The operator's terms, best first. Empty when they have no catalog. */
  interests: { slug: string; term: string }[];
  /** Hits to return at most. */
  limit: number;
  /**
   * The caller asked for everything live on this surface, so hits with no `why`
   * are allowed. Only ever true when a surface was named explicitly: "show me
   * the whole grid" is a different question from "what should I look at".
   */
  all: boolean;
  /** How long this source may take before it is an `unavailable` with a
   *  timeout for a reason. */
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

/** A surface that can be asked. `available` answers without doing any work, so
 *  `/api/home` can say how many surfaces Discover can read without reading them. */
export interface DiscoverSource {
  surface: SurfaceId;
  /** One sentence, for the card's footer. */
  method: string;
  /** Can this source answer for this process right now? Null when it can;
   *  otherwise the refusal, ready to be returned as-is. */
  unavailable(env: NodeJS.ProcessEnv): SourceUnavailable | null;
  fetch(req: SourceRequest): Promise<DiscoverHit[]>;
}

/** The whole answer. */
export interface DiscoverResult {
  interests: { slug: string; term: string; origin: "derived" | "own"; pinned: boolean; weight: number }[];
  sources: DiscoverSourceResult[];
}
