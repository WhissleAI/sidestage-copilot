// Shared test rig. Every test runs against an in-memory database seeded with the
// same catalog the demo uses, so a test failure is reproducible by driving the
// real UI at the same listing.

import { memoryDb, type DB } from "../src/db/index.js";
import { seed } from "../src/db/seed.js";
import { Repo } from "../src/domain/repo.js";
import { AuditLog } from "../src/actions/audit.js";
import { ActionExecutor } from "../src/actions/executor.js";
import { MockMarketplace } from "../src/actions/marketplace/mock.js";
import type { RemoteListing } from "../src/actions/marketplace/port.js";
import { Retriever } from "../src/retrieval/retriever.js";

export interface Rig {
  d: DB;
  repo: Repo;
  audit: AuditLog;
  market: MockMarketplace;
  exec: ActionExecutor;
  retriever: Retriever;
  listingWrites: string[];
}

export function rig(opts: { failRate?: number; latencyMs?: number } = {}): Rig {
  const d = memoryDb();
  seed(d);
  const repo = new Repo(d);
  const audit = new AuditLog(d);

  // The marketplace starts as a mirror of our catalog, then diverges as writes
  // land on one side or the other — which is the point.
  const remote: RemoteListing[] = repo.listings().map((l) => ({
    id: l.id, priceCents: l.priceCents, qty: l.qty, state: l.state, pinned: l.pinned, version: l.version,
  }));
  const market = new MockMarketplace(remote, { failRate: opts.failRate ?? 0, latencyMs: opts.latencyMs ?? 0 });

  const listingWrites: string[] = [];
  const retriever = new Retriever(repo);
  const exec = new ActionExecutor(d, repo, market, audit, {
    undoWindowS: 90,
    onListingWrite: (id) => {
      listingWrites.push(id);
      retriever.rebuild();
    },
  });

  return { d, repo, audit, market, exec, retriever, listingWrites };
}

export const PINNED = "lst_aj1_chi_10";

// ── guardrail evaluation harness ────────────────────────────────────────────

import type { Claim, Verdict, GuardName } from "../src/domain/types.js";
import type { GuardInput } from "../src/guardrails/types.js";
import { runChain, type ChainResult } from "../src/guardrails/chain.js";

/** Build the exact input the guard chain sees in production: real retrieval for
 *  the question, real CURRENT listing state, and a supplied draft. Nothing is
 *  stubbed except the model's output, which is the thing under test. */
export function guardInput(
  r: Rig,
  question: string,
  answer: string,
  claims: { text: string; factId: string }[] = [],
  opts: { parsedOk?: boolean } = {},
): GuardInput {
  const res = r.retriever.retrieve(question, { pinnedId: r.repo.show().pinnedListingId });
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
    currentListings: new Map(r.repo.listings().map((l) => [l.id, l])),
    slots: res.slots,
    policies: r.repo.policies(),
  };
}

export function judge(
  r: Rig,
  question: string,
  answer: string,
  claims: { text: string; factId: string }[] = [],
  opts: { parsedOk?: boolean } = {},
): ChainResult {
  return runChain(guardInput(r, question, answer, claims, opts), { evidenceQuality: 0.9 });
}

export interface GuardCase {
  name: string;
  question: string;
  answer: string;
  claims?: { text: string; factId: string }[];
  parsedOk?: boolean;
  /** Mutate catalog state before judging — e.g. land a markdown mid-show. */
  setup?: (r: Rig) => void;
  expect: Verdict;
  /** When blocking or revising, which guard must be the one that fires. */
  byGuard?: GuardName;
}
