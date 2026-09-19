// The runtime for a session that is over.
//
// Two things need one — drafting follow-ups for the people who asked and did
// not buy (src/surfaces/dm/drafts.ts), and generating a report again for a
// session whose first attempt failed — and both need the SAME object graph the
// session ran on: its listings, its catalog, its seller voice, its guard
// policy, its agent, its audit chain. Assembling a second, smaller composition
// of those eight objects is the same graph with different bugs, so this
// rebuilds the real `ShowRuntime` in REPLAY mode instead.
//
// Replay is a reader. `init()` does not put the show back on air, does not
// reset its clock, does not create a show if the id is unknown, and `start()`
// is never called — no surface is opened and nothing is ingested. Everything
// that would change what the session IS is skipped, because the two callers are
// both asking a question about a show that already happened.

import { db as pgPool } from "../db/pg.js";
import { getCatalog } from "./catalogs.js";
import { ShowRuntime } from "./runtime.js";
import type { SurfaceId } from "../surfaces/types.js";

/**
 * Rebuild a finished session's runtime, wired to the catalog and the agent it
 * actually ran on.
 *
 * The caller closes it. Throws when the show id is unknown, rather than
 * answering a question about a session that does not exist with an empty one.
 */
export async function openReplayRuntime(showId: string): Promise<ShowRuntime> {
  const d = pgPool();
  const row = (
    await d.query<{
      title: string; seller_handle: string; source: string; external_id: string | null;
      owner_account_id: string | null; catalog_id: string | null; agent_id: string | null;
    }>(
      `SELECT title, seller_handle, source, external_id, owner_account_id, catalog_id, agent_id
         FROM shows WHERE id = $1`,
      [showId],
    )
  ).rows[0];
  if (!row) throw new Error(`no show ${showId}`);

  const rt = new ShowRuntime({
    showId,
    title: row.title,
    sellerHandle: row.seller_handle,
    source: row.source as SurfaceId,
    externalId: row.external_id,
    ownerAccountId: row.owner_account_id,
    replay: true,
    events: { emit: () => {} },
  });
  await rt.init();

  // The voice. The listings came back with the show row; the seller's identity
  // lives in the catalog file, and without it a follow-up is written by a
  // generic assistant rather than by the person whose account will send it.
  const catalog = row.catalog_id ? getCatalog(row.catalog_id) : null;
  if (catalog) {
    rt.seller = catalog.seller;
    rt.catalogId = catalog.id;
  }
  // The agent that actually answered this show, preferred over the catalog
  // file's: the show row is what survives a catalog being re-imported, and it
  // is the same column `POST /:showId/timeline/describe` reads for the same
  // reason. Agent GC retires it a day after the report, which is the real
  // deadline on both callers — a fact worth saying out loud rather than
  // discovering as a 400 on a show from last week.
  const agentId = row.agent_id || catalog?.agentId;
  if (agentId) rt.useAgent(agentId);

  return rt;
}
