// Shared bench rig: a complete pipeline over an in-memory catalog, with the real
// Whissle agent behind it. Deliberately NOT the HTTP server — the benchmark
// measures the copilot, not fastify.

import { memoryDb, type DB } from "../src/db/index.js";
import { seed } from "../src/db/seed.js";
import { Repo } from "../src/domain/repo.js";
import { Retriever } from "../src/retrieval/retriever.js";
import { ResearchService } from "../src/research/research.js";
import { AuditLog } from "../src/actions/audit.js";
import { ActionExecutor } from "../src/actions/executor.js";
import { ActionProposer } from "../src/actions/proposer.js";
import { MockMarketplace } from "../src/actions/marketplace/mock.js";
import type { RemoteListing } from "../src/actions/marketplace/port.js";
import { ShowContextEngine } from "../src/ingest/showContext.js";
import { Pipeline } from "../src/pipeline/pipeline.js";
import { WhissleClient } from "../src/llm/whissle.js";
import { config, hasWhissleCreds } from "../src/config.js";
import type { ReplyProposal } from "../src/domain/types.js";

export interface Bench {
  d: DB;
  repo: Repo;
  retriever: Retriever;
  audit: AuditLog;
  exec: ActionExecutor;
  pipeline: Pipeline;
  market: MockMarketplace;
  /** Resolves when a proposal reaches a terminal state. */
  settled: Map<string, ReplyProposal>;
  waitFor(count: number, timeoutMs?: number): Promise<void>;
}

const TERMINAL = new Set(["ready", "needs_review", "blocked", "sent", "auto_sent", "dismissed"]);

export function buildBench(): Bench {
  if (!hasWhissleCreds()) {
    console.error(
      "This benchmark measures the real reply path, so it needs Whissle credentials.\n" +
      "Set WHISSLE_API_KEY and WHISSLE_AGENT_ID (see .env.example, then `npm run seed:agent`).",
    );
    process.exit(2);
  }

  const d = memoryDb();
  seed(d);
  const repo = new Repo(d);
  const retriever = new Retriever(repo);
  const audit = new AuditLog(d);

  const remote: RemoteListing[] = repo.listings().map((l) => ({
    id: l.id, priceCents: l.priceCents, qty: l.qty, state: l.state, pinned: l.pinned, version: l.version,
  }));
  const market = new MockMarketplace(remote, { latencyMs: 0 });

  const llm = new WhissleClient({
    apiKey: config.whissle.apiKey,
    agentId: config.whissle.agentId,
    baseUrl: config.whissle.base,
    timeoutMs: 20_000,
  });

  const settled = new Map<string, ReplyProposal>();
  let notify: (() => void) | null = null;

  const exec = new ActionExecutor(d, repo, market, audit, {
    undoWindowS: 90,
    onListingWrite: () => retriever.rebuild(),
  });
  const proposer = new ActionProposer(repo);
  const showContext = new ShowContextEngine({
    llm,
    lotTitles: () => repo.listings().map((l) => ({ id: l.id, title: l.title })),
  });

  const pipeline = new Pipeline({
    repo, llm, retriever, executor: exec, proposer, showContext, audit,
    research: new ResearchService(repo),
    events: {
      onChat: () => {},
      onProposal: (p) => {
        if (TERMINAL.has(p.status)) {
          settled.set(p.id, p);
          notify?.();
        }
      },
      onMetrics: () => {},
      onListingChanged: () => {},
    },
  });

  return {
    d, repo, retriever, audit, exec, pipeline, market, settled,
    waitFor(count, timeoutMs = 180_000) {
      return new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const check = () => {
          if (settled.size >= count) return resolve();
          if (Date.now() - t0 > timeoutMs) {
            return reject(new Error(`timed out with ${settled.size}/${count} proposals settled`));
          }
        };
        notify = check;
        const poll = setInterval(() => {
          check();
          if (settled.size >= count || Date.now() - t0 > timeoutMs) clearInterval(poll);
        }, 100);
        check();
      });
    },
  };
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function stats(xs: number[]): { n: number; p50: number; p95: number; p99: number; max: number; mean: number } {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: Math.round(percentile(s, 50)),
    p95: Math.round(percentile(s, 95)),
    p99: Math.round(percentile(s, 99)),
    max: Math.round(s[s.length - 1] ?? 0),
    mean: Math.round(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
  };
}
