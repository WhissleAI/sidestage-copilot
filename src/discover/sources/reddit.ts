// Reddit: the rooms worth watching, and the threads already asking.
//
// `RedditClient.get()` has spoken authenticated GET against `oauth.reddit.com`
// since the surface landed, paced by the rate-limit headers Reddit puts on
// every response. Two endpoints turn that into discovery and neither of them
// is new access: `/subreddits/search` names the rooms an interest belongs to,
// and `/search` finds the threads in which somebody is asking about it right
// now.
//
// Two different kinds of hit come back, and conflating them would be the
// mistake. A SUBREDDIT is a standing watch — the operator attaches it once and
// it produces drafts for months, so its action is "watch-room". A THREAD is a
// single conversation that is live for a day, and the honest action there is
// "open": go and read it. Neither is `liveNow`; Reddit has no live.
//
// Nothing here can post. That is not a property of this file — `reddit`
// declares `delivery: "draft-only"` and does not declare `post_reply`, so
// preflight refuses it twice over — but it is worth saying where a reader
// might wonder: discovery is read-only on every surface, and on this one it is
// read-only twice.

import { RedditClient, missingCredential, type RedditCreds } from "../../surfaces/reddit/api.js";
import { redditClient } from "../../surfaces/reddit/adapter.js";
import { whyFor } from "../match.js";
import type { DiscoverHit, DiscoverSource, SourceRequest, SourceUnavailable } from "../types.js";

/** Read at call time, never at import. Blank under test, mirroring `config.ts`:
 *  a suite that could reach Reddit is a suite that can get an account limited. */
function credsFrom(env: NodeJS.ProcessEnv): Partial<RedditCreds> {
  return {
    clientId: env.REDDIT_CLIENT_ID ?? "",
    clientSecret: env.REDDIT_CLIENT_SECRET ?? "",
    username: env.REDDIT_USERNAME ?? "",
    password: env.REDDIT_PASSWORD ?? "",
    userAgent: env.REDDIT_USER_AGENT ?? "",
  };
}

interface Thing<T> { kind?: string; data?: T }
interface Listing<T> { data?: { children?: Thing<T>[] } }

interface RawSubreddit {
  display_name?: string;
  display_name_prefixed?: string;
  title?: string;
  public_description?: string;
  subscribers?: number;
  over18?: boolean;
  subreddit_type?: string;
  url?: string;
}

interface RawPost {
  id?: string;
  title?: string;
  selftext?: string;
  author?: string;
  subreddit?: string;
  permalink?: string;
  created_utc?: number;
  num_comments?: number;
  over_18?: boolean;
}

export interface RedditSourceOpts {
  /** Injected so the suite exercises this against recorded response shapes.
   *  Absent, the source uses the PROCESS-WIDE client — see the note on the
   *  budget below. */
  client?: RedditClient;
  /** Subreddits to consider per interest. */
  roomsPerInterest?: number;
  /** Is a Reddit room being watched right now? A watch is the thing the
   *  operator is actually paying attention to, and discovery must not spend
   *  its headroom. Supplied by the route from the show registry. */
  activeWatch?: () => boolean;
}

/**
 * Requests kept back for an active watch.
 *
 * Reddit's OAuth window is 600 requests per 10 minutes for the ACCOUNT, and a
 * watch spends it continuously while a room is open. One discovery read costs
 * two requests per interest, so a handful of interests is a dozen — nothing
 * against a full window and everything against the last of one. When a room is
 * being watched and the remaining budget is under this, discovery says so and
 * spends nothing: a subreddit search is worth less than the drafts the
 * operator is waiting on.
 */
const WATCH_RESERVE = 60;

/** The refusal that fact deserves — a reason, not a failure. */
export class RedditBudgetReserved extends Error {
  constructor(readonly remaining: number) {
    super(
      `Reddit's rate budget is reserved for the room you are watching (${remaining} requests left in this window)`,
    );
    this.name = "RedditBudgetReserved";
  }
}

export function redditSource(opts: RedditSourceOpts = {}): DiscoverSource {
  return {
    surface: "reddit",
    method: "Reddit search — subreddits for each interest, and the threads in them asking about it",

    unavailable(env): SourceUnavailable | null {
      if (opts.client?.configured) return null;
      const missing = missingCredential(credsFrom(env));
      return missing
        ? { reason: `Reddit needs ${missing} on this server — the script application is not configured`, missing }
        : null;
    },

    async fetch(req: SourceRequest): Promise<DiscoverHit[]> {
      // The PROCESS-WIDE client, deliberately. Reddit meters per account, so a
      // client of our own would be the same budget with two halves that cannot
      // see each other — and the pacing in `RedditClient.get` only works when
      // every request goes through one instance.
      const client = opts.client ?? redditClient();
      const rate = client.rateState;
      if (opts.activeWatch?.() && rate && rate.remaining <= WATCH_RESERVE) {
        throw new RedditBudgetReserved(rate.remaining);
      }
      // A term is the query. With no interests there is nothing to search for:
      // Reddit has no "everything live", so `all` cannot rescue an empty set
      // the way a grid could, and inventing a query would put a stranger's
      // subreddit in front of the operator with no reason attached.
      if (!req.interests.length) return [];

      const perInterest = opts.roomsPerInterest ?? 4;
      const results = await Promise.all(
        req.interests.map(async (i) => {
          const [rooms, threads] = await Promise.all([
            client
              .get<Listing<RawSubreddit>>("/subreddits/search", { q: i.term, limit: perInterest, include_over_18: "off" })
              .catch(() => null),
            client
              .get<Listing<RawPost>>("/search", { q: i.term, sort: "new", t: "week", limit: perInterest, include_over_18: "off", type: "link" })
              .catch(() => null),
          ]);
          return { interest: i, rooms, threads };
        }),
      );

      const hits: DiscoverHit[] = [];
      const seen = new Set<string>();

      for (const { rooms, threads } of results) {
        for (const child of rooms?.data?.children ?? []) {
          const r = child.data;
          const name = r?.display_name;
          // Private and restricted subreddits are rooms nobody can watch, and
          // over-18 rooms are not a place to put a seller's copilot unasked.
          if (!name || r?.over18 || (r.subreddit_type && r.subreddit_type !== "public")) continue;
          const id = `r/${name}`;
          if (seen.has(id)) continue;
          seen.add(id);
          hits.push({
            surface: "reddit",
            // Exactly what the paste box takes — `redditAdapter.parseTarget`
            // accepts `r/<name>` and nothing looser.
            id,
            title: r.title?.trim() || id,
            // A subreddit has no host. Not "the moderators", not the name
            // again — nobody is running it in the sense this field means.
            host: null,
            url: `https://www.reddit.com/r/${name}/`,
            startedAt: null,
            liveNow: false,
            // Subscribers are not viewers. A room with 400k subscribers has no
            // measured audience right now and pretending otherwise would sort
            // a dead subreddit above a busy thread.
            viewers: null,
            why: whyFor(
              [
                { text: name, where: "room" },
                { text: r.title, where: "title" },
                { text: r.public_description, where: "body" },
              ],
              req.interests,
            ),
            action: "watch-room",
          });
        }

        for (const child of threads?.data?.children ?? []) {
          const p = child.data;
          if (!p?.id || p.over_18) continue;
          const id = `t3_${p.id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          hits.push({
            surface: "reddit",
            id,
            title: p.title?.trim() || id,
            host: p.author ? `u/${p.author}` : null,
            url: p.permalink ? `https://www.reddit.com${p.permalink}` : `https://redd.it/${p.id}`,
            // The moment it was posted, which is the only time Reddit gives and
            // is genuinely when this conversation started.
            startedAt: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
            liveNow: false,
            viewers: null,
            why: whyFor(
              [
                { text: p.title, where: "title" },
                { text: p.subreddit ? `r/${p.subreddit}` : "", where: "room" },
                { text: (p.selftext ?? "").slice(0, 600), where: "body" },
              ],
              req.interests,
            ),
            action: "open",
          });
        }
      }

      return hits;
    },
  };
}
