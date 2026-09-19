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
    // The suite gets its own database. Reading DATABASE_URL there meant every
    // test run wrote chat, proposals and follow rows into whatever the dev
    // server was serving — and once the console started rehydrating chat, those
    // rows showed up in the firehose as if a buyer had typed them.
    process.env.NODE_ENV === "test"
      ? process.env.TEST_DATABASE_URL || "postgres://localhost:5432/sidestage_test"
      : process.env.DATABASE_URL || "postgres://localhost:5432/sidestage",
  /** Seller catalogs the operator picks from when starting a session. */
  catalogsDir: resolve(process.env.CATALOGS_DIR || "./fixtures/catalogs"),
  /** Each watched show costs a browser page; cap it. */
  maxWatchedShows: num("MAX_WATCHED_SHOWS", 6),

  whissle: {
    apiKey: process.env.WHISSLE_API_KEY || "",
    agentId: process.env.WHISSLE_AGENT_ID || "",
    base: (process.env.WHISSLE_BASE || "https://aws-gateway-backend.whissle.ai/bot").replace(/\/$/, ""),
  },

  /**
   * The eBay developer application, for the READ APIs an app token reaches.
   *
   * `sandbox` and `production` are different hosts AND different credentials —
   * a sandbox key against the production host is a 401 with a message that does
   * not say so. Anything touching a seller's own listings needs a USER token
   * (authorisation-code grant), which these three values cannot mint.
   */
  ebay: {
    env: (process.env.EBAY_ENV || "sandbox") === "production" ? "production" : "sandbox",
    // Blank under test, deliberately. The suite must not reach eBay: the
    // sandbox answers in 0.7–4.6 seconds, which would make a 5-second suite a
    // 90-second one and tie a green run to someone else's uptime. The client's
    // own behaviour is tested with an injected fetcher, and the live path is
    // verified by `GET /api/ebay/status` against the real sandbox.
    appId: process.env.NODE_ENV === "test" ? "" : process.env.EBAY_APP_ID || "",
    certId: process.env.NODE_ENV === "test" ? "" : process.env.EBAY_CERT_ID || "",
    devId: process.env.EBAY_DEV_ID || "",
    marketplaceId: process.env.EBAY_MARKETPLACE_ID || "EBAY_US",
    /** The redirect the consent flow returns to — eBay calls it an RuName, and
     *  it is registered on the application, not chosen here. */
    // Blanked under test like the keys above: the suite must never start a
    // consent round trip against eBay.
    ruName: process.env.NODE_ENV === "test" ? "" : process.env.EBAY_RUNAME || "",

  },
  /**
   * The Twitch application, and the bot account that speaks for a channel.
   *
   * Three values rather than two, because Twitch issues two different tokens
   * and only one of them can do anything interesting. The app's own id and
   * secret mint an APP token, which reads public things — who a channel is,
   * what it is playing. Everything this surface actually does — read chat,
   * cut a clip, run a poll, say something — acts AS an account, and the only
   * way to mint that token without a browser in the loop is a refresh token
   * the bot account granted once.
   *
   * Absence is a first-class state, not an outage: the adapter registers,
   * reports its capabilities, and `open()` refuses by naming the variable
   * (docs/SURFACES.md).
   */
  twitch: {
    // Blanked under test for the reason the eBay keys above are: a suite that
    // could reach Twitch would give a developer with a working .env a
    // different answer from CI, and the adapter's behaviour is tested with an
    // injected fetcher instead.
    clientId: process.env.NODE_ENV === "test" ? "" : process.env.TWITCH_CLIENT_ID || "",
    clientSecret: process.env.NODE_ENV === "test" ? "" : process.env.TWITCH_CLIENT_SECRET || "",
    botRefreshToken: process.env.NODE_ENV === "test" ? "" : process.env.TWITCH_BOT_REFRESH_TOKEN || "",
    /** Where Twitch sends the operator back after consent. Registered on the
     *  application in dev.twitch.tv and matched byte-for-byte at the exchange,
     *  which is why it is configuration rather than derived from the request. */
    redirectUri: process.env.NODE_ENV === "test" ? "" : process.env.TWITCH_REDIRECT_URI || "",
  },

  /** eBay's account-deletion notifications: the token we registered, and the
   *  endpoint URL exactly as registered (it is part of the challenge hash). */
  ebayDeletion: {
    verificationToken: process.env.EBAY_DELETION_VERIFICATION_TOKEN || "",
    endpoint: process.env.EBAY_DELETION_ENDPOINT || "",
  },

  /**
   * The Reddit script application.
   *
   * Five values, all five required: Reddit's script grant is a password grant,
   * so the app identity and the account identity are separate halves of the
   * same credential and four out of five authenticates nobody.
   *
   * `userAgent` is not politeness. Reddit rate-limits and then blocks on the
   * User-Agent string, it wants it to identify the app and its owner, and a
   * default Node agent earns a 429 that looks exactly like pacing we got wrong.
   *
   * Blank under test, for the same reason the eBay keys are: the suite must
   * never reach Reddit. The client's behaviour — token refresh, rate-limit
   * backoff, parsing — is exercised with an injected fetcher and recorded
   * fixtures.
   */
  reddit: {
    clientId: process.env.NODE_ENV === "test" ? "" : process.env.REDDIT_CLIENT_ID || "",
    clientSecret: process.env.NODE_ENV === "test" ? "" : process.env.REDDIT_CLIENT_SECRET || "",
    username: process.env.NODE_ENV === "test" ? "" : process.env.REDDIT_USERNAME || "",
    password: process.env.NODE_ENV === "test" ? "" : process.env.REDDIT_PASSWORD || "",
    userAgent: process.env.REDDIT_USER_AGENT || "",
    /** How often a watched subreddit, profile or thread is re-read. Reddit's
     *  own guidance is one request a second sustained; a minute between polls
     *  on a handful of rooms sits far inside it and still reads as prompt on a
     *  surface where people answer in hours. */
    pollMs: num("REDDIT_POLL_MS", 60_000),
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
