// Twitch, through the front door nobody tried.
//
// The comment this work replaced said the other surfaces had "discovery pages
// behind a login or an app review". For Twitch that was simply not true:
// `TwitchClient.appToken()` has existed in this repo since the surface landed,
// an app access token mints from the client id and secret alone, and Helix's
// `GET /streams` and `GET /search/categories` both accept one. No user signs
// in, nobody consents, no review is filed. Twitch was discoverable the day the
// key was set and Discover said it was not.
//
// Two calls, in this order, and the order is the whole design:
//
//   1. `search/categories` once per interest. Twitch's categories ARE the
//      vocabulary of what a stream is about — "Pokémon Trading Card Game",
//      "Sneakers", "Retro" — and they are how a stream titled "friday night
//      rips" can still be known to be about cards.
//   2. `streams` ONCE, with every category id found, because Helix takes up to
//      a hundred `game_id` parameters in one request. A handful of interests
//      therefore costs interests+1 requests rather than two apiece, which
//      matters: Twitch meters an app token per client id across the whole
//      installation, not per account.
//
// The bot's refresh token is not part of this. `requireTwitchCreds` demands it
// because everything the surface does while ATTACHED acts as an account; a
// read of what is live acts as nobody. So the refusal here names only the two
// variables that are genuinely required, and spells them the way
// `SurfaceUnavailable` spells them.

import { TwitchApi, missingTwitchKey, type TwitchCategory, type TwitchLiveStream } from "../../surfaces/twitch/api.js";
import { whyFor } from "../match.js";
import type { DiscoverHit, DiscoverSource, SourceRequest, SourceUnavailable, Why } from "../types.js";

/** Read at call time, never at import: an operator who sets a key and restarts
 *  expects the next request to see it. Blank under test, as `config.ts` is, so
 *  the suite cannot inherit a developer's working application. */
function credsFrom(env: NodeJS.ProcessEnv): { clientId: string; clientSecret: string } {
  const read = (name: string) => (env.NODE_ENV === "test" ? env[name] ?? "" : env[name] ?? "");
  return { clientId: read("TWITCH_CLIENT_ID"), clientSecret: read("TWITCH_CLIENT_SECRET") };
}

/** Which variable is missing, spelled as the attach refusal spells it. The
 *  refresh token is passed satisfied: reading what is live never acts as the
 *  bot, so naming it here would send an operator to fetch a token they do not
 *  need for this. */
export function missingForDiscovery(env: NodeJS.ProcessEnv): string | null {
  const { clientId, clientSecret } = credsFrom(env);
  return missingTwitchKey({ clientId, clientSecret, botRefreshToken: "app-token-only" });
}

/** Injected by the suite, which has no key and must not reach Twitch. */
export interface TwitchSourceOpts {
  fetcher?: typeof fetch;
  /** How many categories a single interest may resolve to. */
  categoriesPerInterest?: number;
}

export function twitchSource(opts: TwitchSourceOpts = {}): DiscoverSource {
  return {
    surface: "twitch",
    method: "Twitch Helix — your interests resolved to categories, then the live streams in them",

    unavailable(env): SourceUnavailable | null {
      const missing = missingForDiscovery(env);
      return missing
        ? { reason: `Twitch needs ${missing} on this server — the adapter is here, the application key is not`, missing }
        : null;
    },

    async fetch(req: SourceRequest): Promise<DiscoverHit[]> {
      const { clientId, clientSecret } = credsFrom(req.env);
      const api = new TwitchApi(
        { clientId, clientSecret, botRefreshToken: "" },
        opts.fetcher ? { fetcher: opts.fetcher } : {},
      );

      // One category search per interest, in parallel — they are independent
      // and the whole source is already under a timeout.
      const perInterest = opts.categoriesPerInterest ?? 3;
      const found = await Promise.all(
        req.interests.map(async (i) => {
          const cats = await api.searchCategories(i.term, perInterest).catch(() => [] as TwitchCategory[]);
          return cats.map((c) => ({ ...c, from: i }));
        }),
      );
      const categories = found.flat();
      /** game_id → the categories it came from, so a stream in it can say
       *  WHICH interest reached it even though the title never mentions one. */
      const byGameId = new Map<string, { name: string; term: string; slug: string }[]>();
      for (const c of categories) {
        const list = byGameId.get(c.id) ?? [];
        if (!list.some((x) => x.slug === c.from.slug)) {
          list.push({ name: c.name, term: c.from.term, slug: c.from.slug });
        }
        byGameId.set(c.id, list);
      }

      const gameIds = [...byGameId.keys()];
      // No interest resolved to a category and the caller did not ask for the
      // whole front page: an unfiltered `/streams` here would return the
      // biggest channels on Twitch, none of which could say why they were on
      // screen. Spend nothing.
      if (!gameIds.length && !req.all) return [];

      const streams = await api.liveStreams({
        ...(gameIds.length ? { gameIds } : {}),
        limit: Math.min(100, Math.max(20, req.limit * 4)),
      });

      return streams.map((s) => toHit(s, req, byGameId));
    },
  };
}

function toHit(
  s: TwitchLiveStream,
  req: SourceRequest,
  byGameId: Map<string, { name: string; term: string; slug: string }[]>,
): DiscoverHit {
  // What the title and the streamer's name say, plus the reason Twitch handed
  // this row over at all: it is in a category one of the interests resolved to.
  const why: Why[] = whyFor(
    [
      { text: s.title, where: "title" },
      { text: s.gameName, where: "category" },
      { text: s.userName, where: "host" },
      { text: s.userLogin, where: "host" },
    ],
    req.interests,
  );
  for (const c of byGameId.get(s.gameId) ?? []) {
    if (!why.some((w) => w.term === c.term)) why.push({ term: c.term, where: "category" });
  }

  return {
    surface: "twitch",
    // The login, because that is what the paste box and `parseTarget` take.
    id: s.userLogin || s.userId,
    title: s.title || s.userName,
    host: s.userName || s.userLogin || null,
    url: `https://www.twitch.tv/${s.userLogin || s.userId}`,
    startedAt: s.startedAt || null,
    liveNow: true,
    viewers: s.viewerCount,
    why,
    action: "attach",
  };
}
