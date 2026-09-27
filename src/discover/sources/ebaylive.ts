// eBay Live, filtered by what the operator sells.
//
// Nothing new is read here. The house-session grid poll already runs every few
// minutes (`sellers/following.ts`), already holds every show on air with its
// seller, its audience and eBay's own tags, and already knows why it is empty
// when it is. This source is that grid asked a different question: not "who is
// live" but "who is live selling something I sell".
//
// The tags are the useful part and they are eBay's own words — "$1 Starts",
// "Pokémon", "Vintage" — which is exactly a category match. A show tagged
// Pokémon by eBay and titled "Friday night rips" matches an operator who sells
// Pokémon, and the card can say which of those two put it there.

import { cachedDiscovery } from "../../sellers/following.js";
import { whyFor } from "../match.js";
import type { DiscoverHit, DiscoverSource, SourceRequest, SourceUnavailable } from "../types.js";

/** What the grid's own refusal means to somebody looking at Discover. */
function reasonFor(reason: string): SourceUnavailable | null {
  switch (reason) {
    case "ok":
    case "stale":
      return null;
    case "no-session":
      return {
        reason: "eBay Live only streams its grid to a signed-in browser, and this server holds no session — run `npm run ebay:signin`",
        missing: null,
      };
    case "stale-session":
      return { reason: "the eBay Live session is old enough that eBay may have ended it — sign in again", missing: null };
    case "signed-out":
      return { reason: "eBay has signed this server's eBay Live session out", missing: null };
    case "pending":
      return { reason: "the eBay Live grid has not been read yet since this server started", missing: null };
    default:
      // `blocked` is the case where the session is FINE and eBay withheld the
      // grid anyway — `readSignedOut` returned false, so the header greeted us
      // by name.
      //
      // It is INTERMITTENT, and the first measurement said otherwise. On
      // 2026-09-26 the box read "Hi Karan!" and zero event links while an
      // ordinary browser on the same account showed ninety-two, and the page
      // POSTed to an Akamai Bot Manager sensor; every automated browser we had
      // read zero, headed or headless, proxied or direct. The next morning the
      // same box, headless, same session, read 144. So this is eBay's bot
      // check tightening and relaxing, not a permanent wall — which changes
      // the advice from "this path is gone" to "try again shortly".
      //
      // The old copy blamed the session and pointed at EBAY_DISCOVERY_PROXY.
      // Both are wrong here and both send the operator to re-run a sign-in that
      // was never the problem. Only the grid INDEX is gated: an individual show
      // page, the seller's listings page and everything downstream of attaching
      // still read normally, which is why the remedy is a link and not a fix.
      return {
        reason:
          "eBay served the grid page without its shows. The session is signed in and working — " +
          "this comes and goes, so a refresh in a few minutes often has it back. Pasting a " +
          "show's link attaches it either way; preparing, monitoring and reports are unaffected",
        missing: null,
      };
  }
}

export const ebayLiveSource: DiscoverSource = {
  surface: "ebaylive",
  method: "the eBay Live grid, read in a signed-in browser and matched against your interests",

  unavailable(): SourceUnavailable | null {
    return reasonFor(cachedDiscovery().reason);
  },

  async fetch(req: SourceRequest): Promise<DiscoverHit[]> {
    const { shows } = cachedDiscovery();
    return shows.map((s): DiscoverHit => ({
      surface: "ebaylive",
      // The event id, because that is what `POST /api/shows/prepare` and the
      // paste box both take. A card whose id is not the attach target is a
      // card that cannot be acted on.
      id: s.eventId,
      title: s.title,
      host: s.host || s.sellerHandle || null,
      url: s.url,
      // eBay publishes "Today, 4pm" for a scheduled show and nothing at all
      // for a live one — relative to the viewer's clock, and not an instant.
      // Null rather than a time we computed from a phrase.
      startedAt: null,
      liveNow: s.status === "live",
      // A scheduled card carries a start time where a live one carries an
      // audience; zero on a scheduled show is the absence of a number.
      viewers: s.status === "live" ? s.viewers : null,
      why: whyFor(
        [
          { text: s.title, where: "title" },
          { text: s.tags.join(" · "), where: "category" },
          { text: s.host, where: "host" },
          { text: s.sellerHandle, where: "host" },
        ],
        req.interests,
      ),
      action: "prepare",
    }));
  },
};
