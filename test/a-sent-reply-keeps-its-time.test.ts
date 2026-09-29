// Every `sent` proposal in production has `sent_at` NULL.
//
// Found by restoring the first-ever production dump into a local database and
// looking, which is a thing that only became possible today:
//
//   status       | total | with_sent_at | with_decided_at
//   sent         |     3 |            0 |               3
//
// Three sends, three `decided_at`, zero `sent_at`. The console's Sent list shows
// "the moment it went" from that column, so after a reconnect or a restart — when
// the queue is rehydrated from Postgres rather than held in memory — those three
// have no time to show.
//
// The reason nothing caught it: `test/decision.test.ts`'s harness wires
// `onProposal` to a Map, and `test/room-rules.test.ts` asserts `sentAt` on the
// object `send()` RETURNS. Neither writes a proposal to the database at all. So
// the persistence of a settled proposal — the thing the restart-durability fix
// (F-15) was for — had no test.
//
// This wires the real `SessionRecord.recordProposal` into a real pipeline, the way
// `ShowRuntime` does, sends a reply, and reads the row back.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { db, closeDb } from "../src/db/pg.js";
import { SessionRecord } from "../src/shows/sessionRecord.js";
import { Pipeline } from "../src/pipeline/pipeline.js";
import { Retriever } from "../src/retrieval/retriever.js";
import { ResearchService } from "../src/research/research.js";
import { ActionProposer } from "../src/actions/proposer.js";
import { ShowContextEngine } from "../src/ingest/showContext.js";
import { rig } from "./helpers.js";
import type { LlmPort } from "../src/llm/types.js";
import type { ReplyProposal } from "../src/domain/types.js";

after(async () => {
  await closeDb();
});

/** Answers with a deferral, which cites nothing and is allowed to. */
const deferring: LlmPort = {
  chatTurn: async () => JSON.stringify({ answer: "Let me check and come back to you.", claims: [] }),
  chatTurnStream: async (_m: string, _c: string, onDelta: (d: string, full: string) => void) => {
    const s = JSON.stringify({ answer: "Let me check and come back to you.", claims: [] });
    onDelta(s, s);
    return s;
  },
  utilityTurn: async () => "{}",
} as unknown as LlmPort;

describe("a proposal that settled is in the database, with its times", () => {
  test("a sent reply keeps the moment it went", async () => {
    const r = await rig();
    const record = new SessionRecord(db(), r.showId);
    const seen = new Map<string, ReplyProposal>();

    const pipeline = new Pipeline({
      repo: r.repo,
      llm: deferring,
      retriever: r.retriever,
      research: new ResearchService(r.repo),
      executor: r.exec,
      proposer: new ActionProposer(r.repo),
      showContext: new ShowContextEngine({ llm: deferring, lotTitles: () => [], onUpdate: () => {} }),
      audit: r.audit,
      events: {
        onChat: () => {},
        // Exactly what ShowRuntime does: emit, then record.
        onProposal: (p) => {
          seen.set(p.id, p);
          record.recordProposal(p);
        },
        onMetrics: () => {},
        onListingChanged: () => {},
      },
    });

    await pipeline.ingest({ externalId: "m_sent_time", author: "a_buyer", text: "do you ship to canada?" });
    // The draft settles asynchronously.
    const settled = await waitFor(() => [...seen.values()].find((p) => p.status !== "drafting"));
    assert.ok(settled, "nothing settled");
    assert.notEqual(settled.status, "blocked", JSON.stringify(settled.guards));

    const sent = await pipeline.send(settled.id, undefined, "seller");
    assert.equal(sent.status, "sent");
    assert.ok(sent.sentAt, "the object send() returns has a time — this much was already tested");

    // The row. `recordProposal` is fire-and-forget, so wait for the write rather
    // than for a duration.
    const row = await waitFor(async () => {
      const q = await db().query<{ status: string; sent_at: string | null; decided_at: string | null }>(
        "SELECT status, sent_at, decided_at FROM reply_proposals WHERE show_id = $1 AND id = $2",
        [r.showId, settled.id],
      );
      return q.rows[0]?.status === "sent" ? q.rows[0] : undefined;
    });
    assert.ok(row, "the sent proposal never reached the database");

    assert.ok(
      row.sent_at,
      "the row is `sent` with sent_at NULL — which is every sent proposal in production. " +
        "The console's Sent list reads this column after a reconnect, so the reply has no time to show.",
    );
    assert.equal(
      new Date(row.sent_at).toISOString(),
      new Date(sent.sentAt!).toISOString(),
      "the stored moment is not the moment send() reported",
    );
    assert.ok(row.decided_at, "a send is a decision, so decided_at is stamped too");

  });
});

/** Poll a condition rather than sleep for a duration. */
async function waitFor<T>(f: () => T | Promise<T>, tries = 120): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await f();
    if (v) return v;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("condition never became true");
}
