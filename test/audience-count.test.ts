import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { audienceCount } from "../src/surfaces/scrapeDom.js";

// Reading a viewer badge off a scraped card.
//
// Observed on Whatnot discovery: a room with 215 viewers rendered as
// "21520000 watching", because the badge's text ran into the show's title
// ("20K Celebration show $1 Rolex…") and the unanchored match happily took
// "21520" with a "K" after it.

describe("audienceCount", () => {
  test("reads the badge the platforms actually render", () => {
    assert.equal(audienceCount("144"), 144);
    assert.equal(audienceCount("1,204 viewers"), 1204);
    assert.equal(audienceCount("1.2K watching"), 1200);
    assert.equal(audienceCount("2.2k"), 2200);
    assert.equal(audienceCount("3.5M"), 3_500_000);
    assert.equal(audienceCount(""), null);
    assert.equal(audienceCount("LIVE"), null);
  });

  test("a badge that ran into the title is unknown, not a number", () => {
    // 215 viewers + "20K Celebration show …" concatenated.
    assert.equal(audienceCount("21520K Celebration show $1 Rolex"), null);
    assert.equal(audienceCount("4567M"), null, "nobody writes a four-digit M");
  });

  test("it does not pick a number out of the middle of a string", () => {
    assert.equal(audienceCount("watching 144"), null, "the badge starts with its own number");
  });
});
