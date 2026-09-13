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
  dbPath: resolve(process.env.DB_PATH || "./data/sidestage.db"),

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
