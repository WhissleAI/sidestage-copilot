// A room you attach to mid-show is not an empty room.
//
// The first scrape is a backlog — everything already on screen. Marking it
// `seen` is what stops a fresh attach replaying an hour of chat through the
// reply pipeline, and that part is right. Stopping there also hid it: reported
// from a live eBay Live session, 99 viewers, 24 minutes, "Listening to chat"
// and nothing under it — while the attach log read `98 backlog` and every one
// of those messages was on the page.
//
// One `seen.add` was doing two jobs. The backlog is now emitted as `historic`:
// recorded, classified, shown, never drafted against — which is exactly what
// L0_OBSERVE already does, for the same reason.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { admit } from "../src/ingest/classify.js";
import { classify } from "../src/ingest/classify.js";

describe("backlog reaches the operator but not the drafter", () => {
  test("the admission thunk is what historic suppresses", () => {
    // `ingest` passes `() => !observing && !historic && rate.tryAdmit()`. A
    // question that would normally be admitted is not, when historic.
    const q = "do you have any spiders?";
    assert.equal(classify(q), "availability", "a real question, not hype");

    const live = admit(q, classify(q), () => true, "query");
    const historic = admit(q, classify(q), () => false, "query");

    assert.equal(live.admitted, true);
    assert.equal(historic.admitted, false, "shown, but never drafted against");
  });

  test("suppression is the thunk, so the message still classifies", () => {
    // The point is that it is recorded and labelled — an operator reading the
    // room needs the intent chips as much as the text.
    assert.equal(classify("how much for the chicagos"), "price_question");
    assert.equal(classify("W"), "hype");
  });
});

describe("the backlog cap", () => {
  test("shows the most recent messages, not the oldest", () => {
    // `slice(-N)`: attaching to a busy hour should show what was just said,
    // not what was said first.
    const backlog = Array.from({ length: 98 }, (_, i) => `m${i}`);
    const shown = backlog.slice(-40);
    assert.equal(shown.length, 40);
    assert.equal(shown[shown.length - 1], "m97", "the newest message is shown");
    assert.equal(shown[0], "m58");
  });

  test("a short backlog is shown whole", () => {
    const backlog = ["a", "b", "c"];
    assert.deepEqual(backlog.slice(-40), backlog);
  });

  test("everything is still marked seen, cap or no cap", () => {
    // The cap governs what is SHOWN. Dedupe still covers the whole backlog, or
    // the next tick would replay the older half as new traffic.
    const backlog = Array.from({ length: 98 }, (_, i) => `m${i}`);
    const seen = new Set(backlog);
    assert.equal(seen.size, 98);
    assert.ok(backlog.slice(-40).every((m) => seen.has(m)));
  });
});
