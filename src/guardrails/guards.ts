// The guards. Every one is DETERMINISTIC: no model is asked whether a reply
// is safe. A guard either points at a fact that contradicts the draft, or it
// allows. That is the difference between a guardrail and a second opinion.
//
// Each returns `allow`, `revise` (the composer gets one bounded repair pass with
// the reason attached) or `block` (the reply never reaches the buyer without the
// seller editing it).

import type { GuardName, GuardResult } from "../domain/types.js";
import { extractMoneyCents, formatMoney } from "../domain/money.js";
import { cosine, fold, ngramVector, terms } from "../retrieval/text.js";
import { allow, fail, na, sentences, type Guard, type GuardInput } from "./types.js";
import { neverSayMatchers, policy } from "./policy.js";
import { hasCorpus } from "../surfaces/types.js";

/** A clause that declines or quotes the buyer back rather than committing. */
const DECLINING = /\b(can'?t|cannot|can not|unable|not able|won'?t|will not|no lower|lowest i can|too low|below (?:my|the)|under (?:my|the)|instead)\b/i;

const ASSERTS_AVAILABLE = /\b(still (?:available|here|up|in stock|have)|in stock|available|it'?s yours|grab it|claim it|yes[,!. ]|we (?:do )?have|i (?:do )?have|got (?:it|one|some)|last one|last pair)\b/i;
const ASSERTS_SOLD_OUT = /\b(sold out|sold|gone|no longer available|none left|all out)\b/i;

/**
 * Fact sources a human WROTE DOWN, versioned or reviewed before the show.
 *
 * A money amount in one of these is a number somebody committed to in advance:
 * a listing field, a catalog import, a policy clause, an answer the seller gave
 * before and approved for re-use. `host` (live speech) and `market` (comparable
 * ASKING prices for other people's listings) are deliberately absent — neither
 * is a price we are in a position to honour. `persona` is style, never
 * grounding, and is absent for that reason.
 */
const WRITTEN_SOURCES: ReadonlySet<string> = new Set(["listing", "catalog", "policy", "qa"]);

/** The reply reports what the host said rather than asserting it as our price.
 *  "The host just mentioned these go for $200" commits us to nothing;
 *  "That one is $200" commits us to $200. */
const ATTRIBUTED_TO_HOST =
  /\b(?:host|he|she|they)\b[^.!?]{0,80}?\b(?:said|says|saying|mentioned|mentions|noted|called|quoted|was talking|just went over)\b|\b(?:said|says|mentioned|noted|according to)\b[^.!?]{0,40}?\bhost\b/i;

// ── 1. price ──────────────────────────────────────────────────────────────────
//
// The signature check. Every money amount in the reply must be traceable to a
// grounding fact AND that fact must have been read at the listing's CURRENT
// version. A markdown landing between retrieval and send makes the draft stale,
// and this is what proves it rather than hoping nobody notices.
export const priceGuard: Guard = {
  name: "price",
  run(i: GuardInput): GuardResult {
    // No catalog behind this surface, so there is no listing price for a
    // number to be stale against. Every check below compares the draft to a
    // listing version; without listings they would compare it to nothing and
    // block every reply that mentions money — a Twitch answer saying the board
    // costs sixty dollars is quoting the sponsor, not quoting us.
    if (!hasCorpus(i.surface, "listing")) return na("price");
    const amounts = extractMoneyCents(i.draft.answer);
    if (!amounts.length) return na("price");

    const echoed = new Set(extractMoneyCents(i.question));
    const priceFacts = i.facts.filter((f) => f.numericCents !== undefined);

    // Every money amount that a WRITTEN-DOWN fact states, not just the ones a
    // fact carries as a typed price. Shipping costs, flat fees and thresholds
    // live in the prose of a listing or policy fact ("ships USPS Ground
    // Advantage at a flat $9.95"), and without this the guard read a shipping
    // charge as an item-price commitment and blocked it for being below the
    // floor. Found against a real eBay Live show, not in the eval set.
    //
    // Written down is the load-bearing word. The exemption originally read
    // EVERY fact, and a host utterance is a fact — so "these usually go for
    // $200 all day" over the mic licensed the copilot to tell a buyer an $80
    // lot was $200, with a green price pill on it. A number the host said out
    // loud is unversioned, unattributed and frequently about resale value
    // rather than about this lot; it is exactly the stale price this guard
    // exists to catch, arriving through the door marked "already checked".
    // Speech is handled below, on its own terms.
    const statedInFacts = new Set<number>();
    const statedByHost = new Set<number>();
    for (const f of i.facts) {
      const into = WRITTEN_SOURCES.has(f.source) ? statedInFacts : f.source === "host" ? statedByHost : null;
      if (!into) continue;
      for (const c of extractMoneyCents(f.text)) into.add(c);
    }
    const listing = firstResolvedListing(i);
    const cap = policy().maxDiscountPct;

    for (const amount of amounts) {
      const source = priceFacts.find((f) => f.numericCents === amount);

      // (a) The amount restates a grounding fact. Is that fact still true?
      if (source) {
        if (source.listingId && source.listingVersion !== undefined) {
          const live = i.currentListings.get(source.listingId);
          if (live && live.version !== source.listingVersion) {
            return fail(
              "price", "block",
              `Reply quotes a price from listing version ${source.listingVersion}; the live listing is version ${live.version}.`,
              { expected: `${formatMoney(live.priceCents)} (v${live.version})`, found: `${formatMoney(amount)} (v${source.listingVersion})` },
            );
          }
        }
        continue;
      }

      const clause = sentences(i.draft.answer).find((x) => extractMoneyCents(x).includes(amount)) || i.draft.answer;
      const declining = DECLINING.test(clause);

      // (b) Quoting the buyer's own number back while declining it. Naming an
      //     offer in order to refuse it commits to nothing.
      if (echoed.has(amount) && declining) continue;

      // (c) The amount is stated verbatim by a WRITTEN grounding fact that is
      //     not a price fact — a shipping charge, a free-shipping threshold, a
      //     bundle percentage. Repeating a written fact is not making an offer.
      if (statedInFacts.has(amount)) continue;

      // (c2) The only source for this number is something the host said. Two
      //      ways that is legitimate, and no third:
      //        • it agrees with the lot as it stands right now, so it is not
      //          stale whatever its provenance; or
      //        • the reply ATTRIBUTES it — "the host just said these go for
      //          $200" reports the room, where "that one is $200" quotes a
      //          price we do not have.
      //      Anything else is the host's resale banter being sold to a buyer as
      //      this lot's price.
      if (statedByHost.has(amount)) {
        if (listing && amount === listing.priceCents) continue;
        if (ATTRIBUTED_TO_HOST.test(clause)) continue;
        return fail(
          "price", "block",
          `Reply states ${formatMoney(amount)} as a price; the only source for it is something the host said, not the listing.`,
          {
            expected: listing ? `${formatMoney(listing.priceCents)} (v${listing.version})` : "a cited price fact",
            found: formatMoney(amount),
          },
        );
      }

      // (d) Otherwise this number is a COMMITMENT: either accepting the buyer's
      //     offer, or proposing a discount of our own. A proposed discount is
      //     legitimate — the discount policy authorises it — so it is not
      //     required to match an existing fact. It is required to respect the
      //     floor and the cap, which is checked next. Anything that is neither
      //     echoed nor a discount on the resolved listing is invented.
      const isCommitment = echoed.has(amount) || (listing !== null && amount < listing.priceCents);
      if (!isCommitment) {
        return fail(
          "price", "block",
          `Reply states ${formatMoney(amount)}, which no grounding fact supports.`,
          {
            expected: priceFacts.length ? priceFacts.map((f) => formatMoney(f.numericCents!)).join(" or ") : "a cited price fact",
            found: formatMoney(amount),
          },
        );
      }

      if (listing) {
        if (amount < listing.floorPriceCents) {
          return fail(
            "price", "block",
            `Reply commits to ${formatMoney(amount)}, below the seller's floor for this listing.`,
            { expected: `at or above ${formatMoney(listing.floorPriceCents)}`, found: formatMoney(amount) },
          );
        }
        const off = ((listing.priceCents - amount) / listing.priceCents) * 100;
        if (off > cap + 0.0001) {
          return fail(
            "price", "block",
            `Reply commits to ${off.toFixed(1)}% off; show discounts cap at ${cap}%.`,
            { expected: `at most ${cap}% off`, found: `${off.toFixed(1)}% off` },
          );
        }
      }
    }

    return allow("price");
  },
};

// ── 2. availability ───────────────────────────────────────────────────────────
//
// Checks run against EVERY listing the reply was grounded in, not just the first
// one slot resolution picked. Inventory search ("any griffey") routinely returns
// several lots, and a reply that says "the 1989 has 2 available and the 1994 is
// the last one" is correct — but a guard holding a single listing read "last one"
// against the 1989's quantity of 2 and blocked it.
export const availabilityGuard: Guard = {
  name: "availability",
  run(i: GuardInput): GuardResult {
    // Same reason as the price guard: "still available" is a claim about a lot,
    // and a surface with no listing corpus has no lots for it to be wrong about.
    if (!hasCorpus(i.surface, "listing")) return na("availability");
    const listings = groundedListings(i);
    if (!listings.length) return na("availability");
    const a = i.draft.answer;

    const claimsAvailable = ASSERTS_AVAILABLE.test(a);
    const claimsSoldOut = ASSERTS_SOLD_OUT.test(a);

    // Only a problem when EVERY grounded lot is out of stock. With several in
    // play, "yes we have some" is true if any of them does.
    if (claimsAvailable && !claimsSoldOut && listings.every((l) => l.qty === 0)) {
      const l = listings[0];
      return fail("availability", "block", `Reply says the item is available but ${l.title} has 0 left.`,
        { expected: "sold out (qty 0)", found: "available" });
    }
    if (claimsSoldOut && !claimsAvailable && listings.every((l) => l.qty > 0)) {
      const l = listings[0];
      return fail("availability", "revise", `Reply says sold out but ${l.qty} remain.`,
        { expected: `${l.qty} available`, found: "sold out" });
    }

    // "last one" is a scarcity claim the prohibited-claims policy only permits
    // when it is literally true of SOMETHING the reply is about.
    if (/\b(last (?:one|pair|piece)|only one left|final one)\b/i.test(a) && !listings.some((l) => l.qty === 1)) {
      const l = listings[0];
      return fail("availability", "block", `Reply calls it the last one but quantity is ${l.qty}.`,
        { expected: "qty 1", found: `qty ${l.qty}` });
    }

    // A stated count must match the live count of one of the grounded lots.
    const counts = [...a.matchAll(/\b(\d{1,3})\s*(?:left|available|in stock|remaining|pairs?|units?)\b/gi)]
      .map((m) => Number(m[1]));
    for (const c of counts) {
      if (!listings.some((l) => l.qty === c)) {
        return fail("availability", "block",
          `Reply states ${c} available; no lot it cites has that quantity.`,
          { expected: listings.map((l) => String(l.qty)).join(" or "), found: `${c}` });
      }
    }

    return allow("availability");
  },
};

// ── 3. policy ─────────────────────────────────────────────────────────────────
//
// The never-say list comes from src/guardrails/policy.ts — the SAME object that
// is pushed to the Whissle agent as `content_guardrails`. Checking it here too
// is not redundancy for its own sake: the agent-side guard is a pure string
// match with no catalog access, so rules flagged `unlessCertified` can only be
// decided here, where the listing's certificate is in hand.

const TOPIC_ASSERTIONS: [string, RegExp][] = [
  ["shipping", /\b(ship|shipping|delivery|deliver|free shipping|2[- ]day|ground advantage|customs|duties|dhl)\b/i],
  ["returns", /\b(return|returns|refund|exchange|money back|30[- ]day)\b/i],
  ["authenticity", /\b(authenticat\w*|certificate|cert\b|checkcheck|verified)\b/i],
];

export const policyGuard: Guard = {
  name: "policy",
  run(i: GuardInput): GuardResult {
    const a = i.draft.answer;

    for (const { re, rule } of neverSayMatchers()) {
      const m = a.match(re);
      if (!m) continue;
      if (rule.unlessCertified) {
        const listing = firstResolvedListing(i);
        if (listing?.authenticated && listing.certId) continue;
      }
      return fail("policy", "block", `Prohibited claim — ${rule.why}.`, { found: m[0] });
    }

    // Below this line the guard asks "is the governing CLAUSE in evidence?",
    // which presumes a policy corpus exists to retrieve a clause from. Twitch,
    // YouTube Live and every other surface whose corpora are
    // schedule/sponsor/product/qa/community have none — so the answer was
    // always "no clause", and every reply on those surfaces that touched
    // shipping, returns, refunds or authenticity was held forever, including
    // perfectly grounded ones citing a schedule fact. The never-say list above
    // is OUR rule and still applies everywhere; the clause check is about the
    // operator's own policy corpus and cannot apply where there is not one.
    // Same gate, same reason, as the price and availability guards.
    if (!hasCorpus(i.surface, "policy")) return allow("policy");

    // A claim about a policy topic needs the governing clause in evidence.
    for (const [topic, re] of TOPIC_ASSERTIONS) {
      if (!re.test(a)) continue;
      const hasClause = i.facts.some((f) => f.source === "policy" && f.policyTopic === topic);
      const hasListingFact = i.facts.some((f) => f.field === topic);
      if (!hasClause && !hasListingFact) {
        return fail("policy", "revise", `Reply makes a ${topic} claim with no ${topic} policy in evidence.`,
          { expected: `a ${topic} policy fact`, found: "none retrieved" });
      }
    }

    return allow("policy");
  },
};

// ── 4. claim grounding ────────────────────────────────────────────────────────
//
// Two distinct failures, weighted differently. A FABRICATED citation — an id
// that was never in evidence — is a block: the model invented a source. A
// weakly-supported claim is a revise.
// Does this reply assert anything checkable? Prefix-matched on purpose: the
// word-boundary version missed "Returns" and every multi-digit number, which is
// most of what actually needs grounding.
// A reply that commits to nothing: a greeting, or an explicit deferral to the
// host. These are the ONLY things allowed to carry no citation.
const NON_COMMITTAL =
  /\b(host will (?:cover|get to|answer)|i'?ll (?:check|find out|ask)|let me (?:check|get)|coming (?:up|right up)|one (?:sec|moment)|right here|what can i (?:get|do)|thanks|thank you|welcome|hey|hi there)\b/i;

/** Keywords that make a reply obviously checkable. Retained as a fast path, but
 *  no longer the ONLY trigger — see the guard below. */
const FACTUAL = /\d|\$|\b(ship\w*|return\w*|refund\w*|authentic\w*|cert\w*|size|available|stock|left|condition|deadstock|vnds|box|free|polic\w*|median|comps?)\b/i;

/** Long enough to be an assertion rather than an acknowledgement. */
const SUBSTANTIVE_CHARS = 60;

export const claimGroundingGuard: Guard = {
  name: "claim_grounding",
  run(i: GuardInput): GuardResult {
    const a = i.draft.answer;

    // A reply must either CITE something or commit to nothing. The old test —
    // "does it contain a number or a catalog keyword" — let a whole class
    // through: an answer written entirely from the host's live transcript.
    //
    //   "Next up I'm diving into the rarity and significance of a historic coin,
    //    as I just discussed its volume and surviving examples."
    //
    // No digits, no catalog keywords, so it was never checked — and it went out
    // at confidence 0.10 with a green grounding pill, which is the worst
    // combination available: unverified and presented as verified. The show
    // context is a real source, but nothing traceable backs that sentence.
    const substantive =
      FACTUAL.test(a) || (a.trim().length >= SUBSTANTIVE_CHARS && !NON_COMMITTAL.test(a));
    const needsGrounding = substantive;

    for (const c of i.draft.claims) {
      if (!i.factById.has(c.factId)) {
        return fail("claim_grounding", "block", `Claim cites ${c.factId}, which was never provided as evidence.`,
          { expected: "a factId from the evidence set", found: c.factId });
      }
    }

    if (!i.draft.claims.length) {
      if (!needsGrounding) return allow("claim_grounding");
      return fail("claim_grounding", "revise",
        i.draft.parsedOk
          ? "Reply asserts something but cites no grounding fact. Only a greeting or an explicit deferral may go uncited."
          : "Model did not return the claim-structured JSON, so no citation can be checked.");
    }

    // Lexical support: the claim's content words should appear in the fact it
    // cites. Deliberately a cheap overlap test, not an entailment model — a
    // guard that needs an LLM to decide is not a guard.
    const weak: string[] = [];
    for (const c of i.draft.claims) {
      const fact = i.factById.get(c.factId)!;
      const claimTerms = new Set(terms(c.text));
      if (!claimTerms.size) continue;
      const factTerms = new Set(terms(fact.text));
      let hit = 0;
      for (const t of claimTerms) if (factTerms.has(t)) hit++;
      const ratio = hit / claimTerms.size;
      // Token overlap is brittle across paraphrase and morphology, so a trigram
      // cosine backs it up. Either signal counts as support: this is a "is there
      // any connection at all" test, not an entailment judgement, and the
      // expensive direction of error here is the false alarm.
      const similarity = cosine(ngramVector(c.text), ngramVector(fact.text));
      c.supported = ratio >= 0.25 || similarity >= 0.18;
      if (!c.supported) weak.push(`"${c.text}" vs ${c.factId}`);
    }

    if (weak.length) {
      return fail("claim_grounding", "revise", `${weak.length} claim(s) are not supported by the fact they cite.`,
        { found: weak[0] });
    }

    return allow("claim_grounding");
  },
};

// ── 5. tone ───────────────────────────────────────────────────────────────────
const PROFANITY = /\b(fuck\w*|shit|bitch|asshole|bastard)\b/i;

export const toneGuard: Guard = {
  name: "tone",
  run(i: GuardInput): GuardResult {
    const p = policy();
    const a = i.draft.answer;
    if (!a.trim()) return fail("tone", "block", "Reply is empty.");
    if (PROFANITY.test(a)) return fail("tone", "block", "Reply contains profanity.", { found: a.match(PROFANITY)![0] });
    if (a.length > p.maxReplyChars) return fail("tone", "revise", `Reply is ${a.length} characters; live chat replies stay under ${p.maxReplyChars}.`,
      { expected: `< ${p.maxReplyChars} chars`, found: `${a.length} chars` });
    if (!p.allowMarkdown && /^[-*•]\s|\n[-*•]\s|\*\*|^#{1,6}\s/m.test(a)) return fail("tone", "revise", "Reply uses markdown; chat is plain text.");
    if (!p.allowEmoji && /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(a)) return fail("tone", "revise", "Reply contains emoji; the seller's voice guide is plain text.");
    const hype = p.hypePhrases.find((h) => a.toLowerCase().includes(h));
    if (hype) return fail("tone", "revise", "Reply hypes beyond what the condition notes support.", { found: hype });
    const letters = a.replace(/[^A-Za-z]/g, "");
    if (letters.length > 12 && letters === letters.toUpperCase()) return fail("tone", "revise", "Reply is all caps.");
    return allow("tone");
  },
};

// ── 6. pii ────────────────────────────────────────────────────────────────────
export const piiGuard: Guard = {
  name: "pii",
  run(i: GuardInput): GuardResult {
    const a = i.draft.answer;
    const checks: [RegExp, string][] = [
      [/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/, "an email address"],
      [/\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/, "a phone number"],
      [/\b(?:\d[ -]?){13,16}\b/, "a card-like number"],
      [/\b\d{1,5}\s+[A-Z][a-z]+\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Lane|Ln|Dr|Drive)\b/, "a street address"],
    ];
    for (const [re, what] of checks) {
      const m = a.match(re);
      if (m) return fail("pii", "block", `Reply contains ${what}; personal data never goes into public chat.`, { found: m[0] });
    }
    return allow("pii");
  },
};

/** The listing the question resolved to, read at CURRENT state. Guards that
 *  reason about ONE item (a price commitment, a floor) use this. */
function firstResolvedListing(i: GuardInput) {
  for (const id of i.slots.listingIds) {
    const l = i.currentListings.get(id);
    if (l) return l;
  }
  // An inventory search resolves no slot but still grounds in real listings.
  return groundedListings(i)[0] ?? null;
}

/**
 * The listings the reply is ABOUT.
 *
 * Slot-resolved listings when the buyer named an item ("how many pandas left") —
 * a scarcity claim there must be true of THAT lot, and checking it against every
 * lot in evidence would let "this is the last pair" pass because some unrelated
 * item happens to have one left.
 *
 * Everything grounded when the question was an inventory search ("any griffey"),
 * because the reply legitimately covers several lots at different quantities.
 */
function groundedListings(i: GuardInput) {
  const resolve = (ids: Iterable<string>) => {
    const out = [];
    for (const id of new Set(ids)) {
      const l = i.currentListings.get(id);
      if (l) out.push(l);
    }
    return out;
  };

  const named = resolve(i.slots.listingIds);
  if (named.length) return named;
  return resolve(i.facts.map((f) => f.listingId).filter((x): x is string => Boolean(x)));
}


// ── 7. community rules ────────────────────────────────────────────────────────
//
// The rules of the ROOM, which are not our rules.
//
// Everything above this line checks a draft against things WE know: our
// catalog, our policy corpus, our never-say list. A subreddit, a Discord and a
// Twitch channel each impose their own, they differ per room, and the penalty
// for breaking one is not a bad reply — it is the account being banned and the
// operator losing the room. r/mechmarket rule 3 is "no vendor self-promotion
// outside the weekly thread", and a perfectly grounded, perfectly polite reply
// that links a store is exactly what gets removed.
//
// A community fact is therefore a CONSTRAINT, never an answer: it is the one
// corpus the composer must never cite as grounding, and the one a guard reads
// as a prohibition.
//
// The matching is deliberately literal. A rule can be enforced two ways, and
// both are things a human wrote down rather than things a model inferred:
//
//   * a QUOTED phrase in the rule text is matched verbatim in the draft — the
//     escape hatch for a rule that only a substring can express ("no 'DM me'");
//   * otherwise the clause after a prohibition marker ("no …", "do not …")
//     supplies its head terms, and all of them must appear in one sentence of
//     the draft.
//
// Erring toward blocking is correct HERE and nowhere else in this file. A false
// alarm costs the operator a draft they send by hand; a miss costs them the
// room. That asymmetry does not hold for the price guard, which is why this
// reasoning is written here rather than assumed everywhere.

/** Words that end a prohibition's subject and start its circumstances. A rule's
 *  teeth are in "no vendor self-promotion", not in "outside the weekly thread". */
const CLAUSE_END = new Set([
  "outside", "inside", "unless", "except", "without", "before", "after", "during",
  "while", "when", "if", "in", "on", "at", "to", "for", "from", "of", "than", "but",
]);

const PROHIBITION =
  /\b(?:no|never|do not|don'?t|avoid|not allowed|prohibited|banned|forbidden|must not|may not|cannot|can'?t)\b([^.;!?\n]*)/gi;

/** What a rule forbids, as things that can be looked for in a draft. */
export function forbiddenBy(ruleText: string): { literal: string[]; phrases: string[][] } {
  const literal = [...ruleText.matchAll(/["“']([^"”']{2,60})["”']/g)].map((m) => m[1]!.trim().toLowerCase());
  const phrases: string[][] = [];
  for (const m of ruleText.matchAll(PROHIBITION)) {
    const head: string[] = [];
    for (const raw of (m[1] || "").toLowerCase().match(/[a-z0-9]+/g) || []) {
      if (CLAUSE_END.has(raw)) break;
      const t = fold(raw);
      if (t.length > 1 && !head.includes(t)) head.push(t);
      if (head.length === 4) break;
    }
    if (head.length) phrases.push(head);
  }
  return { literal, phrases };
}

export const communityRuleGuard: Guard = {
  name: "community_rule",
  run(i: GuardInput): GuardResult {
    // eBay Live has no per-room rule corpus to retrieve, so this is n/a there
    // and the reference surface behaves exactly as it did.
    if (!i.surface?.communityRules) return na("community_rule");
    const rules = (i.community ?? []).filter((f) => f.corpus === "community");
    if (!rules.length) return na("community_rule");

    const answer = i.draft.answer;
    const lower = answer.toLowerCase();
    const bySentence = sentences(answer).map((s) => new Set(terms(s)));

    for (const rule of rules) {
      const { literal, phrases } = forbiddenBy(rule.text);
      const hitLiteral = literal.find((p) => lower.includes(p));
      const hitPhrase = hitLiteral
        ? null
        : phrases.find((head) => bySentence.some((st) => head.every((t) => st.has(t))));
      if (!hitLiteral && !hitPhrase) continue;
      const found = hitLiteral ?? hitPhrase!.join(" ");
      // The reason names the rule and cites the fact, because the operator's
      // next question is always "says who" and the console has to be able to
      // answer it without a second lookup.
      return fail(
        "community_rule", "block",
        `${rule.label}: ${rule.text.trim()} (${rule.factId}) — the draft is about "${found}".`,
        { expected: rule.factId, found },
      );
    }

    return allow("community_rule");
  },
};

// ── 8. sponsor claims ─────────────────────────────────────────────────────────
//
// A sponsored segment is the one place where saying something true but
// unapproved is still a problem. The obligations run both ways — there are
// claims the segment MUST make and claims it must NOT — and they are written
// down by someone who is not in the room, in a document the copilot either
// cites or has no business paraphrasing.
//
// So: when a sponsor corpus is in scope and the draft talks about the sponsored
// thing, the claim has to cite a sponsor fact. Not "a fact" — the grounding
// guard already checks that, and it would happily accept a product fact or the
// host's own speech, which is exactly the improvisation a sponsor contract is
// written to prevent.

export const sponsorGuard: Guard = {
  name: "sponsor",
  run(i: GuardInput): GuardResult {
    const sponsorFacts = i.facts.filter((f) => f.corpus === "sponsor");
    if (!sponsorFacts.length) return na("sponsor");

    // What the sponsorship is ABOUT: the distinctive words of each sponsor
    // fact's label, which is where the product's name lives ("Sponsor ·
    // Keychron Q1"). Generic corpus words are not subjects.
    const subjects = new Map<string, string>();
    for (const f of sponsorFacts) {
      for (const t of terms(f.label)) {
        if (t === "sponsor" || t === "sponsored" || t.length < 3) continue;
        if (!subjects.has(t)) subjects.set(t, f.label);
      }
    }
    if (!subjects.size) return na("sponsor");

    const mentioned = new Set(terms(i.draft.answer));
    const subject = [...subjects.keys()].find((t) => mentioned.has(t));
    if (!subject) return allow("sponsor");

    const cited = i.draft.claims.some((c) => i.factById.get(c.factId)?.corpus === "sponsor");
    if (cited) return allow("sponsor");

    return fail(
      "sponsor", "block",
      `Reply talks about the sponsored ${subjects.get(subject)} without citing an approved sponsor fact.`,
      {
        expected: sponsorFacts.map((f) => f.factId).join(" or "),
        found: i.draft.claims.length ? i.draft.claims.map((c) => c.factId).join(", ") : "no citation",
      },
    );
  },
};

export const GUARDS: Guard[] = [
  priceGuard, availabilityGuard, policyGuard, claimGroundingGuard, toneGuard, piiGuard,
  communityRuleGuard, sponsorGuard,
];

/**
 * Guards whose subject is the MODEL's citation discipline, not the content of
 * the reply.
 *
 * `claim_grounding` asks one question: did the composer cite a factId it was
 * actually handed, and does the cited fact support the sentence? That question
 * is meaningful about a machine-written draft and meaningless about a sentence
 * the operator typed themselves — they were never given a fact list, never
 * asked for a citation, and are asserting the sentence on their own authority.
 * Running it on an operator's edit rejected the seller's own words for not
 * citing an id nobody asked them to supply, which made editing a draft
 * impossible for any edit longer than "yes".
 *
 * Nothing that protects the BUYER is in here. Price, availability, policy, PII,
 * tone, community rules and sponsor obligations all still run on a human edit —
 * a seller can quote a stale price or leak a phone number as easily as a model
 * can. See `runChain`'s `authoredBy` option.
 */
export const MODEL_ONLY_GUARDS: ReadonlySet<GuardName> = new Set<GuardName>(["claim_grounding"]);
