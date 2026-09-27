import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Operator-facing copy must not send anyone to a page that no longer exists.
//
// The console told every operator between shows to "paste an eBay Live link on
// Shows to start one" — long after `/shows` became a redirect to Home. Two more
// of the same sentence sat on the rooms route. Nothing caught it because a
// renamed page is a frontend change and these strings live in the backend, so
// the two drift apart silently and the only symptom is an operator hunting a
// navigation item that was folded away.
//
// The rule is narrow on purpose: it fires on a RETIRED page name used as a
// destination, not on the ordinary words. "shows" the noun is everywhere in
// this codebase and always will be.

const RETIRED: [string, RegExp, string][] = [
  ["Shows", /\b(?:on|to|from|open|visit|see)\s+Shows\b/, "folded into Home"],
  ["Catalog", /\b(?:on|to|from|open|visit|see)\s+(?:the\s+)?Catalog\s+page\b/, "renamed Knowledge"],
  ["Reports", /\b(?:on|to|from|open|visit|see)\s+(?:the\s+)?Reports\s+page\b/, "every report is reached from Home"],
];

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Strip comments — a note to a maintainer may name whatever it likes. */
const codeOnly = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("copy names pages that exist", () => {
  for (const [name, re, why] of RETIRED) {
    test(`nothing sends an operator to "${name}" (${why})`, () => {
      const offenders: string[] = [];
      for (const f of sources("src")) {
        const body = codeOnly(readFileSync(f, "utf8"));
        for (const [i, line] of body.split("\n").entries()) {
          if (re.test(line)) offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      }
      assert.deepEqual(offenders, [], `\n${offenders.join("\n")}\n`);
    });
  }
});
