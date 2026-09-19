// Ask every surface at once, and let none of them hold the answer.
//
// Discover used to be one scrape, so "slow" and "the whole endpoint is slow"
// were the same thing. With five sources they are not, and the arrangement that
// follows is not optional:
//
//   · **Parallel, always.** A Whatnot read is a browser and takes seconds; a
//     Twitch read is two HTTPS calls and takes a fraction of one. Serialised,
//     every operator pays the browser.
//   · **A timeout per source, and a timeout is `unavailable`, not an error.**
//     "Whatnot did not answer in time" is a sentence an operator understands
//     and a 502 is not, and one surface being slow must never cost the four
//     that answered.
//   · **A cache per account with a short TTL.** Twitch and Reddit both meter —
//     Twitch per client id across the whole installation, Reddit per account —
//     and a Discover tab that polls is the most ordinary thing a console does.
//     Whatnot is cached for the same reason plus a harder one: each read is a
//     Chrome on a two-gigabyte box.
//
// The cache key carries the interests, because the same account asking a
// different question is a different answer, and the account id, because two
// operators must never share a page of results. A source that came back
// `unavailable` is cached for much less time than one that answered: a key that
// arrives, or a proxy that starts working, should show up in seconds rather
// than at the end of a full TTL.

import type { SurfaceId } from "../surfaces/types.js";
import { rank } from "./match.js";
import { ebayLiveSource } from "./sources/ebaylive.js";
import { RedditBudgetReserved, redditSource, type RedditSourceOpts } from "./sources/reddit.js";
import { tiktokLiveSource } from "./sources/tiktoklive.js";
import { twitchSource, type TwitchSourceOpts } from "./sources/twitch.js";
import { whatnotSource, whatnotWallOf, type WhatnotSourceOpts } from "./sources/whatnot.js";
import type {
  DiscoverHit, DiscoverResult, DiscoverSource, DiscoverSourceResult, SourceUnavailable,
} from "./types.js";

/** How long a good answer is reused. Short: an operator refreshing Discover is
 *  asking "what is live NOW", and a minute-old grid still answers that. */
const OK_TTL_MS = 60_000;
/** How long a refusal is reused. Shorter still — a key that just arrived
 *  should not be invisible for a minute. */
const FAIL_TTL_MS = 10_000;
/** Per-source budget. Past this the source is `unavailable` with the timeout as
 *  its reason and the rest of the response goes out without it. */
const DEFAULT_TIMEOUT_MS = 12_000;

export interface DiscoverDeps {
  twitch?: TwitchSourceOpts;
  reddit?: RedditSourceOpts;
  whatnot?: WhatnotSourceOpts;
  /** Replace the whole set. The suite uses this to run a source that hangs. */
  sources?: DiscoverSource[];
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Every surface Discover can ask, in the order an operator should meet them.
 *
 * `dm` and `simulated` are deliberately absent, and not because they are
 * uninteresting: neither is a PLACE to find something. The follow-up inbox is
 * built from sessions that already ran and the scripted show is one room that
 * is always there. A tab for either would be a filter over things the operator
 * already has.
 */
export function buildSources(deps: DiscoverDeps = {}): DiscoverSource[] {
  return deps.sources ?? [
    ebayLiveSource,
    whatnotSource(deps.whatnot ?? {}),
    twitchSource(deps.twitch ?? {}),
    redditSource(deps.reddit ?? {}),
    tiktokLiveSource,
  ];
}

export interface DiscoverQuery {
  accountId: string | null;
  interests: { slug: string; term: string }[];
  /** One surface, or every one of them. */
  surface?: SurfaceId | null;
  /** Hits per source. */
  limit?: number;
  /** "Everything live on this surface", which suspends the every-hit-has-a-why
   *  rule. Only meaningful with `surface`. */
  all?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface Entry { at: number; value: DiscoverSourceResult }

export class DiscoverService {
  private readonly sources: DiscoverSource[];
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, Entry>();
  /** One read per key in flight, so ten polls are one Twitch call and one
   *  browser rather than ten of each. */
  private readonly inFlight = new Map<string, Promise<DiscoverSourceResult>>();

  constructor(private readonly deps: DiscoverDeps = {}) {
    this.sources = buildSources(deps);
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Which surfaces could answer for this account right now, without asking
   *  them. `/api/home`'s `next.discoverable` is exactly this. */
  discoverable(env: NodeJS.ProcessEnv = process.env): SurfaceId[] {
    return this.sources.filter((s) => s.unavailable(env) === null).map((s) => s.surface);
  }

  /** Every source, whether or not it can answer — the surface filter chips. */
  surfaces(): SurfaceId[] {
    return this.sources.map((s) => s.surface);
  }

  async run(q: DiscoverQuery): Promise<DiscoverSourceResult[]> {
    const env = q.env ?? process.env;
    const limit = Math.min(50, Math.max(1, q.limit ?? 12));
    const wanted = q.surface ? this.sources.filter((s) => s.surface === q.surface) : this.sources;
    // "Everything live here" is only ever a question about ONE surface. Asked
    // of all of them it would be a page of strangers with no reason on any
    // card, which is the thing Discover stopped being.
    const all = Boolean(q.all && q.surface);

    return Promise.all(
      wanted.map((source) => this.one(source, { ...q, env, limit, all })),
    );
  }

  /** The whole answer, interests included. */
  async discover(
    q: DiscoverQuery & { interests: DiscoverResult["interests"] },
  ): Promise<DiscoverResult> {
    const sources = await this.run({ ...q, interests: q.interests });
    return { interests: q.interests, sources };
  }

  private key(s: DiscoverSource, q: Required<Pick<DiscoverQuery, "accountId" | "limit" | "all">> & DiscoverQuery): string {
    // The account first, so a cache read can never cross a tenant boundary by
    // accident: no other field can collide into another operator's key.
    return [
      q.accountId ?? "anon",
      s.surface,
      q.limit,
      q.all ? "all" : "why",
      q.interests.map((i) => i.slug).join(","),
    ].join("|");
  }

  private async one(
    source: DiscoverSource,
    q: DiscoverQuery & { env: NodeJS.ProcessEnv; limit: number; all: boolean },
  ): Promise<DiscoverSourceResult> {
    const key = this.key(source, q as never);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < (hit.value.unavailable ? FAIL_TTL_MS : OK_TTL_MS)) {
      return hit.value;
    }
    const running = this.inFlight.get(key);
    if (running) return running;

    const run = this.read(source, q)
      .then((value) => {
        this.cache.set(key, { at: this.now(), value });
        this.evict();
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  private async read(
    source: DiscoverSource,
    q: DiscoverQuery & { env: NodeJS.ProcessEnv; limit: number; all: boolean },
  ): Promise<DiscoverSourceResult> {
    const base = { surface: source.surface, method: source.method, hits: [] as DiscoverHit[] };
    // Asked before any work: a keyless Twitch must cost nothing to refuse.
    const refused = source.unavailable(q.env);
    if (refused) return { ...base, unavailable: refused };

    try {
      const hits = await withTimeout(
        source.fetch({
          interests: q.interests,
          limit: q.limit,
          all: q.all,
          timeoutMs: this.timeoutMs,
          env: q.env,
        }),
        this.timeoutMs,
        source.surface,
      );
      return { ...base, hits: rank(hits, { all: q.all, limit: q.limit }), unavailable: null };
    } catch (e) {
      return { ...base, unavailable: failureOf(source.surface, e, this.timeoutMs) };
    }
  }

  /** The cache is per account and per question, so it grows with operators.
   *  Bounded by age and then by count, oldest first. */
  private evict(): void {
    if (this.cache.size < 400) return;
    const rows = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of rows.slice(0, rows.length - 200)) this.cache.delete(k);
  }
}

class Timeout extends Error {}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Timeout(`${what} did not answer within ${Math.round(ms / 1000)}s`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What went wrong, in a sentence an operator can act on.
 *
 * A timeout is `unavailable`, not an error: the surface is fine, it was slow,
 * and the response already went out without it. A Cloudflare wall is reported
 * as the wall it is. Anything else keeps the platform's own message, truncated,
 * because a platform's error is usually the most specific thing anybody has.
 */
function failureOf(surface: SurfaceId, e: unknown, timeoutMs: number): SourceUnavailable {
  if (e instanceof Timeout) {
    return { reason: `${surface} did not answer within ${Math.round(timeoutMs / 1000)}s`, missing: null };
  }
  const wall = whatnotWallOf(e);
  if (wall) return wall;
  // Not a failure: a deliberate refusal to spend the headroom an open Reddit
  // watch is relying on. The operator reads it and understands it.
  if (e instanceof RedditBudgetReserved) return { reason: e.message, missing: null };
  const said = (e as Error)?.message ?? String(e);
  return { reason: said.slice(0, 220), missing: null };
}
