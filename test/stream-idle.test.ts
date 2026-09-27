import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NoShowMonitored } from "../src/shows/registry.js";

// Between shows is not a broken stream.
//
// `/api/stream` threw a plain Error when nothing was being watched, the SSE
// route emitted `stream_error`, and the console rendered its failed branch: a
// red panel, a warning triangle, "That did not load." and a Reload button —
// for the ordinary state of being between shows. Console.tsx already draws
// absent and failed differently and says so in a comment; it was being handed
// the wrong one.

describe("absent is not failed", () => {
  test("the no-show case is its own type, not a sentence to match on", () => {
    const e = new NoShowMonitored();
    assert.ok(e instanceof NoShowMonitored);
    assert.ok(e instanceof Error, "still an Error, so every existing catch keeps working");
    assert.equal(e.name, "NoShowMonitored");
  });

  test("a real failure is NOT the no-show case", () => {
    assert.ok(!(new Error("show abc is not being watched") instanceof NoShowMonitored));
    assert.ok(!(new Error("database is down") instanceof NoShowMonitored));
  });

  test("it no longer sends the operator to a page that was renamed", () => {
    // `/shows` redirects to Home; the copy said "on Shows" long after.
    assert.ok(!/\bShows\b/.test(new NoShowMonitored().message));
    assert.match(new NoShowMonitored().message, /Home/);
  });
});
