// Tenancy is enforced on data and not on capacity, and the difference is worth
// a test rather than a discovery.
//
// `show_id` scoping, an ownership preHandler and sealed per-account eBay
// tokens keep one seller's rows away from another's — six contract tests hold
// that. `MAX_WATCHED_SHOWS` does not: it counts `runtimes.size +
// attaching.size` across the whole process, so one account attaching six shows
// makes the seventh attach fail for everyone, with an error naming an
// environment variable.
//
// The limit is right for what it was written for — six Whatnot sessions is six
// real Chromes in one container, and the app dies rather than degrades. It was
// never a fairness mechanism. This test pins the distinction so that a
// per-account share, when it lands, replaces the global count rather than
// sitting beside it and disagreeing.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const registry = readFileSync(new URL("../src/shows/registry.ts", import.meta.url), "utf8");

describe("the watch cap is process-wide, deliberately and visibly", () => {
  test("it counts every runtime, not an account's", () => {
    assert.match(registry, /this\.runtimes\.size \+ this\.attaching\.size/);
    // If this ever becomes account-scoped, the docs claiming otherwise must
    // move with it — README item 23 and TDD §6a.
    assert.ok(
      !/owner_account_id|ownerAccountId/.test(
        registry.slice(registry.indexOf("const watching ="), registry.indexOf("const watching =") + 400),
      ),
      "the cap now knows about accounts — update TDD §6a and README's known limitations",
    );
  });

  test("the docs say so, in both places a reader looks", () => {
    const tdd = readFileSync(new URL("../docs/TDD.md", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    assert.match(tdd, /Tenancy here is about DATA, not capacity/);
    assert.match(readme, /Capacity is shared across accounts; only data is isolated/);
  });
});
