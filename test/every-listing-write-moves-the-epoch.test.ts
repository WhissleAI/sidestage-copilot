// A listing write that does not bump the epoch is an index that stays behind.
//
// This closes an investigation that was open for most of a day, and the evidence
// was in the rows the whole time — it only became readable once there was a
// backup to restore.
//
// THE FAILURE. Show `ebay_SS3GJuvi72bMEauo-2`, a crystals seller, 2026-09-28
// 15:59–16:36 UTC: thirteen questions, thirteen drafts, **zero evidence on every
// one**, confidence 0. Buyers asked "do you have any spiders?", "can you show me
// last red sphere", "any dragons?". Fifty of the show's fifty-three listings were
// already in Postgres before the first draft.
//
// THE PROOF IT WAS THE INDEX. Running the SHIPPED `Retriever` over that same
// restored catalog today:
//
//   "do you have any spiders?"      16 facts, bm25Top 5.15 — finds the
//                                   Labradorite Spider. abstain=false
//   "can you show me last red sphere" 8 facts, bm25Top 7.97 — finds the spheres
//   "any dragons?"                   1 fact — there are no dragons. Correct.
//   "how much"                       abstain=true — no referent. Correct.
//
// Retrieval was never the problem. The index was behind the listings at drafting
// time, which is precisely what `Retriever.stale` and the pipeline's rebuild
// backstop were written for — merged 2026-09-28 19:46 UTC, **three hours after**
// those drafts ran. `test/index-cannot-go-stale.test.ts` covers the mechanism.
//
// THIS FILE covers the part the mechanism depends on: staleness is detected by a
// write epoch that `Repo.q()` bumps when it sees a statement mutating `listings`.
// A write that goes around `Repo` does not move it, the retriever never learns it
// is behind, and the failure above comes back with the backstop in place and
// every test green.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );

/**
 * Files allowed to write `listings` without going through `Repo.q()`, and why.
 *
 * `db/seed.ts` runs in exactly one place — `buildContext()`, before any
 * `Retriever` exists, only when DEMO_SHOW=1 and only when the demo show has no
 * listings yet (`api/context.ts`). No live index can be stale across it. If it
 * ever becomes reachable from a request, it belongs behind `Repo` instead.
 */
const ALLOWED = new Map([["src/db/seed.ts", "startup only, before any Retriever exists"]]);

const MUTATES = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+listings\b/i;

describe("every listing write moves the staleness epoch", () => {
  test("nothing outside Repo writes listings, except what is declared", () => {
    const offenders: string[] = [];
    for (const rel of walk("src")) {
      if (rel === "src/domain/repo.ts" || ALLOWED.has(rel)) continue;
      const src = read(rel)
        // Comments describe these statements; only real SQL counts.
        .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
        .replace(/\/\/[^\n]*/g, (c) => " ".repeat(c.length));
      if (MUTATES.test(src)) offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      "these mutate `listings` outside Repo, so `listingEpochOf` does not move and the retriever " +
        "never learns its index is behind — the exact failure that produced 13 ungrounded drafts " +
        "on 2026-09-28. Route the write through `Repo.q()`, or add it to ALLOWED with a reason",
    );
  });

  test("the declared exception is still only reachable at startup", () => {
    const ctx = read("src/api/context.ts");
    // If `seed` is ever called from a route, the exception stops holding.
    const callers = walk("src").filter((rel) => rel !== "src/db/seed.ts" && /\bseed\(\s*pool\b|\bseed\(\s*db/.test(read(rel)));
    assert.deepEqual(callers, ["src/api/context.ts"], "seed() gained a caller outside buildContext");
    assert.match(ctx, /demoWanted\(\)/, "and it is still behind the demo flag");
  });

  test("Repo detects a mutation by the SQL, not by the method that sent it", () => {
    const repo = read("src/domain/repo.ts");
    // The reason this is robust: a write method added later cannot forget to
    // call something it does not know about.
    assert.match(repo, /const MUTATES_LISTINGS = /);
    const q = repo.slice(repo.indexOf("private q<"));
    assert.match(q.slice(0, 1200), /MUTATES_LISTINGS\.test\(sql\)/, "the check must be inside q()");
    assert.match(q.slice(0, 1200), /listingEpoch\.set\(/);
  });
});
