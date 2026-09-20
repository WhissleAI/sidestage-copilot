// Single source of configuration. Everything is env-overridable; every default
// is chosen so `npm run seed && npm run dev` works with no .env at all (the LLM
// calls are the one thing that genuinely needs credentials).

import { resolve } from "node:path";

try {
  process.loadEnvFile();
} catch {
  /* no .env — rely on the ambient environment */
}

/**
 * Every numeric variable that was read, and whether it was readable.
 *
 * `num()` silently falls back to the default on anything unparseable, which
 * means `PROPOSALS_PER_MIN=thirty` is thirty and `MAX_WATCHED_SHOWS=` is six
 * and nobody is told. The fallback is right — a deploy must not die on a typo
 * in a tuning knob — but the SILENCE is not, because the first sign of it is a
 * number behaving differently from the one in the .env somebody is reading.
 */
const badNumbers: { name: string; value: string; using: number }[] = [];

function num(name: string, dflt: number): number {
  const v = process.env[name];
  if (v !== undefined && v.trim() !== "" && !Number.isFinite(Number(v))) {
    badNumbers.push({ name, value: v, using: dflt });
  }
  const n = v === undefined || v.trim() === "" ? NaN : Number(v);
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
  /**
   * Watched rooms on a surface that owns a WHOLE BROWSER each.
   *
   * `MAX_WATCHED_SHOWS` counts sessions, and six sessions is a sensible
   * number of sessions — but six Whatnot rooms is six real Chromes, because
   * `scrapeWatcher.ts` launches its own (and says so, at :88-99). On the
   * t3.small this runs on, `mem_limit: 1100m` holds Node plus every browser,
   * and Chrome with one page is 150–300 MB. Six is an OOM kill that takes
   * every other show with it; two leaves room for the eBay discovery poll and
   * a Whatnot browse without the container dying.
   */
  maxScrapedRooms: num("MAX_SCRAPED_ROOMS", 2),
  /**
   * The hard ceiling on real Chrome processes, across every purpose.
   *
   * Four launch families share one box and none of them could see the others.
   * This is the number the worst case is READ off, rather than derived from
   * four call sites: two scraped rooms + the shared eBay Live browser + one
   * eBay profile read (discovery, seller listings, prepare — they queue) + one
   * Whatnot browse, with one spare so a recovery can open before its
   * predecessor has finished closing.
   */
  maxBrowsers: num("MAX_BROWSERS", 6),

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

// ── what was read, checked once, at boot ────────────────────────────────────
//
// Every variable in this file used to be discovered at FIRST USE. There was no
// schema, no required set, and no boot-time report of what was read — so a
// malformed value surfaced as a 500 on whichever workflow touched it first,
// at whatever hour that happened to be, and a missing one surfaced as nothing
// at all.
//
// Three severities, because they have three different right answers:
//   REFUSE   the process cannot do its job and pretending otherwise is worse
//            than not starting.
//   WARN     something is degraded or a value was ignored; boot, and say so
//            where it cannot be missed.
//   NOTE     resolved configuration, printed redacted so two boxes can be
//            compared without guessing.

export interface ConfigProblem {
  level: "refuse" | "warn";
  name: string;
  detail: string;
}

/**
 * Can a REAL third-party credential reach this box?
 *
 * The only configuration in which the sealing key's absence can do harm. A
 * developer on the eBay sandbox with no application keys, and no Twitch
 * application, has no route by which a seller's refresh token can arrive —
 * and refusing to start there, or refusing their connect flow, would teach
 * them to set a key that protects nothing.
 *
 * Both halves count: an eBay refresh token is eighteen months of "act as this
 * seller on eBay", and a Twitch refresh token speaks in a channel's chat as
 * its owner. Both are sealed by the same function.
 */
export function holdsRealCredentials(env: NodeJS.ProcessEnv): boolean {
  const ebayLive =
    (env.EBAY_ENV || "sandbox") === "production" && Boolean(env.EBAY_APP_ID && env.EBAY_CERT_ID);
  const twitchLive = Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
  return ebayLive || twitchLive;
}

export function canHoldSellerTokens(): boolean {
  // Read live rather than off the snapshot above, because this is a SAFETY
  // gate and it must answer for the process as it is now.
  //
  // Under test it is off unless asked for, mirroring exactly what the eBay,
  // Twitch and Reddit keys already do in this file: `process.loadEnvFile()`
  // puts a developer's real .env into `process.env`, and a suite that read it
  // would refuse to seal on the machine of whoever happens to have production
  // keys and pass everywhere else.
  if (process.env.NODE_ENV === "test" && process.env.SIDESTAGE_CREDENTIAL_GATE !== "1") return false;
  return holdsRealCredentials(process.env);
}

export function checkConfig(): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  for (const b of badNumbers) {
    problems.push({
      level: "warn",
      name: b.name,
      detail: `is not a number ("${b.value}") — using ${b.using}. The value in your .env is NOT the value in force.`,
    });
  }

  // A malformed proxy URL does not fail its own feature: `discoveryProxy()`
  // throws from inside `openContext`, so a typo here breaks EVERY browser
  // launch in the process — including the Whatnot and TikTok room watchers,
  // which do not use the proxy at all. Caught at boot, where it is one line,
  // rather than at 2am as "Discover is blocked".
  const proxy = process.env.EBAY_DISCOVERY_PROXY?.trim();
  if (proxy) {
    try {
      const u = new URL(proxy);
      if (!/^(https?|socks[45]?):$/.test(u.protocol)) {
        problems.push({ level: "refuse", name: "EBAY_DISCOVERY_PROXY", detail: `protocol "${u.protocol}" is not http, https or socks5` });
      }
    } catch {
      problems.push({ level: "refuse", name: "EBAY_DISCOVERY_PROXY", detail: "is not a URL — every browser launch in this process would throw" });
    }
  }

  // A seller's eBay REFRESH token is eighteen months of "act as this seller on
  // eBay". `seal.ts` stores it in the clear when this key is absent and warns
  // exactly once, on the first seal — a single line which, in a process that
  // produced eleven lines in sixteen hours, reached nobody.
  //
  // WHAT WE CHOSE, and why it is not "refuse to start":
  //
  // Refusing to boot would take the whole product down on the next deploy —
  // every watched show, every report, every follow-up — to protect a credential
  // that only arrives on one route. It would also be a hard failure for a fresh
  // clone and for the test suite, neither of which has a key and neither of
  // which can come to any harm without one. A crash-looping container is a
  // worse thing to meet mid-incident than a banner.
  //
  // So: LOUD AT BOOT, once, naming exactly what is at risk and exactly how to
  // fix it — the banner in src/index.ts, plus /api/diagnostics so a monitor can
  // see it without reading a log. The sealing code is unchanged and still
  // stores what it is given. The defect was never that code; it was that the
  // key's absence was discovered lazily at the first seal, as one line in a
  // process that emitted eleven in sixteen hours.
  const sealKey = (process.env.EBAY_TOKEN_KEY || "").trim();
  if (sealKey && !/^[0-9a-fA-F]{64}$/.test(sealKey)) {
    problems.push({
      level: "refuse",
      name: "EBAY_TOKEN_KEY",
      detail:
        "must be 32 bytes as 64 hex characters. A malformed key throws on the FIRST seal, which is " +
        "a 500 on a seller's eBay callback rather than a failed boot — and every token already sealed " +
        "with the real key is unreadable until it is restored.",
    });
  } else if (!sealKey && canHoldSellerTokens()) {
    problems.push({
      level: "warn",
      name: "EBAY_TOKEN_KEY",
      detail:
        "IS NOT SET, and this box can receive a REAL third-party credential. Refresh tokens are " +
        "being stored in Postgres AS TEXT — eighteen months of acting as that seller on eBay, or " +
        "speaking as that channel on Twitch. Generate a key with: openssl rand -hex 32",
    });
  }

  if (!process.env.DATABASE_URL && process.env.NODE_ENV !== "test") {
    problems.push({
      level: "warn",
      name: "DATABASE_URL",
      detail: `is not set — using ${config.databaseUrl}`,
    });
  }

  if (config.maxScrapedRooms > config.maxBrowsers) {
    problems.push({
      level: "refuse",
      name: "MAX_SCRAPED_ROOMS",
      detail: `is ${config.maxScrapedRooms} but MAX_BROWSERS is ${config.maxBrowsers} — the room cap could never be reached, and the browser cap would refuse an attach the show cap allowed`,
    });
  }

  return problems;
}

/** The resolved configuration, safe to print. Secrets become set/unset. */
export function configSummary(): Record<string, string | number | boolean> {
  const set = (v: string | undefined) => (v ? "set" : "unset");
  return {
    port: config.port,
    database: config.databaseUrl.replace(/\/\/[^@]*@/, "//***@"),
    llmBase: config.whissle.base,
    whissleApiKey: set(config.whissle.apiKey),
    whissleAgentId: set(config.whissle.agentId),
    ebayEnv: config.ebay.env,
    ebayAppId: set(config.ebay.appId),
    ebayTokenKey: set(process.env.EBAY_TOKEN_KEY),
    ebayDiscoveryProxy: set(process.env.EBAY_DISCOVERY_PROXY),
    twitchClientId: set(config.twitch.clientId),
    redditClientId: set(config.reddit.clientId),
    maxWatchedShows: config.maxWatchedShows,
    maxScrapedRooms: config.maxScrapedRooms,
    maxBrowsers: config.maxBrowsers,
    replyConcurrency: config.replyConcurrency,
    proposalsPerMin: config.proposalsPerMin,
    latencyBudgetMs: config.latencyBudgetMs,
    autonomyDefault: config.autonomyDefault,
    simulate: config.simulate,
    whatnotDiscovery: process.env.WHATNOT_DISCOVERY ?? "(default)",
  };
}
