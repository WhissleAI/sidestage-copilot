import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { couldBeUsername } from "../src/shows/prepareEvent.js";

// Which of a show's three names can key the seller's listings page.
//
// An eBay Live card carries three names for one seller: the account USERNAME
// (which keys `_ssn=` and the Browse filter), the card's DISPLAY name, and the
// Live-page SLUG. Only the first is guaranteed to work, and when the Live page
// exposes no `/usr/` link we do not have it.
//
// The page read used to try exactly one candidate, and with resolution failed
// that candidate was the display name. "MR WIKD" and "SWISS ICE" both prepared
// with empty catalogs for this reason while their slugs went untried.

describe("candidates for the seller listings page", () => {
  test("a display name with a space is not a username", () => {
    assert.equal(couldBeUsername("MR WIKD"), false);
    assert.equal(couldBeUsername("SWISS ICE"), false);
    assert.equal(couldBeUsername("Pure Watches"), false);
    assert.equal(couldBeUsername(" leading"), true, "trimmed first");
  });

  test("usernames and Live-page slugs are both worth trying", () => {
    assert.equal(couldBeUsername("w9sdtwkvsau"), true);
    assert.equal(couldBeUsername("gold_standard_guy"), true);
    assert.equal(couldBeUsername("q_EImPfySam"), true);
    assert.equal(couldBeUsername("pokesino777"), true);
    assert.equal(couldBeUsername("mvpv_0"), true);
  });

  test("nothing degenerate gets a browser load spent on it", () => {
    assert.equal(couldBeUsername(""), false);
    assert.equal(couldBeUsername("   "), false);
    assert.equal(couldBeUsername("a"), false);
    assert.equal(couldBeUsername("x".repeat(65)), false);
  });
});
