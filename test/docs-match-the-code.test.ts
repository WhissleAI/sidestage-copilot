// The PRD and TDD are the artifacts a reviewer diffs against the code, so a
// stale line in them is a defect in the deliverable — and nothing was checking.
//
// Three drifted in one week, two of them written by the change that caused
// them: the answered-rate row said nothing about needing a surface that can
// post, §7 still said confidence came from guard outcomes alone after it had
// also moved onto whether the draft used its grounding, and the TDD described
// `verify()` without saying an empty chain passes trivially. Earlier in the
// same run, the docs described a fifty-agent cap for a week after the build
// moved to the lightweight lane.
//
// Prose cannot be pinned. Two things can: the FILE PATHS the docs point at,
// and the NUMBERS they quote. Both are exactly what goes stale when code moves.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const docs = [
  ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => join("docs", f)),
  "README.md",
].filter((f) => existsSync(join(root, f)));

const text = (rel: string) => readFileSync(join(root, rel), "utf8");
const all = docs.map((d) => ({ rel: d, src: text(d) }));

/** Paths that live in the console repo, not this one. */
const CROSS_REPO = /^src\/(?:lib|components|routes)\//;

describe("every source path the docs point at exists", () => {
  for (const { rel, src } of all) {
    test(rel, () => {
      const cited = [...src.matchAll(/`(src\/[A-Za-z0-9_./-]+?\.ts)`/g)].map((m) => m[1]!);
      const missing = [...new Set(cited)]
        .filter((p) => !CROSS_REPO.test(p))
        .filter((p) => !existsSync(join(root, p)));
      assert.deepEqual(missing, [], `${rel} points at files that no longer exist`);
    });
  }
});

/**
 * Numbers the docs quote, bound to the constant that decides them.
 *
 * Each entry is a claim a reader will act on. If the constant moves and the
 * prose does not, this fails and names both.
 */
const BOUND: { what: string; file: string; constant: RegExp; inDocs: RegExp }[] = [
  {
    what: "auto-send confidence floor",
    file: "src/autonomy/ladder.ts",
    constant: /AUTO_CONFIDENCE_FLOOR = ([\d.]+)/,
    inDocs: /0\.8 confidence floor/,
  },
  {
    what: "abstain BM25 threshold",
    file: "src/retrieval/retriever.ts",
    constant: /ABSTAIN_BM25_BELOW = ([\d.]+)/,
    inDocs: /BM25[^.\n]{0,40}\b4\.0\b|\b4\.0\b[^.\n]{0,40}BM25/,
  },
  {
    what: "follow-ups drafted per build",
    file: "src/surfaces/dm/drafts.ts",
    constant: /MAX_PER_BUILD = (\d+)/,
    inDocs: /\b50\b/,
  },
  // REVIEW.md F-14 now quotes all three limits. It previously said rate
  // limiting was absent, months after it shipped.
  {
    what: "auth requests a minute per address",
    file: "src/api/routes.ts",
    constant: /AUTH_LIMIT = \{ windowMs: 60_000, max: (\d+) \}/,
    inDocs: /\*\*(\d+) auth requests a minute per address\*\*/,
  },
  {
    what: "login attempts per email per window",
    file: "src/api/routes.ts",
    constant: /LOGIN_ACCOUNT_LIMIT = \{ windowMs: 10 \* 60_000, max: (\d+) \}/,
    inDocs: /\*\*(\d+) attempts per EMAIL in ten\s+minutes\*\*/,
  },
];

/**
 * A doc must not assert the ABSENCE of something the code has.
 *
 * This is the failure that produced the entry above, and it is a different
 * failure from a stale number: REVIEW.md's F-14 read "rate limiting on the API
 * itself is still absent" while `src/api/rateLimit.ts` had been in the tree for
 * two weeks, enforcing three limits in production. A number going stale is
 * noise; a status line saying a control does not exist is a reviewer's decision
 * made on false information, in the one document written to be diffed against
 * the code.
 *
 * Narrow on purpose — each row is a specific sentence, not a heuristic — so
 * that a row can only ever fail for the reason it was added.
 */
const DENIED_ABSENCE: { phrase: RegExp; provenBy: string; what: string }[] = [
  {
    what: "rate limiting",
    phrase: /rate limiting[^.\n]*\b(?:is|remains)\s+(?:still\s+)?absent/i,
    provenBy: "src/api/rateLimit.ts",
  },
  {
    // The same claim lived a second life as a to-do in the TDD's "what I would
    // do next", which is an absence claim in a different grammar.
    what: "rate limiting, as an outstanding task",
    phrase: /\*\*Rate limiting on the API\*\*/,
    provenBy: "src/api/rateLimit.ts",
  },
  {
    what: "the watchdog's own test",
    phrase: /watchdog[^.\n]*has no test of its own \| \*\*Open\*\*/i,
    provenBy: "test/watchdog-quiet-versus-dead.test.ts",
  },
];

describe("numbers in the docs match the constants that decide them", () => {
  for (const b of BOUND) {
    test(b.what, () => {
      const code = text(b.file).match(b.constant);
      assert.ok(code, `${b.file} no longer defines ${b.constant}`);
      const value = code![1]!;

      const mentions = all.filter((d) => b.inDocs.test(d.src));
      assert.ok(mentions.length > 0, `no doc states the ${b.what}; it is worth stating`);

      for (const d of mentions) {
        assert.ok(
          d.src.includes(value),
          `${d.rel} describes the ${b.what} but does not contain ${value} — the constant in ${b.file} moved`,
        );
      }
    });
  }
});

/**
 * The latency allocation lives in three places and nothing compared them.
 *
 * `config.latencyBudgetMs` (2000) is the target the code enforces. TDD §5
 * publishes a table of per-stage budgets. `src/latency/spans.ts` repeats that
 * allocation in a comment. All three agree today, by hand.
 *
 * The failure is quiet and specific: change one stage's budget without
 * adjusting headroom and the table stops adding up to the target it claims to
 * allocate — while every number in it still looks reasonable on its own.
 */
describe("the latency budget adds up", () => {
  const tdd = text("docs/TDD.md");
  const spans = text("src/latency/spans.ts");

  /** Stage rows of the §5 table: `| name | 120 ms | …`. */
  const stageBudgets = (src: string, re: RegExp) =>
    [...src.matchAll(re)].map((m) => ({ stage: m[1]!.trim(), ms: Number(m[2]) }));

  const fromTable = stageBudgets(
    tdd,
    /^\|\s*(admit \+ classify|retrieve|compose|guard|headroom)\s*\|\s*(\d+) ms\s*\|/gm,
  );
  const fromComment = stageBudgets(
    spans,
    /^\/\/\s+(admit \+ classify|retrieve|compose|guard|headroom)\s+(\d+) ms/gm,
  );

  test("TDD §5 publishes all five stages", () => {
    assert.equal(fromTable.length, 5, `found ${fromTable.map((s) => s.stage).join(", ")}`);
  });

  test("the stages sum to the target the code enforces", () => {
    const target = Number(text("src/config.ts").match(/latencyBudgetMs: num\("LATENCY_BUDGET_MS", (\d+)\)/)![1]);
    const sum = fromTable.reduce((a, s) => a + s.ms, 0);
    assert.equal(
      sum,
      target,
      `TDD §5 allocates ${sum} ms across its stages but the enforced budget is ${target} ms ` +
        "— a stage budget moved without headroom moving with it",
    );
    assert.ok(tdd.includes(`p95 < ${target} ms`), `TDD §5 states a target other than ${target} ms`);
  });

  test("spans.ts repeats the same allocation, stage for stage", () => {
    assert.deepEqual(
      fromComment,
      fromTable,
      "the allocation comment in src/latency/spans.ts has drifted from TDD §5",
    );
  });
});

describe("the submission's own checklist is intact", () => {
  test("README carries all six required labels", () => {
    // The brief names these exactly; a reviewer looks for them by name.
    const readme = text("README.md");
    for (const label of ["PRD", "TDD", "Prototype", "Source code", "Access notes", "Known limitations"]) {
      assert.ok(readme.includes(label), `README is missing the "${label}" section`);
    }
  });
});

describe("no doc claims something is missing that is in the tree", () => {
  for (const row of DENIED_ABSENCE) {
    test(`${row.what} exists, so nothing may say it does not`, () => {
      // If the proof moves, the row is wrong rather than the docs.
      assert.ok(
        existsSync(join(root, row.provenBy)),
        `${row.provenBy} is gone — this row is now checking the wrong thing`,
      );
      for (const d of all) {
        const hit = d.src.match(row.phrase);
        assert.equal(
          hit,
          null,
          `${d.rel} says ${JSON.stringify(hit?.[0])} — but ${row.provenBy} exists. ` +
            `A status line claiming a control is absent is a reviewer's decision made on false information.`,
        );
      }
    });
  }
});
