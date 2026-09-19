import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runChain } from "../src/guardrails/chain.js";
import { communityRuleGuard, forbiddenBy, priceGuard, sponsorGuard, availabilityGuard } from "../src/guardrails/guards.js";
import type { GuardInput } from "../src/guardrails/types.js";
import type { Fact } from "../src/retrieval/facts.js";
import type { CorpusKind } from "../src/retrieval/corpus.js";
import { ngramVector, terms } from "../src/retrieval/text.js";
import { capabilitiesOf } from "../src/surfaces/types.js";

// Guards that know which surface they are on.
//
// Everything above these tests checks a draft against things WE know. These two
// check it against the room's rules and the sponsor's, which are things a human
// somewhere else wrote down — and the first three check that a guard reasoning
// about a catalog does not fire on a surface that has none.

const fact = (factId: string, corpus: CorpusKind, label: string, text: string): Fact => ({
  factId, corpus, source: "catalog", label, text, field: "description",
  tokens: terms(`${label} ${text}`), vector: ngramVector(`${label} ${text}`),
});

function input(o: {
  surface: string;
  answer: string;
  question?: string;
  facts?: Fact[];
  claims?: { text: string; factId: string }[];
}): GuardInput {
  const facts = o.facts ?? [];
  return {
    draft: {
      answer: o.answer,
      claims: (o.claims ?? []).map((c) => ({ ...c, supported: false })),
      parsedOk: true,
      raw: o.answer,
    },
    question: o.question ?? "what is it",
    facts,
    factById: new Map(facts.map((f) => [f.factId, f])),
    currentListings: new Map(),
    slots: { listingIds: [], viaAnaphora: false } as unknown as GuardInput["slots"],
    policies: [],
    surface: capabilitiesOf(o.surface),
    community: facts.filter((f) => f.corpus === "community"),
  };
}

describe("a listing guard on a surface with no listings", () => {
  test("a price on Twitch is not a stale listing price", () => {
    // The board costs sixty dollars because the sponsor says so. There is no
    // catalog behind this surface, so there is no version for the number to be
    // stale against — and a guard that blocked it would block every sponsored
    // reply that ever names a price.
    const i = input({ surface: "twitch", answer: "The Q1 is $169 on their site right now." });
    assert.equal(priceGuard.run(i).verdict, "n/a");
    assert.equal(availabilityGuard.run(i).verdict, "n/a");
  });

  test("the same reply on eBay Live is still checked", () => {
    // The gate is the corpus, not the guard being switched off: a live-commerce
    // surface declares `listing`, so the signature check runs exactly as before.
    const i = input({ surface: "ebaylive", answer: "It's $169." });
    assert.notEqual(priceGuard.run(i).verdict, "n/a");
  });

  test("the chain reports both as n/a rather than dropping them", () => {
    const chain = runChain(input({ surface: "reddit", answer: "It shipped in 2021 and costs $169." }));
    const names = chain.guards.map((g) => g.guard);
    assert.ok(names.includes("price"), "the guard still ran and still reported");
    assert.equal(chain.guards.find((g) => g.guard === "price")!.verdict, "n/a");
  });
});

describe("the rules of the room", () => {
  const RULE = fact(
    "community:mechmarket#3",
    "community",
    "r/mechmarket rule 3",
    "No vendor self-promotion outside the weekly thread.",
  );

  test("a violated rule blocks, and the reason names the rule and cites it", () => {
    const r = communityRuleGuard.run(input({
      surface: "reddit",
      answer: "Happy to help — we do vendor self promotion on our store page, link in bio.",
      facts: [RULE],
    }));
    assert.equal(r.verdict, "block");
    assert.match(r.reason!, /r\/mechmarket rule 3/);
    assert.match(r.reason!, /no vendor self-promotion/i);
    // "says who" has to be answerable from the card without a second lookup.
    assert.match(r.reason!, /community:mechmarket#3/);
    assert.equal(r.detail?.expected, "community:mechmarket#3");
  });

  test("a reply that keeps to the rule is allowed", () => {
    const r = communityRuleGuard.run(input({
      surface: "reddit",
      answer: "The switches are lubed Gazzew U4Ts — the build log has the full list.",
      facts: [RULE],
    }));
    assert.equal(r.verdict, "allow");
  });

  test("a quoted phrase in a rule is matched verbatim", () => {
    const rule = fact("community:buildapcsales#7", "community", "r/buildapcsales rule 7", 'Do not post "DM me" in comments.');
    const r = communityRuleGuard.run(input({
      surface: "reddit", answer: "Still have two left — DM me and I'll sort you out.", facts: [rule],
    }));
    assert.equal(r.verdict, "block");
    assert.equal(r.detail?.found, "dm me");
  });

  test("eBay Live is untouched: no room rules, so the guard is n/a", () => {
    // The reference surface has no per-room rule corpus to retrieve. Even with
    // a community fact somehow in scope, the guard must not fire there.
    const r = communityRuleGuard.run(input({
      surface: "ebaylive", answer: "we do vendor self promotion all day", facts: [RULE],
    }));
    assert.equal(r.verdict, "n/a");
  });

  test("a surface with rules but none retrieved is n/a, not allow", () => {
    // "We checked and found nothing wrong" and "we had nothing to check
    // against" are different answers, and the console renders them differently.
    assert.equal(communityRuleGuard.run(input({ surface: "reddit", answer: "hello" })).verdict, "n/a");
  });

  test("a rule's teeth are its subject, not its circumstances", () => {
    const { phrases } = forbiddenBy("No vendor self-promotion outside the weekly thread.");
    assert.deepEqual(phrases, [["vendor", "self", "promotion"]]);
  });
});

describe("sponsored claims", () => {
  const SPONSOR = fact(
    "sponsor:keychron#q1",
    "sponsor",
    "Sponsor · Keychron Q1",
    "The Q1 ships with a gasket mount and a 1.2mm PCB. Approved claim: 'fully QMK/VIA programmable'.",
  );

  test("a claim about the sponsored product with no sponsor citation blocks", () => {
    const r = sponsorGuard.run(input({
      surface: "twitch",
      answer: "The Keychron is basically the best board under $200, easily.",
      facts: [SPONSOR],
    }));
    assert.equal(r.verdict, "block");
    assert.match(r.reason!, /Keychron Q1/);
    assert.equal(r.detail?.found, "no citation");
  });

  test("citing another corpus is not citing the sponsor", () => {
    // The grounding guard would accept this. A sponsor contract is written to
    // prevent exactly the improvisation that a product doc happily supports.
    const product = fact("product:keyboards#mounts", "product", "Docs · mounts", "Gasket mounts are softer than top mounts.");
    const r = sponsorGuard.run(input({
      surface: "twitch",
      answer: "The Keychron has a gasket mount, so it's softer.",
      facts: [SPONSOR, product],
      claims: [{ text: "gasket mounts are softer", factId: "product:keyboards#mounts" }],
    }));
    assert.equal(r.verdict, "block");
  });

  test("a claim that cites the sponsor fact is allowed", () => {
    const r = sponsorGuard.run(input({
      surface: "twitch",
      answer: "The Keychron Q1 is fully QMK and VIA programmable.",
      facts: [SPONSOR],
      claims: [{ text: "fully QMK/VIA programmable", factId: "sponsor:keychron#q1" }],
    }));
    assert.equal(r.verdict, "allow");
  });

  test("a reply that never mentions the sponsor is allowed, not blocked", () => {
    const r = sponsorGuard.run(input({
      surface: "twitch", answer: "Stream's back up in ten, grabbing coffee.", facts: [SPONSOR],
    }));
    assert.equal(r.verdict, "allow");
  });

  test("no sponsor corpus in scope is n/a — which is every live-commerce reply", () => {
    assert.equal(sponsorGuard.run(input({ surface: "ebaylive", answer: "It's $412." })).verdict, "n/a");
  });
});
