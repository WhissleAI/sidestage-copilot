// Single source of configuration. Everything is env-overridable; every default
// is chosen so `npm run seed && npm run dev` works with no .env at all (the LLM
// calls are the one thing that genuinely needs credentials).

import { resolve } from "node:path";

try {
  process.loadEnvFile();
} catch {
  /* no .env — rely on the ambient environment */
}

function num(name: string, dflt: number): number {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export const config = {
  port: num("PORT", 8790),
  /**
   * One Postgres database for everything.
   *
   * Replaces the show-per-SQLite-file store: accounts, settings and cross-show
   * analytics all want shared multi-process state, and a show stays a tenant
   * boundary by scoping rather than by filesystem (see db/pg.ts).
   */
  databaseUrl:
    process.env.DATABASE_URL || "postgres://localhost:5432/sidestage",
  /** Seller catalogs the operator picks from when starting a session. */
  catalogsDir: resolve(process.env.CATALOGS_DIR || "./fixtures/catalogs"),
  /** Each watched show costs a browser page; cap it. */
  maxWatchedShows: num("MAX_WATCHED_SHOWS", 6),

  whissle: {
    apiKey: process.env.WHISSLE_API_KEY || "",
    agentId: process.env.WHISSLE_AGENT_ID || "",
    base: (process.env.WHISSLE_BASE || "https://aws-gateway-backend.whissle.ai/bot").replace(/\/$/, ""),
  },

  /** Bounded fan-out. The gateway runs a shared 8-wide LLM semaphore; stay under it. */
  replyConcurrency: num("REPLY_CONCURRENCY", 3),
  /** Token bucket: how many buyer questions per minute may become proposals. */
  proposalsPerMin: num("PROPOSALS_PER_MIN", 30),
  /** End-to-end budget, admit -> rendered. Breaches are recorded, never hidden. */
  latencyBudgetMs: num("LATENCY_BUDGET_MS", 2000),

  autonomyDefault: (process.env.AUTONOMY_LEVEL || "L1_SUGGEST") as
    | "L0_OBSERVE" | "L1_SUGGEST" | "L2_ONE_TAP" | "L3_AUTO_REPLY" | "L4_AUTO_ACT",
  undoWindowS: num("UNDO_WINDOW_S", 90),

  /** Simulated show driver — the demo/eval input. Off when a real chat source runs. */
  simulate: (process.env.SIMULATE ?? "true") !== "false",
  simulateMinMs: num("SIMULATE_MIN_MS", 1400),
  simulateMaxMs: num("SIMULATE_MAX_MS", 3600),

  /** Fault injection for the mock marketplace, so rollback is genuinely exercised. */
  marketplaceFailRate: num("MARKETPLACE_FAIL_RATE", 0),
  marketplaceLatencyMs: num("MARKETPLACE_LATENCY_MS", 120),
};

export const hasWhissleCreds = () => Boolean(config.whissle.apiKey && config.whissle.agentId);
