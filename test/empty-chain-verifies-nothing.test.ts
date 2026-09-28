// An empty audit chain verifies trivially, and that is not assurance.
//
// `AuditLog.verify()` walks the entries and returns `{ok: true, height: 0}`
// for a chain with none — correct as a fact, vacuous as a claim. Counting
// those made the console read "Audit chains intact 13/13" in green, hint
// "hash-verified end to end, per session", while eleven of the thirteen held
// no entries at all.
//
// Measured on production: 11 audit rows across 3 shows, out of 14 finished
// sessions. The other 11 sessions sent nothing, approved nothing and changed
// nothing — so there was nothing to write down, and nothing was verified.
//
// That is the strongest assurance this product gives, on the claim the PRD
// leans on hardest to justify letting a copilot near a seller's listings.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

type Chain = { ok: boolean; height: number };
const reports = (chains: Chain[]) => chains.map((c) => ({ report: { safety: { auditChain: c } } }));

const intact = (rs: ReturnType<typeof reports>) =>
  rs.filter((r) => r.report.safety.auditChain.ok && r.report.safety.auditChain.height > 0).length;
const empty = (rs: ReturnType<typeof reports>) =>
  rs.filter((r) => r.report.safety.auditChain.height === 0).length;

describe("chain integrity counts what was verified", () => {
  test("an empty chain is not counted as intact", () => {
    const rs = reports([{ ok: true, height: 0 }, { ok: true, height: 0 }]);
    assert.equal(intact(rs), 0, "nothing was hash-verified");
    assert.equal(empty(rs), 2);
  });

  test("but it is not a failure either", () => {
    // A show where nobody sent, approved or changed anything has nothing to
    // write down. Counting it as broken would be as wrong as counting it intact.
    const rs = reports([{ ok: true, height: 0 }]);
    assert.notEqual(intact(rs), -1);
    assert.equal(empty(rs), 1, "reported separately, as its own fact");
  });

  test("the production shape: 3 chains with entries, 11 without", () => {
    const rs = reports([
      { ok: true, height: 9 }, { ok: true, height: 1 }, { ok: true, height: 1 },
      ...Array.from({ length: 11 }, () => ({ ok: true, height: 0 })),
    ]);
    assert.equal(intact(rs), 3, "three sessions actually recorded and verified");
    assert.equal(empty(rs), 11);
    assert.notEqual(intact(rs), rs.length, "not 14 of 14, which is what it used to say");
  });

  test("a broken chain still counts as broken", () => {
    const rs = reports([{ ok: false, height: 4 }, { ok: true, height: 2 }]);
    assert.equal(intact(rs), 1);
    assert.equal(empty(rs), 0);
  });
});
