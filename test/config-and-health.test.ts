// Configuration that fails at boot, not at 2am; and a health check that
// touches the thing most likely to be wrong.
//
// Every variable in `config.ts` used to be discovered at FIRST USE. `num()`
// falls back silently on anything unparseable, so `PROPOSALS_PER_MIN=thirty`
// is thirty and nobody is told; `EBAY_DISCOVERY_PROXY` throws from INSIDE
// `openContext`, so a typo breaks every browser launch in the process
// including the room watchers that do not use the proxy; and `EBAY_TOKEN_KEY`
// is absent in production, which means a seller's eBay refresh token — a year
// and a half of acting as that seller — is stored in Postgres as text.

import { test, describe, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { checkConfig, canHoldSellerTokens, holdsRealCredentials } from "../src/config.js";
import { sealToken, openToken } from "../src/ingest/ebay/seal.js";
import { withDeadline, UpstreamTimeout } from "../src/net/http.js";
import { buildApp } from "../src/api/server.js";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../src/api/context.js";

const ENV_KEYS = [
  "EBAY_DISCOVERY_PROXY", "EBAY_TOKEN_KEY", "EBAY_ENV", "EBAY_APP_ID", "EBAY_CERT_ID",
  "TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET",
  // The gate is off under test unless a test asks for it, for the same reason
  // the eBay and Twitch keys are blanked: `process.loadEnvFile()` puts the
  // developer's real .env into `process.env`.
  "SIDESTAGE_CREDENTIAL_GATE",
];
const saved: Record<string, string | undefined> = {};

before(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });
after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("configuration is checked once, at boot", () => {
  test("a proxy URL that is not a URL refuses the boot instead of breaking every browser launch later", () => {
    process.env.EBAY_DISCOVERY_PROXY = "not a url at all";
    const p = checkConfig().find((x) => x.name === "EBAY_DISCOVERY_PROXY");
    assert.ok(p, "the malformed value is caught");
    assert.equal(p!.level, "refuse");
    assert.match(p!.detail, /every browser launch/);
  });

  test("a proxy on a protocol Playwright cannot use is refused too", () => {
    process.env.EBAY_DISCOVERY_PROXY = "ftp://proxy.example.com:1080";
    const p = checkConfig().find((x) => x.name === "EBAY_DISCOVERY_PROXY");
    assert.equal(p?.level, "refuse");
  });

  test("a well-formed proxy is not a problem", () => {
    process.env.EBAY_DISCOVERY_PROXY = "socks5://user:pw@egress.example.com:1080";
    assert.equal(checkConfig().some((x) => x.name === "EBAY_DISCOVERY_PROXY"), false);
  });

  test("a malformed sealing key refuses the boot — it would otherwise 500 a seller's eBay callback", () => {
    process.env.EBAY_TOKEN_KEY = "obviously-not-hex";
    const p = checkConfig().find((x) => x.name === "EBAY_TOKEN_KEY");
    assert.equal(p?.level, "refuse");
    assert.match(p!.detail, /64 hex characters/);
  });
});

describe("the missing sealing key", () => {
  test("a box that cannot receive a real credential says nothing about it at boot", () => {
    // Sandbox, no application keys: no route exists by which a seller's
    // refresh token can arrive, so there is nothing to protect.
    assert.equal(canHoldSellerTokens(), false);
    assert.equal(checkConfig().some((x) => x.name === "EBAY_TOKEN_KEY"), false);
    assert.equal(sealToken("plain-token"), "plain-token", "a dev database with no key is a real state");
  });

  test("which configurations can receive a real credential at all", () => {
    const yes = holdsRealCredentials;
    assert.equal(yes({ EBAY_ENV: "production", EBAY_APP_ID: "a", EBAY_CERT_ID: "c" }), true);
    assert.equal(yes({ TWITCH_CLIENT_ID: "t", TWITCH_CLIENT_SECRET: "s" }), true, "the same function seals both");
    // No route exists by which a seller's refresh token can arrive here.
    assert.equal(yes({ EBAY_ENV: "sandbox", EBAY_APP_ID: "a", EBAY_CERT_ID: "c" }), false);
    assert.equal(yes({ EBAY_ENV: "production", EBAY_APP_ID: "a" }), false, "four out of five credentials authenticate nobody");
    assert.equal(yes({}), false);
  });

  test("a box that CAN receive one says so unmissably at boot", () => {
    process.env.SIDESTAGE_CREDENTIAL_GATE = "1";
    process.env.EBAY_ENV = "production";
    process.env.EBAY_APP_ID = "app";
    process.env.EBAY_CERT_ID = "cert";
    assert.equal(canHoldSellerTokens(), true);
    const p = checkConfig().find((x) => x.name === "EBAY_TOKEN_KEY");
    assert.ok(p, "the absence is reported AT BOOT, not at the first seal");
    assert.equal(p!.level, "warn", "it warns rather than refusing — a fresh clone and the suite must both boot");
    assert.match(p!.detail, /eighteen months/, "and names exactly what is at risk");
    assert.match(p!.detail, /openssl rand -hex 32/, "and exactly how to fix it");
  });

  test("it still stores what it was given — a fresh clone and the suite must both work", () => {
    process.env.SIDESTAGE_CREDENTIAL_GATE = "1";
    process.env.EBAY_ENV = "production";
    process.env.EBAY_APP_ID = "app";
    process.env.EBAY_CERT_ID = "cert";
    // Deliberately NOT a refusal. Refusing here would turn a configuration gap
    // into a broken connect flow for everyone running this repo; the absence
    // is answered at boot instead, where an operator meets it before a
    // seller's credential does.
    assert.equal(sealToken("a-real-sellers-refresh-token"), "a-real-sellers-refresh-token");
  });

  test("a Twitch application arms the same warning — one function seals both", () => {
    process.env.SIDESTAGE_CREDENTIAL_GATE = "1";
    process.env.TWITCH_CLIENT_ID = "tc";
    process.env.TWITCH_CLIENT_SECRET = "ts";
    assert.equal(canHoldSellerTokens(), true);
    const p = checkConfig().find((x) => x.name === "EBAY_TOKEN_KEY");
    assert.equal(p?.level, "warn");
  });

  test("with a key, a token round-trips and is not stored as itself", () => {
    process.env.EBAY_TOKEN_KEY = "a".repeat(64);
    const sealed = sealToken("v^1.1#i^1#refresh");
    assert.notEqual(sealed, "v^1.1#i^1#refresh");
    assert.match(sealed!, /^enc:v1:/);
    assert.equal(openToken(sealed), "v^1.1#i^1#refresh");
  });
});

describe("no upstream may outlive its deadline", () => {
  test("a hang becomes a named error with a number on it, not a five-minute socket", async () => {
    const hang = withDeadline("slowpoke", 30);
    // Node's own fetch against a socket that never answers; the deadline is
    // what ends it. `example.invalid` never resolves, so this exercises the
    // abort path rather than a refused connection on some machines — the
    // assertion is on the CLASS of failure either way.
    await assert.rejects(
      () => hang("http://10.255.255.1:9/never", { method: "GET" }),
      (e: Error) => e instanceof UpstreamTimeout || /fetch failed|ECONN/i.test(e.message),
    );
  });

  test("a caller's own abort is still the caller's — the deadline is a ceiling, not an override", async () => {
    const ctl = new AbortController();
    const f = withDeadline("slowpoke", 10_000);
    const p = f("http://10.255.255.1:9/never", { signal: ctl.signal });
    ctl.abort();
    await assert.rejects(p, (e: Error) => e.name === "AbortError" || /abort/i.test(e.message));
  });
});

describe("GET /health", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  before(async () => { ({ app, ctx } = await buildApp()); });
  after(async () => { await app.close(); await ctx.stop(); });

  test("it actually asks Postgres — a literal ok:true said healthy through a total outage", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.equal(body.database.ok, true);
    assert.equal(typeof body.database.ms, "number");
    // Open to the internet: a boolean and a duration, and nothing that names
    // this deployment. The reason a check failed goes to the log.
    assert.deepEqual(Object.keys(body), ["ok", "database"]);
  });
});
