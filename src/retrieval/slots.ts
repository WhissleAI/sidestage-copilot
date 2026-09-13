// Slot resolution — the "structured-first" half of retrieval.
//
// Buyer questions in live commerce are overwhelmingly about a specific ATTRIBUTE
// of a specific ITEM ("how much for the pandas", "size 10 still there?", "ship to
// canada?"). A pure similarity search answers those badly, because the right
// answer is a field lookup, not the most-similar paragraph. So we first try to
// resolve the question to (listing, attribute, policy topic) and read the fact
// directly; only what is left over goes to the similarity index.
//
// Anaphora — "it", "these", "that one" — resolves to the PINNED lot. In a live
// show that is almost always correct, because the host is holding the pinned lot
// while the buyer types.

import type { ListingWithDescription } from "../domain/repo.js";
import type { FactField } from "./facts.js";
import { fold, tokenize } from "./text.js";

export interface Slots {
  /**
   * What the buyer is hunting for, when the question is an inventory SEARCH
   * rather than a question about the lot on screen.
   *
   * This exists because real live-commerce chat is dominated by it. Reading an
   * actual eBay Live card show, the traffic is "any red sox", "Got any Grady
   * Sizemore?", "Any more Jeter's?", "any skubal" — asking whether something is
   * in tonight's lineup at all. Answering those against the pinned lot gives a
   * confident answer to a question nobody asked.
   */
  inventoryQuery: string | null;
  listingIds: string[];
  fields: FactField[];
  /** The FIRST attribute cue that matched — what the buyer actually asked about,
   *  as opposed to the fields pulled in by expansion. Retrieval ranks on this. */
  primaryField: FactField;
  policyTopics: string[];
  /** true when the listing came from anaphora rather than an explicit mention */
  viaAnaphora: boolean;
}

/** Fields whose answer is fundamentally a POLICY, not a property of the item.
 *  For these the governing clause outranks the listing's own field: a buyer
 *  asking "do i pay customs to the uk" needs the shipping policy, not the line
 *  that says this pair ships free domestically. */
export const POLICY_LED: ReadonlySet<FactField> = new Set<FactField>([
  "shipping", "returns", "authenticity", "discount",
]);

const ATTRIBUTE_CUES: [FactField, RegExp][] = [
  ["price", /\b(price|prices|cost|costs|how much|howmuch|asking|going for|lowest|best on|do (?:you|u) take|take for)\b/],
  ["discount", /\b(discount\w*|deal|deals|off|cheap\w*|lower|lowest|can (?:you|u) do|would (?:you|u) take|negotiat\w*|bundle|obo|offer\w*)\b/],
  ["availability", /\b(available|avail|still|left|in stock|instock|sold|gone|got any|any more|anymore|last one|claim\w*)\b/],
  ["sizing", /\b(size|sizes|sizing|fit|fits|run big|run small|runs|true to size|tts|half size)\b/],
  ["shipping", /\b(ship\w*|deliver\w*|post|mail|canada|uk|eu|international|intl|customs|duties|tracking|how (?:fast|long|soon))\b/],
  ["returns", /\b(return\w*|refund\w*|exchange|send (?:it )?back|money back)\b/],
  ["authenticity", /\b(authentic\w*|legit\w*|real|fake|rep|reps|cert\w*|checkcheck|verif\w*)\b/],
  ["condition", /\b(condition|ds|vnds|used|worn|crease\w*|flaw\w*|defect\w*|damage\w*|box|deadstock|yellow\w*)\b/],
  ["market", /\b(worth|resale|market|comps|going rate|value|retail)\b/],
];

// A resolved attribute implies the policy clause that governs it. Deriving the
// topics from `fields` keeps the two in sync — maintaining a parallel regex list
// was how "can you do 380" lost its discount policy.
const FIELD_TO_POLICY: Partial<Record<FactField, string>> = {
  shipping: "shipping",
  returns: "returns",
  authenticity: "authenticity",
  discount: "discount",
  price: "discount",
};

// Listing facts a field needs beyond the same-named one. A discount question is
// unanswerable without the current price and the market median.
const FIELD_EXPANSION: Partial<Record<FactField, FactField[]>> = {
  discount: ["price", "availability"],
  market: ["price"],
  price: ["availability"],
};

/** "any X", "got any X", "do you have X", "looking for X", "X?" as a bare name. */
// The character class allows "/" and "#" because collectors ask in shorthand —
// "any 1/1?", "any #/25", "got any RCs". Without them "Any 1/1?" matched nothing
// and fell through to a generic defer instead of a grounded "not tonight".
const ITEM_TERM = "[a-z0-9'’\\-\\./# ]{2,40}";
const INVENTORY_SEARCH = [
  new RegExp(`\\b(?:got |have |u got |you got |do you have |any more |anymore |any )\\s*(${ITEM_TERM})\\??$`, "i"),
  new RegExp(`\\blooking for\\s+(${ITEM_TERM})\\??$`, "i"),
  new RegExp(`\\bany\\s+(${ITEM_TERM})\\b`, "i"),
];

/**
 * Attribute vocabulary. Used to VALIDATE an extracted inventory term, not to veto
 * the whole question — a blanket veto on these words meant "any skenes left"
 * (the word "left") was read as an availability question about whatever lot was
 * on screen, and answered "no skenes left, the lot is sold out". It is both an
 * inventory hunt for Skenes AND an availability question; the hunt has to win,
 * because the item is the part the seller does not know.
 */
const ATTRIBUTE_WORD = /^(price|prices|cost|costs|shipping|ship|returns|return|refund|authentic|legit|size|sizes|fit|discount|discounts|deal|deals|lower|lowest|bundle|left|available|stock|more|else|other|good|new|thing|things|stuff|tonight|today|up|coming)$/i;

const ANAPHORA = /\b(it|its|it's|this|these|those|that|them|they|the pair|the one|current|right now)\b/;

/** Generic commerce vocabulary that appears in listing titles but discriminates
 *  nothing. Without this, "does it come with the original box" matched the
 *  Supreme BOX Logo hoodie instead of the lot on screen. */
const GENERIC_TITLE_TOKENS = new Set([
  "box", "hoodie", "hooded", "sweatshirt", "jacket", "retro", "high", "low", "og",
  "sp", "black", "white", "grey", "gray", "mens", "womens", "shoe", "shoes",
  "sneaker", "sneakers", "pair", "size", "new",
]);

/** Tokens worth matching a listing on. Brand/model/colorway words plus the size. */
function listingKeys(l: ListingWithDescription): { strong: Set<string>; size: string } {
  const strong = new Set<string>();
  for (const src of [l.brand, l.model, l.colorway, l.title]) {
    for (const t of tokenize(src)) {
      if (GENERIC_TITLE_TOKENS.has(t)) continue;
      strong.add(fold(t));
    }
  }
  // Nicknames and shorthand a buyer actually types.
  const nick = l.title.toLowerCase();
  if (nick.includes("panda")) strong.add("panda");
  if (nick.includes("chicago") || nick.includes("lost")) { strong.add("chicago"); strong.add("chi"); strong.add("lf"); }
  if (nick.includes("box logo")) { strong.add("bogo"); strong.add("boxlogo"); }
  if (nick.includes("travis")) { strong.add("travis"); strong.add("ts"); strong.add("cactus"); }
  if (nick.includes("chunky")) { strong.add("chunky"); strong.add("dunky"); }
  if (nick.includes("north face")) { strong.add("tnf"); strong.add("nuptse"); strong.add("puffer"); }
  if (nick.includes("990")) { strong.add("990"); strong.add("nb"); }
  if (nick.includes("slide")) { strong.add("slide"); strong.add("slides"); }
  return { strong, size: l.size };
}

export function resolveSlots(
  question: string,
  listings: ListingWithDescription[],
  pinnedId: string | null,
): Slots {
  const lower = question.toLowerCase();
  const qTokens = new Set(tokenize(question).map(fold));

  // ── which listing(s) ──
  const scored: { id: string; score: number }[] = [];
  for (const l of listings) {
    const { strong, size } = listingKeys(l);
    let score = 0;
    for (const t of qTokens) if (strong.has(t)) score += 2;
    // A size token only counts once a model token already matched, otherwise
    // "size 10" would match every size-10 listing in the catalog equally.
    if (score > 0 && qTokens.has(fold(size))) score += 1;
    if (score > 0) scored.push({ id: l.id, score });
  }
  scored.sort((a, b) => b.score - a.score);

  let listingIds = scored.filter((s) => s.score >= scored[0]?.score).map((s) => s.id).slice(0, 3);

  // ── inventory search? ──
  let inventoryQuery: string | null = null;
  for (const re of INVENTORY_SEARCH) {
    const m = lower.match(re);
    if (!m?.[1]) continue;

    let words = m[1]
      .trim()
      .replace(/[?.!]+$/, "")
      // The alternation can leave a leading quantifier on the captured term
      // ("Got any Grady Sizemore" -> "any grady sizemore").
      .replace(/^(?:any|more|some|other)\s+/i, "")
      .split(/\s+/)
      .filter(Boolean);

    // "any skenes left" -> the item is "skenes"; "left" is how they asked.
    while (words.length && ATTRIBUTE_WORD.test(words[words.length - 1])) words.pop();

    // A term that STARTS with an attribute word is asking about the attribute,
    // not hunting for an item: "any deal if i take two" is a discount question.
    if (!words.length || ATTRIBUTE_WORD.test(words[0])) continue;

    const term = words.join(" ");
    // "1/1" is only three characters but is a real, specific ask.
    if (term.length >= 2) {
      inventoryQuery = term;
      break;
    }
  }

  // ── which attribute(s) ──
  const fields: FactField[] = [];
  for (const [field, re] of ATTRIBUTE_CUES) if (re.test(lower)) fields.push(field);
  const namedAnAttribute = fields.length > 0;
  if (!namedAnAttribute) fields.push("identity");

  // No explicit item named. In a live show the subject is usually the pinned
  // lot, so fall back to it — but ONLY when the question actually looks like it
  // is about the lot on screen: it either uses an anaphor ("is it still there")
  // or names an attribute ("how much"). Falling back unconditionally was worse
  // than it sounds: it made EVERY question resolve to something, which silently
  // removed the system's ability to abstain at all.
  //
  // NOT when the buyer named an item we could not find. "any skenes left" with no
  // Skenes in the catalog must answer "not in tonight's lineup" — falling back to
  // the lot on screen produced "no cards left for the pinned lot, it's sold out",
  // which is a confident answer to a question nobody asked.
  let viaAnaphora = false;
  if (!listingIds.length && !inventoryQuery && pinnedId && (ANAPHORA.test(lower) || namedAnAttribute)) {
    listingIds = [pinnedId];
    viaAnaphora = true;
  }

  // Expand each field to the listing facts it actually needs to be answerable.
  for (const f of [...fields]) {
    for (const extra of FIELD_EXPANSION[f] || []) if (!fields.includes(extra)) fields.push(extra);
  }

  const policyTopics = [...new Set(fields.map((f) => FIELD_TO_POLICY[f]).filter((x): x is string => !!x))];

  return { inventoryQuery, listingIds, fields, primaryField: fields[0], policyTopics, viaAnaphora };
}
