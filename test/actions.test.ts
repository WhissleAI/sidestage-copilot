// Agentic-write safety. These tests exist because "we have rollback" is a claim
// that is trivially easy to make and surprisingly hard to keep — so each one
// forces a specific failure and asserts on the state of BOTH systems afterwards.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PINNED, rig } from "./helpers.js";
import { hashEntry, GENESIS } from "../src/actions/audit.js";
import { preflight, idempotencyKey } from "../src/actions/preflight.js";
import { showBudgetContext } from "../src/actions/preflight.js";

const NO_BUDGET_PRESSURE = { committedThisShow: 0, committedLastMinute: 0 };

test("preflight refuses a markdown below the seller's floor price", () => {
  const { repo } = rig();
  const l = repo.listing(PINNED)!; // $412.00, floor $355.00
  const r = preflight("markdown_price", l, { newPriceCents: 34000 }, repo, showBudgetContext(repo, NO_BUDGET_PRESSURE));
  assert.equal(r.ok, false);
  const floor = r.checks.find((c) => c.name === "above floor price")!;
  assert.equal(floor.ok, false);
  assert.match(floor.detail, /below the \$355\.00 floor/);
});

test("preflight refuses a markdown beyond the configured discount cap", () => {
  const { repo } = rig();
  const l = repo.listing(PINNED)!;
  // $360 clears the $355 floor but is 12.6% off — inside the cap.
  const inside = preflight("markdown_price", l, { newPriceCents: 36000 }, repo, showBudgetContext(repo, NO_BUDGET_PRESSURE));
  assert.equal(inside.ok, true);
  // Raise the floor scenario: a 20% cut would be $329.60, below floor AND over cap.
  const outside = preflight("markdown_price", l, { newPriceCents: 32960 }, repo, showBudgetContext(repo, NO_BUDGET_PRESSURE));
  assert.equal(outside.ok, false);
  assert.ok(outside.checks.some((c) => !c.ok && c.name.includes("max discount")));
});

test("preflight refuses negative stock and implausible jumps", () => {
  const { repo } = rig();
  const l = repo.listing(PINNED)!;
  assert.equal(preflight("adjust_stock", l, { newQty: -1 }, repo, showBudgetContext(repo, NO_BUDGET_PRESSURE)).ok, false);
  assert.equal(preflight("adjust_stock", l, { newQty: 400 }, repo, showBudgetContext(repo, NO_BUDGET_PRESSURE)).ok, false);
  assert.equal(preflight("adjust_stock", l, { newQty: 3 }, repo, showBudgetContext(repo, NO_BUDGET_PRESSURE)).ok, true);
});

test("a committed markdown lands on BOTH sides and bumps the listing version", async () => {
  const { repo, exec, market, listingWrites } = rig();
  const before = repo.listing(PINNED)!;

  const a = exec.propose("markdown_price", PINNED, { newPriceCents: 37000 }, "Mark down to $370.00", "4 discount asks in 3 minutes");
  assert.equal(a.status, "proposed");
  assert.equal(a.preflight.ok, true);
  assert.deepEqual(a.before.priceCents, before.priceCents);

  const committed = await exec.approve(a.id);
  assert.equal(committed.status, "committed");
  assert.ok(committed.undoableUntil, "a committed action must carry an undo deadline");

  const after = repo.listing(PINNED)!;
  assert.equal(after.priceCents, 37000);
  assert.equal(after.version, before.version + 1, "every write bumps the version");
  assert.equal(market.snapshot(PINNED)!.priceCents, 37000, "the marketplace must agree");
  assert.deepEqual(listingWrites, [PINNED], "the retriever must be told to reindex");
});

test("rollback restores both sides from the preflight snapshot", async () => {
  const { repo, exec, market } = rig();
  const before = repo.listing(PINNED)!;

  const a = exec.propose("markdown_price", PINNED, { newPriceCents: 37000 }, "Mark down to $370.00", "test");
  await exec.approve(a.id);
  const rolled = await exec.rollback(a.id);

  assert.equal(rolled.status, "rolled_back");
  assert.equal(rolled.undoableUntil, null);
  assert.equal(repo.listing(PINNED)!.priceCents, before.priceCents, "local price restored");
  assert.equal(market.snapshot(PINNED)!.priceCents, before.priceCents, "remote price restored");
  // A rollback moves history forward; it does not rewind the version.
  assert.ok(repo.listing(PINNED)!.version > before.version + 1);
});

test("a marketplace apply failure leaves NOTHING changed", async () => {
  const { repo, exec, market } = rig();
  const before = repo.listing(PINNED)!;
  market.failNext();

  const a = exec.propose("markdown_price", PINNED, { newPriceCents: 37000 }, "Mark down to $370.00", "test");
  const failed = await exec.approve(a.id);

  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /marketplace apply failed/);
  assert.equal(repo.listing(PINNED)!.priceCents, before.priceCents, "local untouched");
  assert.equal(repo.listing(PINNED)!.version, before.version, "no phantom version bump");
  assert.equal(market.snapshot(PINNED)!.priceCents, before.priceCents, "remote untouched");
});

test("a remote edit under us is caught at reserve, before anything is written", async () => {
  const { repo, exec, market } = rig();
  const a = exec.propose("markdown_price", PINNED, { newPriceCents: 37000 }, "Mark down to $370.00", "test");

  // Someone edits the listing on their phone between proposal and approval.
  market.driftRemote(PINNED, { priceCents: 39900 });

  const failed = await exec.approve(a.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /changed remotely/);
  assert.match(failed.error!, /re-propose against the current version/);
  assert.equal(repo.listing(PINNED)!.priceCents, 41200, "our mirror is untouched");
});

test("approving twice does not apply the markdown twice", async () => {
  const { repo, exec } = rig();
  const a = exec.propose("markdown_price", PINNED, { newPriceCents: 37000 }, "Mark down to $370.00", "test");

  const first = await exec.approve(a.id);
  const versionAfterFirst = repo.listing(PINNED)!.version;
  const second = await exec.approve(a.id);

  assert.equal(first.status, "committed");
  assert.equal(second.status, "committed");
  assert.equal(repo.listing(PINNED)!.priceCents, 37000);
  assert.equal(repo.listing(PINNED)!.version, versionAfterFirst, "the second approval was a no-op");
});

test("the same intent at the same version produces the same idempotency key", () => {
  const k1 = idempotencyKey("markdown_price", PINNED, 3, { newPriceCents: 37000 });
  const k2 = idempotencyKey("markdown_price", PINNED, 3, { newPriceCents: 37000 });
  const k3 = idempotencyKey("markdown_price", PINNED, 4, { newPriceCents: 37000 });
  assert.equal(k1, k2);
  assert.notEqual(k1, k3, "a different listing version is a different intent");
});

test("swap_pinned moves the pin on both sides and unpins the previous lot", async () => {
  const { repo, exec, market } = rig();
  const target = "lst_dunk_panda_11";
  const a = exec.propose("swap_pinned", target, {}, "Pin the Panda Dunks", "chat is asking about them");
  const committed = await exec.approve(a.id);

  assert.equal(committed.status, "committed");
  assert.equal(repo.listing(target)!.pinned, true);
  assert.equal(repo.listing(PINNED)!.pinned, false);
  assert.equal(market.snapshot(target)!.pinned, true);
  assert.equal(market.snapshot(PINNED)!.pinned, false);
});

test("the audit chain records the whole lifecycle and verifies", async () => {
  const { exec, audit } = rig();
  const a = exec.propose("markdown_price", PINNED, { newPriceCents: 37000 }, "Mark down to $370.00", "test");
  await exec.approve(a.id);
  await exec.rollback(a.id);

  const kinds = audit.list().map((e) => e.kind);
  assert.deepEqual(kinds, ["action_proposed", "action_committed", "action_rolled_back"]);

  const v = audit.verify();
  assert.equal(v.ok, true);
  assert.equal(v.height, 3);

  const entries = audit.list();
  assert.equal(entries[0].prevHash, GENESIS, "the chain starts at genesis");
  assert.equal(entries[1].prevHash, entries[0].hash);
  assert.equal(entries[2].prevHash, entries[1].hash);
});

test("tampering with a historical audit row is detected", async () => {
  const { d, exec, audit } = rig();
  const a = exec.propose("markdown_price", PINNED, { newPriceCents: 37000 }, "Mark down to $370.00", "test");
  await exec.approve(a.id);
  assert.equal(audit.verify().ok, true);

  // Rewrite history: make the committed markdown look like it was to $390.
  d.prepare("UPDATE audit SET summary = ? WHERE seq = 2").run("Mark down to $390.00");

  const v = audit.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
  assert.match(v.reason!, /does not match its hash/);
});

test("the audit hash depends on every field, with no separator collisions", () => {
  const base = { seq: 1, at: "2026-09-13T00:00:00.000Z", kind: "action_committed", actorType: "seller", summary: "a", detail: { x: 1 } };
  const h = hashEntry(GENESIS, base);
  assert.notEqual(h, hashEntry(GENESIS, { ...base, summary: "b" }));
  assert.notEqual(h, hashEntry(GENESIS, { ...base, detail: { x: 2 } }));
  assert.notEqual(h, hashEntry(GENESIS, { ...base, seq: 2 }));
  assert.notEqual(h, hashEntry("1".repeat(64), base));
  // "ab" + "c" must not hash the same as "a" + "bc".
  assert.notEqual(
    hashEntry(GENESIS, { ...base, kind: "ab", actorType: "c" }),
    hashEntry(GENESIS, { ...base, kind: "a", actorType: "bc" }),
  );
});

test("a failed action is recorded in the audit, not swallowed", async () => {
  const { exec, audit, market } = rig();
  market.failNext();
  const a = exec.propose("markdown_price", PINNED, { newPriceCents: 37000 }, "Mark down to $370.00", "test");
  await exec.approve(a.id);

  const kinds = audit.list().map((e) => e.kind);
  assert.ok(kinds.includes("action_failed"));
  assert.equal(audit.verify().ok, true);
});

test("an action whose preflight failed can never be committed", async () => {
  const { repo, exec } = rig();
  const before = repo.listing(PINNED)!;
  const a = exec.propose("markdown_price", PINNED, { newPriceCents: 1000 }, "Mark down to $10.00", "absurd");
  assert.equal(a.status, "preflight_failed");

  const result = await exec.approve(a.id);
  assert.equal(result.status, "failed");
  assert.equal(repo.listing(PINNED)!.priceCents, before.priceCents);
});
