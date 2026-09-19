/**
 * How often one caller may knock, and how many 16 MB hashes may run at once.
 *
 * There was no limit of any kind. `POST /api/auth/login` runs scrypt at
 * N=2^14 — 16 MB and ~100 ms of CPU — BEFORE the caller is authenticated, in a
 * container capped at 1100 MB, with Fastify applying no concurrency limit: about
 * seventy concurrent logins from one unauthenticated caller exhausted the box
 * and `restart: unless-stopped` served up the next seventy. Password guessing
 * was likewise unbounded.
 *
 * Both halves are tested, because they are different failures: the limiter
 * bounds ARRIVALS, the gate bounds what is in flight AT ONCE.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import type { AppContext } from "../src/api/context.js";
import { Gate, GateBusy, RateLimiter } from "../src/api/rateLimit.js";
import { hashPassword, scryptGate } from "../src/auth/accounts.js";

let app: FastifyInstance;
let ctx: AppContext;
const json = { "content-type": "application/json" };

/** A signed-in operator, minted before anything floods the door. */
let operator: Record<string, string>;

before(async () => {
  ({ app, ctx } = await buildApp());
  const seller = (
    await app.inject({
      method: "POST", url: "/api/auth/register", headers: json,
      payload: { email: `rl-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`, password: "password-123", displayName: "rl" },
    })
  ).json() as { token: string };
  operator = { authorization: `Bearer ${seller.token}` };
});
after(async () => { await app.close(); await ctx.stop(); });

describe("the unauthenticated front door", () => {
  test("a login loop is cut off, with something to act on", async () => {
    const codes: number[] = [];
    let retryAfter: string | undefined;
    for (let i = 0; i < 30; i++) {
      const r = await app.inject({
        method: "POST", url: "/api/auth/login", headers: json,
        // A different email each time: this is the per-ADDRESS limit, and a
        // run that hammered one account would be stopped by the other one.
        payload: { email: `guess${i}@test.local`, password: "not-the-password" },
      });
      codes.push(r.statusCode);
      if (r.statusCode === 429) retryAfter = r.headers["retry-after"] as string;
    }
    assert.ok(codes.includes(429), `thirty sign-in attempts in a row were all allowed: ${codes.join(",")}`);
    assert.ok(codes.filter((c) => c === 429).length >= 4, "the limit is not holding");
    assert.ok(Number(retryAfter) > 0, "a refusal with no Retry-After leaves a client guessing");
    // The first few must still have been answered on their merits: a limit
    // that refuses the FIRST attempt is a sign-in page nobody can use.
    assert.equal(codes[0], 401);
  });

  test("a normal operator's console is nowhere near the limit", async () => {
    // What a console does on one screen: poll a handful of reads. Thirty in a
    // burst, all from one address, must be ordinary traffic — and the session
    // was minted in `before`, ahead of the flood above, because a sign-in that
    // the flood had used up would make this pass for the wrong reason.
    for (let i = 0; i < 30; i++) {
      const r = await app.inject({ method: "GET", url: "/api/shows", headers: operator });
      assert.equal(r.statusCode, 200, `a console poll answered ${r.statusCode} after ${i} reads`);
    }
  });

  test("one account cannot be guessed at from a thousand addresses", async () => {
    // The per-address limit says nothing about a distributed run at ONE
    // seller's password. Different addresses, same email.
    const target = `victim-${Date.now()}@test.local`;
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await app.inject({
        method: "POST", url: "/api/auth/login", headers: { ...json, "x-forwarded-for": `203.0.113.${i}` },
        payload: { email: target, password: `guess-${i}` },
      });
      codes.push(r.statusCode);
    }
    assert.ok(codes.includes(429), `twelve guesses at one account were all answered: ${codes.join(",")}`);
  });

  test("/health is never refused — it is how the box says it is alive", async () => {
    for (let i = 0; i < 300; i++) {
      const r = await app.inject({ method: "GET", url: "/health" });
      if (r.statusCode !== 200) assert.fail(`/health answered ${r.statusCode} on probe ${i}`);
    }
  });
});

describe("the window itself", () => {
  test("counts per key and rolls when the window does", () => {
    let now = 1_000_000;
    const rl = new RateLimiter(() => now);
    const limit = { windowMs: 1_000, max: 3 };
    assert.deepEqual([1, 2, 3].map(() => rl.hit("a", limit).ok), [true, true, true]);
    const refused = rl.hit("a", limit);
    assert.equal(refused.ok, false);
    assert.equal(refused.retryAfterS, 1);
    // One caller's flood is not another caller's problem.
    assert.equal(rl.hit("b", limit).ok, true);
    now += 1_001;
    assert.equal(rl.hit("a", limit).ok, true, "the window never rolled");
  });

  test("forgets keys it no longer needs", () => {
    let now = 2_000_000;
    const rl = new RateLimiter(() => now);
    for (let i = 0; i < 500; i++) rl.hit(`ip-${i}`, { windowMs: 1_000, max: 1 });
    assert.equal(rl.size, 500);
    now += 120_000;
    rl.hit("someone-else", { windowMs: 1_000, max: 1 });
    assert.ok(rl.size < 10, `the limiter kept ${rl.size} dead windows — that is its own leak`);
  });
});

describe("how many 16 MB hashes run at once", () => {
  test("never more than the gate allows, however many arrive together", async () => {
    const before = scryptGate.peak;
    await Promise.all(Array.from({ length: 40 }, () => hashPassword("a-password-to-hash")));
    assert.ok(
      scryptGate.peak <= 6,
      `forty concurrent hashes put ${scryptGate.peak} in flight at once — at 16 MB each that is the OOM`,
    );
    assert.ok(scryptGate.peak >= before, "the gate never ran anything");
  });

  test("a queue that cannot be held is refused, not grown", async () => {
    const gate = new Gate(1, 2);
    let release: (() => void) | null = null;
    const held = gate.run(() => new Promise<void>((r) => { release = r; }));
    const queued = [gate.run(async () => {}), gate.run(async () => {})];
    await assert.rejects(() => gate.run(async () => {}), (e: unknown) => e instanceof GateBusy);
    release!();
    await Promise.all([held, ...queued]);
  });
});
