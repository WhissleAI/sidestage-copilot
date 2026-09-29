// Four things name this backend by an address that is not pinned.
//
// The deployed frontend bundle contains `https://35-173-35-240.sslip.io`, which
// is the EC2 instance's public address wrapped in sslip.io. It is NOT an Elastic
// IP — `aws ec2 describe-addresses --public-ips 35.173.35.240` answers
// `InvalidAddress.NotFound` — so a stop/start, an instance replacement or an AWS
// maintenance event hands the box a different one.
//
// When it moves, these break together:
//
//   the frontend    VITE_API_BASE, baked into the bundle at BUILD time, so it
//                   needs a rebuild and a redeploy rather than a setting change
//   the TLS name    Caddy's certificate is for <ip-with-dashes>.sslip.io
//   eBay OAuth      the redirect registered against the app's RuName
//   eBay deletion   EBAY_DELETION_ENDPOINT, registered verbatim, and a
//                   compliance requirement eBay enforces
//
// And the deploy would not have said so: it derives SITE from whatever address
// the instance currently has, so it would stand up a working backend on a NEW
// hostname, get a new certificate for it, print "running <sha>" and exit 0 —
// while the frontend kept calling an address with nothing on it. The same
// "merged is not live" shape as the Caddyfile that never reloaded.
//
// Attaching an Elastic IP is the actual fix and it is not a test's to make: it
// allocates a billable resource, changes the address once more on the way, and
// requires re-registering with eBay. This file holds the guard that makes the
// change LOUD instead of silent.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("the address the product is nailed to", () => {
  test("is written down, once, where a diff shows it moving", () => {
    const raw = read("deploy/EXPECTED_ADDRESS");
    const addr = raw
      .split("\n")
      .filter((l) => !l.startsWith("#"))
      .join("")
      .trim();
    assert.match(addr, /^\d{1,3}(\.\d{1,3}){3}$/, "one IPv4 address and nothing else");
    // The file's whole value is that it is checked. If the comment explaining
    // why goes, the next person deletes the file.
    assert.match(raw, /NOT an Elastic IP/i);
    assert.match(raw, /EBAY_DELETION_ENDPOINT/);
  });

  test("the deploy refuses when the instance no longer has it", () => {
    const sh = read("scripts/deploy-aws.sh");
    assert.match(sh, /EXPECTED_ADDRESS/, "the deploy must read the file");
    assert.match(sh, /\[ "\$EXPECTED" != "\$IP" \]/, "and compare it to the live address");
    // Fatal by default. A warning in a deploy log is a warning nobody reads —
    // and this one has to be read before the frontend is rebuilt.
    const at = sh.indexOf("public address has changed");
    assert.ok(at > 0);
    assert.match(sh.slice(at, at + 1800), /exit 1/, "a moved address must fail the deploy");
    assert.match(sh.slice(at, at + 1800), /SIDESTAGE_ADDRESS_MOVED/, "with a deliberate way through");
  });

  test("and the message names every one of the four things that break", () => {
    const sh = read("scripts/deploy-aws.sh");
    const msg = sh.slice(sh.indexOf("public address has changed"), sh.indexOf("SIDESTAGE_ADDRESS_MOVED=1 $0"));
    for (const needed of ["VITE_API_BASE", "REDEPLOY", "EBAY_RUNAME", "EBAY_DELETION_ENDPOINT", "EXPECTED_ADDRESS"]) {
      assert.ok(msg.includes(needed), `the failure message does not mention ${needed}`);
    }
    // The one that is easiest to get wrong: changing the Vercel variable does
    // nothing on its own, because it is inlined at build time.
    assert.match(msg, /baked into\s+#?\s*the bundle at build time/);
  });

  test("the compose file still derives eBay's deletion endpoint from that name", () => {
    // If this stops being true the guard above is guarding nothing.
    assert.match(
      read("docker-compose.yml"),
      /EBAY_DELETION_ENDPOINT: https:\/\/\$\{SITE_ADDRESS\}\/api\/ebay\/account-deletion/,
    );
  });
});
