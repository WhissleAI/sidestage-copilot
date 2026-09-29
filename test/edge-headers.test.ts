import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Caddy is where this service's response headers come from, and it had none.
 *
 * Measured, not assumed: `curl -D - https://35-173-35-240.sslip.io/health`
 * returned content-type, date, vary and via. No HSTS, no nosniff, no referrer
 * policy, no framing rule. A missing header breaks nothing and appears nowhere,
 * which is how it survived every round of work on this repo.
 *
 * The part worth a test is not the presence of the fields — it is the `?`.
 * Caddy's `?` means "only if the response does not already carry this one", and
 * without it a site-wide `header` block REPLACES what a route set. This service
 * has exactly one route that sets its own: `/audio-bridge` ships a per-response
 * nonce CSP and `referrer-policy: no-referrer`. A plain directive here would
 * hard-code a weaker referrer policy onto the one page that renders HTML and
 * captures audio — hardening the API by loosening its most sensitive surface.
 */
const CADDYFILE = readFileSync(new URL("../deploy/Caddyfile", import.meta.url), "utf8");

/** The field lines inside the top-level `header { … }` block. */
const headerBlock = (): string[] => {
  const at = CADDYFILE.indexOf("header {");
  assert.notEqual(at, -1, "no header block in deploy/Caddyfile");
  const end = CADDYFILE.indexOf("\n\t}", at);
  return CADDYFILE.slice(at, end)
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
};

test("the proxy sets the headers the app does not", () => {
  const fields = headerBlock().map((l) => l.split(/\s+/)[0]!.toLowerCase());
  for (const f of [
    "?strict-transport-security",
    "?x-content-type-options",
    "?referrer-policy",
    "?x-frame-options",
  ]) {
    assert.ok(fields.includes(f), `deploy/Caddyfile is missing ${f}`);
  }
});

test("every field defers to a route that set its own", () => {
  for (const line of headerBlock()) {
    assert.ok(
      line.startsWith("?"),
      `\`${line}\` would REPLACE what a route set — /audio-bridge's own CSP and ` +
        `no-referrer are exactly what that breaks. Prefix it with ?`,
    );
  }
});

test("HSTS claims nothing about the names beside this one", () => {
  const hsts = headerBlock().find((l) => l.toLowerCase().startsWith("?strict-transport-security"))!;
  // This host is a sslip.io subdomain. includeSubDomains here would assert a
  // policy for hosts this service does not own, and preload is irreversible.
  assert.ok(!/includeSubDomains/i.test(hsts), hsts);
  assert.ok(!/preload/i.test(hsts), hsts);
  assert.match(hsts, /max-age=\d{7,}/, "an HSTS max-age under ~4 months is not worth asserting");
});
