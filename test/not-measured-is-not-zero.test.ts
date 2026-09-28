// Zero is not "nothing measured", and this codebase kept saying it was.
//
// Eight instances, found one at a time, all the same shape — a rate or a
// percentile over an empty set rendered as a result:
//
//   perHourUsd       spend / 0 working minutes     looked free
//   groundedRate     answered / 0 questions        looked like it answered none
//   gmv per hour     gross / 0 selling hours       a rate over idle attachment
//   console p95      percentile of an empty window "0ms" in green, mid-show
//   worst p95        Math.max(0, ...[])            "0ms" AND a met target
//   cache hit rate   0 / 0 replies                 a cache that never hits
//   finished list    six of eighteen sessions      the rest unreachable
//   audit chains     verify() of an empty chain    "13/13 intact", in green
//
// The convention already exists: `metrics.ts` returns `number | null` from
// every rate helper, for exactly this reason. What failed was the BOUNDARY —
// rates computed inline at a call site skipped the helpers, and one call site
// took a correctly-null helper result and wrote `?? 0`.
//
// So this is a ratchet, not a cleanup. It pins the instances that remain and
// fails on new ones, because the ninth will otherwise look as reasonable as
// the first eight did.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The modules whose job is producing numbers somebody reads. */
const REPORTED = [
  "src/shows/analytics.ts",
  "src/shows/metrics.ts",
  "src/shows/prdMetrics.ts",
  "src/shows/sessionRecord.ts",
  "src/latency/spans.ts",
  "src/guardrails/chain.ts",
];

/**
 * Known remaining zero-fallbacks, with why each is still here.
 *
 * Shrinking this list is the work. Adding to it needs a reason that survives
 * being read out loud.
 */
const ALLOWED: { file: string; needle: string; why: string }[] = [
  {
    file: "src/latency/spans.ts",
    needle: "this._total ? Number((this._cacheHits / this._total).toFixed(3)) : 0",
    why: "ShowReport.engagement.cacheHitRate is a non-null number on every stored report; widening it is a migration, not an edit.",
  },
  {
    file: "src/shows/sessionRecord.ts",
    needle: "?? 0",
    why: "Same field, rebuilt from proposals. Moves with the one above or not at all.",
  },
  {
    file: "src/shows/sessionRecord.ts",
    needle: "Math.floor(q * lat.length))]!) : 0",
    why: "ShowReport.engagement.{median,p95}LatencyMs are non-null on every stored report. Same migration as cacheHitRate, and they move together.",
  },
  {
    file: "src/shows/sessionRecord.ts",
    needle: "sig ? sig.lost(showId) : 0",
    why: "A COUNT, not a rate — and 'we could not ask the signals service' is still a weaker lie than a rate of zero. Moves with the report shape.",
  },
  {
    file: "src/shows/prdMetrics.ts",
    needle: "const hours = show ? durationHours(show.started_at, show.ended_at) : 0",
    why: "Feeds perShowHourCents, which is already null below MIN_HOURS_FOR_RATE — zero hours cannot produce a rate.",
  },
];

const root = join(import.meta.dirname, "..");
const ZERO_FALLBACK = /\?[^:;\n]{0,80}:\s*0\b|Math\.max\(0,\s*\.\.\./g;

describe("a number nobody measured is not zero", () => {
  for (const rel of REPORTED) {
    test(rel, () => {
      const src = readFileSync(join(root, rel), "utf8")
        // Comments describe the bug; they are not the bug.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

      const hits = [...src.matchAll(ZERO_FALLBACK)].map((m) => m[0].trim());
      const allowed = ALLOWED.filter((a) => a.file === rel);
      const unexplained = hits.filter((h) => !allowed.some((a) => h.includes(a.needle) || a.needle.includes(h)));

      assert.deepEqual(
        unexplained,
        [],
        `${rel}: a rate or percentile falling back to 0. Return null, or add it to ALLOWED with a reason.`,
      );
    });
  }

  test("the allow-list only names files that exist", () => {
    for (const a of ALLOWED) assert.ok(statSync(join(root, a.file)).isFile(), a.file);
  });

  test("every reported module is a real file", () => {
    for (const rel of REPORTED) assert.ok(statSync(join(root, rel)).isFile(), rel);
  });

  test("the rate helpers still return null rather than zero", () => {
    // The convention this guard exists to protect.
    const src = readFileSync(join(root, "src/shows/metrics.ts"), "utf8");
    for (const fn of ["answeredRate", "blockRate", "answerableShare", "share"]) {
      assert.match(src, new RegExp(`export function ${fn}[\\s\\S]{0,200}?number \\| null`), fn);
    }
  });
});

/** Unused, but keeps `readdirSync` honest if REPORTED ever goes stale. */
void readdirSync;
