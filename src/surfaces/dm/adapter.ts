// The follow-up inbox, as a surface.
//
// Every other surface in this build is a place a conversation is happening
// right now. This one is a place a conversation ALREADY happened and stopped.
//
// The observation behind it is in the numbers a finished show leaves behind.
// On `ebay_47tK1SX0VsiHEXN1` — a real fragrance show — 190 comments produced 60
// drafted replies from 29 distinct buyers, and the seller sent none of them:
// they were reading the queue with one hand while running the auction with the
// other. Those 29 people are not a failure to be counted in a report. Each one
// asked a specific question about a specific item and then left, which is the
// warmest lead this product will ever have and the only one that costs nothing
// to reach: it is private, it is one-to-one, it is invited, and unlike a reply
// posted into a public room there is no authenticity risk in it at all.
//
// So this surface has no watcher and no feed. Its "messages" are read out of
// the show record the session already wrote (src/shows/record.ts), its drafts
// come off the same pipeline that would have answered live, and delivery is
// `draft-only` because the two places a follow-up could go are both shut to
// us: eBay exposes no messaging API to a third party at all, and Instagram's
// messaging API is behind an app review this project has not applied for. A
// capability we do not have is not a setting — see `delivery` below.

import {
  capabilitiesOf, SurfaceUnavailable,
  type SurfaceAdapter, type SurfaceConnection, type SurfaceEvents, type SurfaceTarget,
} from "../types.js";

/**
 * Follow up on a finished show: `show:ebay_47tK1SX0VsiHEXN1`.
 *
 * The id charset is every show id this database has ever held — the `ebay_`
 * prefix, the `-2` a re-attached session takes, the `test_` a rig writes — and
 * nothing looser. A `show:` target that does not name a real show is refused by
 * the route with the id in the message, rather than by a pattern that shrugs.
 */
const SHOW = /^show:([A-Za-z0-9_.:-]{1,80})$/i;

/**
 * A manual inbox: `inbox:@kicksbyrae`. An operator working their own DMs with
 * no show behind them — the same drafting, grounded in the same catalog.
 */
const INBOX = /^inbox:@?([A-Za-z0-9_.-]{1,40})$/i;

export const dmAdapter: SurfaceAdapter = {
  id: "dm",
  label: "Follow-up inbox",
  // The one table in `types.ts`, not a second copy of it. A capability the
  // guards read and a capability the adapter claims have to be the same object
  // or they are two answers to one question.
  capabilities: capabilitiesOf("dm"),

  parseTarget(input: string): SurfaceTarget | null {
    const t = (input || "").trim();
    const show = t.match(SHOW);
    if (show) return { externalId: show[1]!, meta: { kind: "show" } };
    const inbox = t.match(INBOX);
    if (inbox) return { externalId: inbox[1]!, handle: `@${inbox[1]}`, meta: { kind: "inbox" } };
    return null;
  },

  /**
   * There is nothing to open.
   *
   * Not an oversight and not a stub: a follow-up inbox is built from a show
   * that has ENDED, so there is no socket to hold and no event to wait for. The
   * typed refusal is the honest answer and it names the call that does work,
   * because an operator who pasted `show:…` into the attach box was asking for
   * the right thing at the wrong door. A silently-succeeding `open()` that
   * emitted nothing would have them watching a feed that can never move.
   */
  async open(t: SurfaceTarget, _ev: SurfaceEvents): Promise<SurfaceConnection> {
    throw new SurfaceUnavailable(
      "dm",
      t.meta?.kind === "inbox"
        ? `${t.handle}'s inbox is worked by hand — nothing streams into it, so there is nothing to watch`
        : `the follow-up inbox is not a live feed — build ${t.externalId}'s follow-ups with ` +
          `POST /api/shows/${t.externalId}/followups once the show has ended`,
    );
  },
};
