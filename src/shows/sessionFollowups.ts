// The people who asked and did not buy, built when the session ends.
//
// `buildFollowUps` had exactly one caller — `POST /api/shows/:showId/followups`
// — and nothing invoked that route. Not the detach path, not the console, not
// the frontend. So `followups.total` was permanently zero: the home card that
// renders the inbox never appeared, the Drafts queue never filled, and the line
// above it — "the follow-ups are the people who asked and did not buy" — was a
// promise the product could not keep for any real user. The selection rule, the
// drafting, the guard re-run and the inbox were all correct and all unreachable.
//
// They are built here instead, at the end of the session, beside the frame
// descriptions and on the same contract: fired from `registry.detach`, never
// delaying it, and LOUD when it fails. A follow-up that silently does not exist
// is the failure this whole file is about.
//
// ── the cap ────────────────────────────────────────────────────────────────
//
// One build drafts fifty buyers, because each one is a gateway round trip. The
// cap used to strand everybody past the fiftieth permanently — `slice(0, 50)`
// takes the same first fifty every time, so a second call never reached the
// fifty-first. The session-end job pages through the selection instead, and
// when it stops early it says how many people it did not reach rather than
// leaving them to be discovered as an inbox that is quietly short.

import type { Pool } from "../db/pg.js";
import { showRecord } from "./record.js";
import { openReplayRuntime } from "./replay.js";
import { MAX_PER_BUILD, buildFollowUps, type Drafter } from "../surfaces/dm/drafts.js";

/** How many buyers one session-end job will draft for, across all its pages.
 *  Four pages of fifty covers every show in this database with room to spare;
 *  past it, the count is reported rather than the people being dropped. */
const MAX_AT_SESSION_END = 200;

/** What happened, for the log and for a test. */
export interface SessionFollowUps {
  showId: string;
  /** Buyers the selection rule picked out of the whole session. */
  selected: number;
  /** Follow-ups now in this account's inbox for this session. */
  drafted: number;
  /** Selected buyers this job did not reach, because it hit its own bound.
   *  Zero is the normal case; anything else is a number somebody should see. */
  unreached: number;
  /** Drafted and dropped by the guard chain, and drafted with nothing to say.
   *  Both are real outcomes of a session, not failures of this job. */
  guardedOut: number;
  abstained: number;
}

/** How this job gets a drafter for a session that is over. Injected so the
 *  rule above it can be exercised without a gateway. */
export type DrafterOpener = (showId: string) => Promise<{ drafter: Drafter; close(): Promise<void> }>;

const defaultOpener: DrafterOpener = async (showId) => {
  const rt = await openReplayRuntime(showId);
  return { drafter: rt.pipeline, close: () => rt.close() };
};

/**
 * Build this session's follow-ups.
 *
 * Null when there is nobody to file them for: `followups.account_id` is the
 * whole tenancy of the inbox, and a session with no owner — every row written
 * before ownership existed — has no inbox to write into. Saying so is the
 * honest answer; inventing an owner is not.
 *
 * The account is read from the show ROW rather than taken from a runtime's
 * cached field, so it is the same owner every other read of this session uses.
 */
export async function generateSessionFollowUps(
  d: Pool,
  showId: string,
  opts: { open?: DrafterOpener } = {},
): Promise<SessionFollowUps | null> {
  const owner = (
    await d.query<{ owner_account_id: string | null }>(
      "SELECT owner_account_id FROM shows WHERE id = $1", [showId],
    )
  ).rows[0];
  if (!owner) throw new Error(`no show ${showId}`);
  if (!owner.owner_account_id) return null;
  const accountId = owner.owner_account_id;

  const record = await showRecord(d, showId);
  // Nothing was proposed, so nobody asked anything answerable. Not worth a
  // replay runtime and a pipeline to find that out a second time.
  if (!record.proposals?.length) {
    return { showId, selected: 0, drafted: 0, unreached: 0, guardedOut: 0, abstained: 0 };
  }

  const opened = await (opts.open ?? defaultOpener)(showId);
  try {
    let offset = 0;
    let guardedOut = 0;
    let abstained = 0;
    let selected = 0;
    let remaining = 0;
    let drafted = 0;
    // Pages of fifty. The selection is deterministic — worth first, then when
    // they asked — so paging over it reaches each buyer exactly once, and a
    // buyer already settled by the seller is skipped inside the build.
    for (;;) {
      const page = await buildFollowUps(d, {
        showId, accountId, record, drafter: opened.drafter, offset,
      });
      selected = page.selected;
      guardedOut += page.guardedOut.length;
      abstained += page.abstained.length;
      remaining = page.remaining;
      drafted = page.followups.length;
      offset = Math.min(selected, offset + MAX_PER_BUILD);
      if (!remaining || offset >= MAX_AT_SESSION_END) break;
    }
    return { showId, selected, drafted, unreached: remaining, guardedOut, abstained };
  } finally {
    await opened.close().catch(() => {});
  }
}
