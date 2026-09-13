// The six guards. Every one is DETERMINISTIC: no model is asked whether a reply
// is safe. A guard either points at a fact that contradicts the draft, or it
// allows. That is the difference between a guardrail and a second opinion.
//
// Each returns `allow`, `revise` (the composer gets one bounded repair pass with
// the reason attached) or `block` (the reply never reaches the buyer without the
// seller editing it).

import type { GuardResult } from "../domain/types.js";
import { extractMoneyCents, formatMoney } from "../domain/money.js";
import { cosine, ngramVector, terms } from "../retrieval/text.js";
import { allow, fail, na, sentences, type Guard, type GuardInput } from "./types.js";
import { neverSayMatchers, policy } from "./policy.js";

/** A clause that declines or quotes the buyer back rather than committing. */
const DECLINING = /\b(can'?t|cannot|can not|unable|not able|won'?t|will not|no lower|lowest i can|too low|below (?:my|the)|under (?:my|the)|instead)\b/i;

const ASSERTS_AVAILABLE = /\b(still (?:available|here|up|in stock|have)|in stock|available|it'?s yours|grab it|claim it|yes[,!. ]|we (?:do )?have|i (?:do )?have|got (?:it|one|some)|last one|last pair)\b/i;
const ASSERTS_SOLD_OUT = /\b(sold out|sold|gone|no longer available|none left|all out)\b/i;

// ── 1. price ──────────────────────────────────────────────────────────────────
//
// The signature check. Every money amount in the reply must be traceable to a
// grounding fact AND that fact must have been read at the listing's CURRENT
// version. A markdown landing between retrieval and send makes the draft stale,
// and this is what proves it rather than hoping nobody notices.
export const priceGuard: Guard = {
  name: "price",
  run(i: GuardInput): GuardResult {
    const amounts = extractMoneyCents(i.draft.answer);
    if (!amounts.length) return na("price");

    const echoed = new Set(extractMoneyCents(i.question));
    const priceFacts = i.facts.filter((f) => f.numericCents !== undefined);

    // Every money amount that any retrieved fact STATES, not just the ones a
    // fact carries as a typed price. Shipping costs, flat fees and thresholds
    // live in the prose of a listing or policy fact ("ships USPS Ground
    // Advantage at a flat $9.95"), and without this the guard read a shipping
    // charge as an item-price commitment and blocked it for being below the
    // floor. Found against a real eBay Live show, not in the eval set.
    const statedInFacts = new Set<number>();
    for (const f of i.facts) for (const c of extractMoneyCents(f.text)) statedInFacts.add(c);
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

      // (c) The amount is stated verbatim by a grounding fact that is not a
      //     price fact — a shipping charge, a free-shipping threshold, a bundle
      //     percentage. Repeating a fact is not making an offer.
      if (statedInFacts.has(amount)) continue;

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
export const availabilityGuard: Guard = {
  name: "availability",
  run(i: GuardInput): GuardResult {
    const listing = firstResolvedListing(i);
    if (!listing) return na("availability");
    const a = i.draft.answer;

    const claimsAvailable = ASSERTS_AVAILABLE.test(a);
    const claimsSoldOut = ASSERTS_SOLD_OUT.test(a);

    if (claimsAvailable && !claimsSoldOut && listing.qty === 0) {
      return fail("availability", "block", `Reply says the item is available but ${listing.title} has 0 left.`,
        { expected: "sold out (qty 0)", found: "available" });
    }
    if (claimsSoldOut && !claimsAvailable && listing.qty > 0) {
      return fail("availability", "revise", `Reply says sold out but ${listing.qty} remain.`,
        { expected: `${listing.qty} available`, found: "sold out" });
    }

    // "last one" is a scarcity claim the prohibited-claims policy only permits
    // when it is literally true.
    if (/\b(last (?:one|pair|piece)|only one left|final one)\b/i.test(a) && listing.qty !== 1) {
      return fail("availability", "block", `Reply calls it the last one but quantity is ${listing.qty}.`,
        { expected: "qty 1", found: `qty ${listing.qty}` });
    }

    // A stated count must match the live count.
    const counts = [...a.matchAll(/\b(\d{1,3})\s*(?:left|available|in stock|remaining|pairs?|units?)\b/gi)]
      .map((m) => Number(m[1]));
    for (const c of counts) {
      if (c !== listing.qty) {
        return fail("availability", "block", `Reply states ${c} available; the listing has ${listing.qty}.`,
          { expected: `${listing.qty}`, found: `${c}` });
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
const FACTUAL = /\d|\$|\b(ship\w*|return\w*|refund\w*|authentic\w*|cert\w*|size|available|stock|left|condition|deadstock|vnds|box|free|polic\w*|median|comps?)\b/i;

export const claimGroundingGuard: Guard = {
  name: "claim_grounding",
  run(i: GuardInput): GuardResult {
    const a = i.draft.answer;
    const needsGrounding = FACTUAL.test(a);

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
          ? "Reply makes factual statements but cites no grounding facts."
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

/** The listing the question resolved to, read at CURRENT state. */
function firstResolvedListing(i: GuardInput) {
  for (const id of i.slots.listingIds) {
    const l = i.currentListings.get(id);
    if (l) return l;
  }
  return null;
}

export const GUARDS: Guard[] = [
  priceGuard, availabilityGuard, policyGuard, claimGroundingGuard, toneGuard, piiGuard,
];
