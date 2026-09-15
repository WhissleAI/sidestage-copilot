// Intent classification and the admission gate.
//
// Deterministic on purpose. An LLM classifier would cost a network round trip
// before the round trip that actually drafts the reply, and the whole 2-second
// budget has room for exactly one. Live-commerce chat is also unusually
// tractable: buyers ask a small, stable set of questions in a small, stable
// vocabulary, so cue matching gets most of the way there at zero latency.
//
// The gate matters as much as the classifier. A live chat is mostly hype — "W",
// "LETS GOOO", emotes — and replying to it would be both wasteful and obviously
// robotic. Everything is still shown to the seller in the ticker; only genuine
// questions become proposals.

import type { ChatIntent, SpeechAct } from "../domain/types.js";

const CUES: [ChatIntent, RegExp][] = [
  // "10% off", "$20 off", "will you take less", "any deals", "price drop" were
  // all missed, so four buyers asking for a discount never reached the three
  // it takes to propose a markdown (measured 2026-09-15).
  ["discount_request", /\b(discount\w*|deals?|cheap\w*|lower\w*|lowest|can (?:you|u) do|(?:would|will|could) (?:you|u) take|take (?:less|\$?\d)|\$?\d+\s*%?\s*off|percent off|price drop|negotiat\w*|obo|bundle|best (?:price|offer)|offer\w*)\b/i],
  ["price_question",   /\b(price|prices|cost|costs|how much|howmuch|asking|going for|what.?s it at)\b/i],
  ["availability",     /\b(available|avail|still (?:there|up|have|got)|left|in stock|instock|sold|gone|any more|anymore|last one|claim\w*|\bmine\b)\b/i],
  ["sizing",           /\b(size|sizes|sizing|fit|fits|run big|run small|runs|true to size|tts|half size|what size)\b/i],
  ["shipping",         /\b(ship\w*|deliver\w*|post|mail|canada|uk|eu|international|intl|customs|duties|tracking|how (?:fast|long|soon))\b/i],
  ["returns",          /\b(return\w*|refund\w*|exchange|send (?:it )?back|money back)\b/i],
  ["authenticity",     /\b(authentic\w*|legit\w*|\breal\b|fake|rep|reps|cert\w*|checkcheck|verif\w*)\b/i],
  ["comparison",       /\b(vs\.?|versus|compare[d]?|better than|difference between|which (?:one|is better))\b/i],
];

/** Chat that is pure reaction. Every token has to be one of these to count. */
const HYPE_TOKENS = new Set([
  "w", "l", "lol", "lmao", "lul", "lulw", "kekw", "pog", "pogchamp", "gg", "ez",
  "omg", "omfg", "hi", "hey", "yo", "sheesh", "based", "fire", "clean", "heat",
  "grail", "grails", "letsgo", "letsgoo", "letsgooo", "lets", "go", "goo", "gooo",
  "bro", "fr", "facts", "yes", "yep", "no", "nah", "ok", "okay", "wow", "damn",
  "nice", "cool", "sick", "dope", "yessir", "banger", "peak", "mid", "gm", "gn",
]);

/** Opens like a question, whether or not it ends in a question mark. Buyers
 *  typing fast on a phone drop the "?" constantly, and treating those as hype
 *  silently dropped real questions — including "can you hold it til friday". */
const INTERROGATIVE = /^(?:do|does|did|can|could|will|would|is|are|was|were|have|has|any|how|what|whats|when|where|why|who|which|whos|u |you )\b/i;

export function classify(text: string): ChatIntent {
  const t = (text || "").trim();
  if (!t) return "other";
  if (isHype(t)) return "hype";
  for (const [intent, re] of CUES) if (re.test(t)) return intent;
  return t.includes("?") || INTERROGATIVE.test(t) ? "other" : "hype";
}

export function isHype(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  return words.every((w) => HYPE_TOKENS.has(w) || /^(?:ha)+h?$/.test(w) || /^\d+$/.test(w));
}

export interface AdmissionResult {
  admitted: boolean;
  intent: ChatIntent;
  speechAct: SpeechAct;
  reason?: string;
}

/** Should this message become a reply proposal?
 *  `rateOk` is supplied by the caller's token bucket so that the decision, and
 *  the reason it was made, are reported together. */
/**
 * The speech act of a comment, on the same axis Whissle measures the host's
 * audio on.
 *
 * Two axes, because they answer different questions and the topic axis alone
 * gets this wrong in a specific, visible way: a topic cue matches the WORDS, so
 * "Offer from Lesbie 👆" — one buyer relaying another's offer to the host —
 * matched `offer`, was classified `discount_request`, and became a reply to a
 * question nobody had asked. Cue order matters: an explicit question beats
 * everything, because "can you do $850?" is a query whatever else it contains.
 */
const SPEECH_ACTS: [SpeechAct, RegExp][] = [
  // A direct request to DO something. Checked before `query` because "can you
  // hold it" is a command wearing a question's clothes, and the distinction is
  // what makes it worth answering.
  ["command", /\b(hold (?:it|this|that|one)|save (?:it|one|me)|put me down|claim(?:ing)? (?:it|this)|dm me|invoice me|ship (?:it|me)|add me|count me in|i'?ll take (?:it|that|this)|sold to me)\b/i],
  ["query", /(\?|^(?:what|which|where|when|why|who|how|is|are|do|does|did|can|could|would|will|any|anyone|got|have|has|whats|what'?s|hows|how'?s)\b)/i],
  ["greeting", /^(?:hi|hey|hello|yo|sup|gm|good (?:morning|evening|afternoon)|first time|just (?:got|joined) here)\b/i],
  // A want with no question in it. "need these", "want that one" — real demand
  // signal for the action proposer, but not something to reply to.
  ["wish", /\b(i (?:need|want|wish)|need (?:these|those|that|this)|want (?:these|those|that|this)|wish i|gotta have)\b/i],
];

export function classifySpeechAct(text: string): SpeechAct {
  const t = (text || "").trim();
  if (!t) return "other";
  for (const [act, re] of SPEECH_ACTS) if (re.test(t)) return act;
  // Everything else is someone saying something. The dominant case in live
  // chat by volume, and the one that must not become a reply.
  return "inform";
}

export function admit(
  text: string,
  intent: ChatIntent,
  rateOk: boolean,
  speechAct: SpeechAct = classifySpeechAct(text),
): AdmissionResult {
  const t = (text || "").trim();

  // Reaction is checked before length, and stays there: the operator console
  // shows this reason on the dropped row, and "reaction, not a question" tells
  // them more about a "W" than "too short" does. A COMMAND is exempt — "i'll
  // take it" reads as pure hype to the topic cues and is the single most
  // actionable thing a buyer says all show.
  // A command is answerable whatever its topic: "i'll take it" reads as pure
  // hype to the cues and is the single most actionable thing a buyer says.
  if (speechAct !== "command") {
    // The speech act names the reason when it has something specific to say,
    // because "a greeting" is more use to the operator than "reaction".
    if (speechAct === "greeting") {
      return { admitted: false, intent, speechAct, reason: "a greeting, not a question" };
    }
    if (speechAct === "wish") {
      // Still a demand signal the action proposer wants — just not a reply.
      return { admitted: false, intent, speechAct, reason: "wants the item, but asked nothing" };
    }
    if (intent === "hype") {
      return { admitted: false, intent, speechAct, reason: "reaction, not a question" };
    }
  }
  if (t.length < 3) return { admitted: false, intent, speechAct, reason: "too short to be a question" };
  if (t.length > 500) return { admitted: false, intent, speechAct, reason: "too long for a live-chat reply" };

  // The speech act is decided FIRST, because it is the stronger signal about
  // whether a comment wants an answer at all — and because the topic axis gets
  // this backwards in both directions. "i'll take it" is pure hype by topic
  // cues and is the most actionable thing a buyer can say; "Offer from Lesbie"
  // is a discount request by topic cues and is someone talking to the host.
  //
  // A command is answerable whatever its topic.
  if (speechAct !== "command" && speechAct !== "query") {
    return { admitted: false, intent, speechAct, reason: "a statement, not a question" };
  }

  if (!rateOk) return { admitted: false, intent, speechAct, reason: "proposal rate cap reached" };

  return { admitted: true, intent, speechAct };
}

/** Refilling token bucket. Caps how many proposals a burst of chat can create,
 *  so a busy show cannot outrun either the LLM pool or the seller's attention. */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();

  constructor(private perMin: number) {
    this.tokens = perMin;
  }

  tryAdmit(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.perMin, this.tokens + ((now - this.last) / 60_000) * this.perMin);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
