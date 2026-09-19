// Shared test rig.
//
// Every test gets its OWN SHOW in the real Postgres database, seeded with the
// same catalog the demo uses — so a failure is reproducible by driving the real
// UI at the same listing, and the SQL under test is the SQL that ships.
//
// Isolation is the show id, which is the same boundary production uses. That is
// deliberate: a test rig that isolated differently from production would be
// testing a tenancy model nothing else runs.

import { db, migrate, closeDb, type Pool } from "../src/db/pg.js";
import { seed } from "../src/db/seed.js";
import { Repo } from "../src/domain/repo.js";
import { AuditLog } from "../src/actions/audit.js";
import { ActionExecutor } from "../src/actions/executor.js";
import { MockMarketplace } from "../src/actions/marketplace/mock.js";
import type { RemoteListing } from "../src/actions/marketplace/port.js";
import { Retriever } from "../src/retrieval/retriever.js";

export interface Rig {
  d: Pool;
  showId: string;
  repo: Repo;
  audit: AuditLog;
  market: MockMarketplace;
  exec: ActionExecutor;
  retriever: Retriever;
  listingWrites: string[];
}

let migrated = false;
const created: string[] = [];

export async function rig(opts: { failRate?: number; latencyMs?: number } = {}): Promise<Rig> {
  const d = db();
  if (!migrated) {
    await migrate(d);
    migrated = true;
  }

  const showId = `test_${process.pid.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  created.push(showId);
  await seed(d, showId);

  const repo = new Repo(d, showId);
  const audit = new AuditLog(d, showId);

  // The marketplace starts as a mirror of our catalog, then diverges as writes
  // land on one side or the other — which is the point.
  const remote: RemoteListing[] = (await repo.listings()).map((l) => ({
    id: l.id, priceCents: l.priceCents, qty: l.qty, state: l.state, pinned: l.pinned, version: l.version,
  }));
  const market = new MockMarketplace(remote, { failRate: opts.failRate ?? 0, latencyMs: opts.latencyMs ?? 0 });

  const listingWrites: string[] = [];
  const retriever = new Retriever(repo);
  await retriever.rebuild();
  const exec = new ActionExecutor(d, repo, market, audit, {
    undoWindowS: 90,
    onListingWrite: (id) => {
      listingWrites.push(id);
      void retriever.rebuild();
    },
  });

  return { d, showId, repo, audit, market, exec, retriever, listingWrites };
}

/** Drop every show this process created, then close the pool. Call from a
 *  top-level `after` so a test run leaves the database as it found it. */
export async function cleanup(): Promise<void> {
  const d = db();
  for (const id of created.splice(0)) {
    await d.query("DELETE FROM shows WHERE id = $1", [id]).catch(() => {});
  }
  await closeDb();
}

export const PINNED = "lst_aj1_chi_10";

// ── guardrail evaluation harness ────────────────────────────────────────────

import type { Claim, Verdict, GuardName } from "../src/domain/types.js";
import type { GuardInput } from "../src/guardrails/types.js";
import { runChain, type ChainResult } from "../src/guardrails/chain.js";
import { capabilitiesOf } from "../src/surfaces/types.js";

/** Build the exact input the guard chain sees in production: real retrieval for
 *  the question, real CURRENT listing state, and a supplied draft. Nothing is
 *  stubbed except the model's output, which is the thing under test. */
export async function guardInput(
  r: Rig,
  question: string,
  answer: string,
  claims: { text: string; factId: string }[] = [],
  opts: { parsedOk?: boolean } = {},
): Promise<GuardInput> {
  const show = await r.repo.show();
  const res = r.retriever.retrieve(question, { pinnedId: show.pinnedListingId });
  const [listings, policies] = await Promise.all([r.repo.listings(), r.repo.policies()]);
  return {
    draft: {
      answer,
      claims: claims.map((c) => ({ ...c, supported: false })) as Claim[],
      parsedOk: opts.parsedOk ?? true,
      raw: answer,
    },
    question,
    facts: res.facts,
    factById: new Map(res.facts.map((f) => [f.factId, f])),
    currentListings: new Map(listings.map((l) => [l.id, l])),
    slots: res.slots,
    policies,
    // The rig builds eBay Live's input, because eBay Live is what every
    // existing case was written against. A case for another surface says so.
    surface: capabilitiesOf(show.source),
    community: res.facts.filter((f) => f.corpus === "community"),
  };
}

export async function judge(
  r: Rig,
  question: string,
  answer: string,
  claims: { text: string; factId: string }[] = [],
  opts: { parsedOk?: boolean } = {},
): Promise<ChainResult> {
  return runChain(await guardInput(r, question, answer, claims, opts), { evidenceQuality: 0.9 });
}

export interface GuardCase {
  name: string;
  question: string;
  answer: string;
  claims?: { text: string; factId: string }[];
  parsedOk?: boolean;
  /** Mutate catalog state before judging — e.g. land a markdown mid-show. */
  setup?: (r: Rig) => void | Promise<void>;
  expect: Verdict;
  /** When blocking or revising, which guard must be the one that fires. */
  byGuard?: GuardName;
}
