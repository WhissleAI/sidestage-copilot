// TikTok Live has no index anybody can read, and that is a different fact from
// the switch.
//
// `TIKTOK_LIVE_ENABLED` is about ATTACHING: TikTok answers an unattended
// browser grinding against its challenge with a restriction on the seller's own
// account, so a human decides to run it. Turning that switch on would not make
// a single room discoverable, because there is nothing to discover FROM —
// TikTok publishes no browsable index of live shopping rooms comparable to
// eBay's grid or Whatnot's search, the "LIVE" feed is personalised behind a
// signed-in session, and the Research API that does exist is for approved
// academic work and does not carry live commerce.
//
// Keeping the two apart matters to the operator: "turn on the switch" and
// "there is nothing here to read" have entirely different next steps, and a
// source that named the variable would send somebody to set a switch that
// changes nothing about this tab. So `missing` is null and the sentence says
// what is actually true.
//
// The source still EXISTS, with an empty hit list. A surface that vanishes from
// Discover reads as a broken product; a surface that says why it is quiet reads
// as a door the platform never opened, which is what this is.

import type { DiscoverSource, SourceRequest, SourceUnavailable } from "../types.js";

export const tiktokLiveSource: DiscoverSource = {
  surface: "tiktoklive",
  method: "none — TikTok publishes no index of live rooms that can be read",

  unavailable(): SourceUnavailable {
    return {
      reason:
        "TikTok has no public index of live rooms to search, so discovery is not available there — " +
        "paste a room's link to watch one (that is what TIKTOK_LIVE_ENABLED governs)",
      // Not TIKTOK_LIVE_ENABLED. Setting it would not produce one hit here.
      missing: null,
    };
  },

  // Takes the request it never reads, because the type is the contract every
  // other source signs: a source that can never answer is still a source.
  async fetch(_req: SourceRequest): Promise<[]> {
    return [];
  },
};
