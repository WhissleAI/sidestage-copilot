// What IS lot #007?
//
// eBay Live names lots for the seller automatically, and the name carries no
// product in it:
//
//   "#007 - As seen on eBay LIVE on Bonkers Cards LIVE"
//
// There is no item link in the player, no SKU, no category. So on a monitored
// show the copilot has a price and an availability for something it cannot
// name — which is why a buyer asking "how much for the Griffey" got an
// abstention while the Griffey was on screen with a live price on it.
//
// The identity exists, just not in the DOM. It is in the two places a human
// assistant would look:
//
//   the host's own speech   "this one's a 'eighty-nine Griffey Upper Deck, PSA 9"
//   the camera              a graded slab held up to the lens
//
// Both are already flowing through this app. This asks the show's own agent to
// turn them into a name, and writes that name onto the lot so retrieval can
// match a buyer's words against it.
//
// THE BOUNDARY. An inferred name is not a catalog fact and never becomes one.
// It is written to the lot's display name and description — the fields
// retrieval matches on — and never to price, quantity, condition or
// certificate. Those still come from what the stream actually reported, or they
// are not said. A guess about WHICH item is recoverable; a guess about what it
// costs is not.

import type { LlmPort } from "../llm/types.js";
import type { ShowContext } from "../domain/types.js";

/**
 * Titles eBay or the seller filled in with a shrug.
 *
 * "as seen on screen" is the tell, and it survives in titles that otherwise
 * look descriptive: "#120 - POKEMON CARD(S) - AS SEEN ON SCREEN" names a
 * CATEGORY, not an item, and a buyer asking about a Charizard matches nothing
 * in it. Those are worth naming too.
 */
const PLACEHOLDER = /as seen on (?:ebay ?live|screen)|item shown on screen|shown live|^#?\d+\s*[-–]\s*$/i;

/** Words that describe a department rather than a product. A title made only of
 *  these is a category label wearing a lot number. */
const CATEGORY_ONLY = new Set([
  "card", "cards", "slab", "slabs", "single", "singles", "pack", "packs", "box",
  "lot", "lots", "item", "items", "bundle", "mystery", "graded", "raw", "vintage",
  "modern", "sealed", "auction", "live", "screen", "seen", "shown",
]);

export function needsIdentity(title: string): boolean {
  const t = (title || "").trim();
  if (!t) return true;
  if (PLACEHOLDER.test(t)) return true;
  // Strip lot numbers, dates and punctuation, then ask whether anything is left
  // that could name a PRODUCT rather than a shelf it sits on.
  const words = t
    .toLowerCase()
    .replace(/[#\d/().,-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !CATEGORY_ONLY.has(w));
  return words.length < 2;
}

export interface LotIdentity {
  /** A short human name — "1989 Griffey Upper Deck RC". */
  name: string;
  /** Where the identity came from, kept so the operator can judge it. */
  basis: "speech" | "camera" | "both";
}

const PROMPT = [
  "You are naming ONE lot in a live selling show so a copilot can match buyer questions to it.",
  "",
  "Answer with the item's name ONLY — at most 10 words, no sentence, no price, no condition",
  "grade, no certificate number. If the evidence does not identify a specific item, answer",
  "exactly: unknown.",
  "",
  "Do not guess from the show's category alone. \"a baseball card\" is not a name.",
].join("\n");

/**
 * Name a lot from what the show itself is saying and showing.
 *
 * Returns null rather than a guess when the evidence is thin — an unnamed lot
 * retrieves nothing, which is a bad answer; a WRONGLY named lot retrieves
 * confidently, which is a worse one.
 */
export async function enrichLot(
  llm: LlmPort,
  lot: { title: string; priceCents: number },
  ctx: ShowContext | null,
  showTitle: string,
): Promise<LotIdentity | null> {
  const speech = [ctx?.currentTopic, ...(ctx?.recentPoints ?? [])]
    .filter((x): x is string => Boolean(x && x.trim() && x !== "Getting started"))
    .join(". ");
  const camera = ctx?.onScreen?.text ?? "";
  if (!speech && !camera) return null;

  const evidence = [
    `Show: ${showTitle}`,
    `Lot as eBay names it: ${lot.title}`,
    speech ? `What the host is saying right now: ${speech}` : "",
    camera ? `What is on camera right now: ${camera}` : "",
  ].filter(Boolean).join("\n");

  let raw: string;
  try {
    raw = await llm.utilityTurn(PROMPT, evidence, { maxTokens: 40 });
  } catch {
    // Naming is an enhancement. A failed call costs this lot its name and
    // nothing else — the price and availability are untouched.
    return null;
  }

  const name = clean(raw);
  if (!name) return null;
  return {
    name,
    basis: speech && camera ? "both" : camera ? "camera" : "speech",
  };
}

function clean(raw: string): string {
  let t = (raw || "").trim().replace(/^["'`]+|["'`]+$/g, "");
  // The model is asked for a name and sometimes returns a sentence about one.
  t = t.split("\n")[0]!.trim();
  if (!t || /^unknown\.?$/i.test(t)) return "";
  // A "name" with a price in it is the model ignoring the one instruction that
  // matters here — drop it rather than let a guessed number near a listing.
  if (/[$£€]\s*\d/.test(t)) return "";
  if (t.length > 80) return "";
  return t;
}
