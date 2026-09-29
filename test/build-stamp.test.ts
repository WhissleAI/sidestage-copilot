// Can this service tell you what it is?
//
// It could not. `/health` answers "ok", `/api/diagnostics` describes
// configuration, and no route, log line or file named the commit — so "merged"
// and "live" were two separate beliefs with nothing joining them. On 2026-09-28
// that cost an hour: a Caddy config change merged, deployed green, and was not
// serving, and the only way to discover it was to curl the header it should have
// set.
//
// The stamp's one real risk is fabrication. A missing stamp costs a question; a
// WRONG one is believed, and sends whoever is debugging to the wrong commit. So
// the tests here are almost all about refusing to invent a value.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const text = (p: string) => readFileSync(join(root, p), "utf8");

describe("the build stamp", () => {
  test("running from source reports unknown rather than a guess", async () => {
    // No image, so no /app/build.json — which is exactly how the test suite and
    // `npm start` run. The module must say so.
    assert.equal(existsSync(join(root, "build.json")), false, "a stray build.json would void this test");
    const { build } = await import("../src/obs/build.js");
    assert.equal(build.sha, "unknown");
    assert.equal(build.builtAt, null);
    assert.equal(build.short, "unknown");
  });

  test("the image bakes it, and the compose build passes it through", () => {
    const dockerfile = text("Dockerfile");
    assert.match(dockerfile, /ARG GIT_SHA=unknown/, "a default of unknown, not an empty string");
    assert.match(dockerfile, /> \/app\/build\.json/, "the stamp must be written into the image");
    // Baked, not derived. A stamp computed at container start describes the box,
    // not the image, which is the thing in question.
    assert.ok(
      !/rev-parse/.test(dockerfile),
      "the image must not ask git anything — the source tree is not in it",
    );

    const compose = text("docker-compose.yml");
    assert.match(compose, /GIT_SHA: \$\{GIT_SHA:-unknown\}/);
    assert.match(compose, /BUILT_AT: \$\{BUILT_AT:-\}/);
  });

  test("the deploy refuses a stamp that would name the wrong commit", () => {
    const sh = text("scripts/deploy-aws.sh");
    // A dirty tree means the SHA does not describe what is being built.
    assert.match(sh, /diff --quiet HEAD/, "the deploy must notice an uncommitted tree");
    assert.match(sh, /SIDESTAGE_ALLOW_DIRTY/, "and offer a deliberate override rather than no way through");
    assert.match(sh, /-dirty/, "an overridden stamp must say it is not a clean commit");
  });

  test("the deploy asks the RUNNING container what it is", () => {
    const sh = text("scripts/deploy-aws.sh");
    // The check that was missing. `up -d` succeeding is not the process running
    // the new code — that was the whole Caddyfile fault.
    assert.match(sh, /exec -T app cat \/app\/build\.json/);
    assert.match(sh, /is not running the commit just built/);
    // And it must be fatal. A warning in a deploy log is a warning nobody reads.
    const after = sh.slice(sh.indexOf("is not running the commit just built"));
    assert.match(after.slice(0, 400), /exit 1/, "a mismatch must fail the deploy");
  });

  test("it is reported where an operator can see it, and not on the public route", () => {
    const routes = text("src/api/routes.ts");
    const diag = routes.slice(routes.indexOf('app.get("/api/diagnostics"'));
    assert.match(diag.slice(0, 1200), /\bbuild,/, "/api/diagnostics must carry the stamp");

    // /health is unauthenticated and open to the internet, and says two things
    // on purpose. The stamp names the exact code running, which is not a thing
    // to volunteer to anybody who asks.
    const health = routes.slice(routes.indexOf('app.get("/health"'));
    const body = health.slice(0, health.indexOf("});"));
    assert.ok(!/\bbuild\b/.test(body), "/health must stay at two fields");
  });
});

// ── the suite reads the environment it was given, and nothing else ───────────
//
// `npm test` used to load the developer's `.env`, which holds a real
// `WHISSLE_API_KEY`. Two failures from one cause, and the second hid the first:
//
//   it spent money      live calls to the gateway on every run. The dry-run
//                       contract test took 5.3 SECONDS, which is a network
//                       round trip, not an assertion
//   it was not hermetic `test/contract.test.ts` passed on a clean checkout and
//                       failed on mine at "the cap did not latch", with nothing
//                       in any diff to explain it. A real key, two layers away
//
// `ensure-test-db.mjs` already keeps the suite out of the developer's database.
// This is the other half of the same principle.

describe("a test run is the run CI does", () => {
  test("config.ts does not read .env under NODE_ENV=test", () => {
    const cfg = text("src/config.ts");
    assert.match(cfg, /NODE_ENV !== "test"/, "loadEnvFile must be conditional");
    // Guarded, not merely mentioned: the call itself must sit behind the flag.
    const at = cfg.indexOf("process.loadEnvFile()");
    assert.ok(at > cfg.indexOf("const LOAD_ENV_FILE"), "the flag must be declared before the call");
    assert.match(
      cfg.slice(cfg.lastIndexOf("if (", at), at),
      /LOAD_ENV_FILE/,
      "loadEnvFile() is not inside the LOAD_ENV_FILE guard",
    );
  });

  test("and no live credential is in scope while it runs", () => {
    // If this ever fails, the suite is about to bill somebody. It checks the
    // ambient environment rather than the file, because an exported variable
    // reaches the run whatever config.ts does.
    for (const k of ["WHISSLE_API_KEY", "WHISSLE_AGENT_ID"]) {
      const v = process.env[k] ?? "";
      assert.equal(v, "", `${k} is set — the suite would make real, billed calls`);
    }
  });
});
