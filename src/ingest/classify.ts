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

import type { ActionKind, ChatIntent, SpeechAct, Stance } from "../domain/types.js";

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
  // "Orange", "large", "size 10", "the bigger one": a buyer naming an
  // attribute with no verb is asking whether it comes that way. Measured on
  // 2026-09-15 — "Orange" during a gem show fell through to hype and got the
  // hype placeholder instead of a look at the lot.
  if (isBareAttribute(t)) return "availability";
  return t.includes("?") || INTERROGATIVE.test(t) ? "other" : "hype";
}

const ATTRIBUTE_WORDS = new Set([
  "orange", "red", "blue", "green", "black", "white", "pink", "purple", "yellow", "gold", "silver",
  "brown", "grey", "gray", "teal", "navy", "beige", "cream", "tan", "clear", "rainbow", "multicolor",
  "small", "medium", "large", "xs", "s", "m", "l", "xl", "xxl", "xxxl", "big", "bigger", "biggest",
  "smaller", "smallest", "larger", "largest", "tiny", "huge", "mini", "size", "sz", "mens", "womens",
  "kids", "youth", "raw", "polished", "tumbled", "rough", "matte", "glossy",
]);

/** Every word is an attribute (or a size number), and there are at most four. */
export function isBareAttribute(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z0-9\s.]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return false;
  const filler = new Set(["the", "a", "an", "one", "in", "any", "that", "this", "ones", "pls", "please"]);
  const core = words.filter((w) => !filler.has(w));
  if (!core.length) return false;
  return core.every((w) => ATTRIBUTE_WORDS.has(w) || /^\d{1,2}(?:\.5)?$/.test(w));
}

export function isHype(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  return words.every((w) => HYPE_TOKENS.has(w) || /^(?:ha)+h?$/.test(w) || /^\d+$/.test(w));
}

// ── the third axis: what they want from us ───────────────────────────────────
//
// Topic and speech act between them still cannot tell apart three things that
// need three different answers, and the gap only shows on a surface where the
// reply is permanent.
//
//   asking       a question with an answer. Answer it.
//   complaining  a grievance. The answer is acknowledgement FIRST; a reply that
//                cheerfully restates the returns policy to somebody on their
//                third unanswered email makes it worse, and it is still a
//                question by every other measure.
//   baiting      an invitation to argue. Every correct answer is wrong, because
//                answering is the thing being solicited — so this never becomes
//                a draft. It becomes a hand-off, and the human may well decide
//                the right move is silence.
//
// Deliberately narrow. A false `baiting` silently drops a real customer, so the
// cues are provocation and personal attack — not rudeness, not swearing, and
// not the word "scam" on its own: "is this a scam?" is one of the commonest
// honest questions a buyer asks, and it is `asking`.

/**
 * Bait whatever the punctuation: aimed at a person, or soliciting an argument.
 * "Are you a bot?" is a question by every formal measure and is still not a
 * question we should answer on our own.
 */
const BAIT_ALWAYS: RegExp[] = [
  // Soliciting a fight. None of these has an answer that ends the exchange.
  // `ratio'd` and not bare "ratio": a card show says "the PSA 10 ratio on these
  // is nuts" all night, and dropping those as bait would be the expensive kind
  // of wrong.
  /\b(prove me wrong|prove it then|cope|seethe|cry more|cry about it|touch grass|skill issue|ratio'?e?d|fight me|change my mind|do something about it|go on then|downvote me|try me)\b/i,
  // A personal attack. "you" plus contempt, which is the pattern that survives
  // paraphrase — the specific insult never does.
  /\b(?:you|u|ur|you'?re|your)\b[^.?!]{0,40}\b(clown|clowns|idiot|idiots|moron|morons|dumb|stupid|pathetic|joke|trash|garbage|liar|lying|scum|shill|bot|bots)\b/i,
  /\b(shut up|get lost|piss off|kys|nobody asked|who asked|didn'?t ask)\b/i,
];

/**
 * An accusation, and only when it is ASSERTED.
 *
 * "Is this a scam?" is one of the commonest honest questions a buyer asks and
 * it has an answer. "This is a scam" is a verdict looking for an argument. The
 * words are the same; the punctuation is the whole difference, so these are
 * checked only on a message that is not asking anything.
 */
const BAIT_ASSERTED: RegExp[] = [
  /\b(?:this|that|it|these|they|y'?all|you(?:'| a)?re|its|it'?s)\b[^.?!]{0,30}\b(scam|scammer|scammers|grift|grifter|fraud|ripoff|rip[- ]off|snake oil|astroturf\w*|shill\w*)\b/i,
  /\b(obvious (?:shill|scam|ad|astroturf)|literally a scam|corporate shill|paid shill|just an ad|another ad|sponsored garbage)\b/i,
];

/** A grievance about something that actually happened to them. */
const COMPLAINT: RegExp[] = [
  // Time passing with nothing happening — the single most reliable complaint
  // signal, and the one a policy paragraph answers worst.
  /\b(still (?:waiting|haven'?t|hasn'?t|no)|never (?:arrived|received|got|shipped|showed)|no (?:response|reply|answer|update)|third time|second time|twice now|\d+ (?:days?|weeks?|months?) (?:and|now|later|ago)|been (?:waiting|\d+))\b/i,
  // Said plainly.
  /\b(ridiculous|unacceptable|disappointed|disappointing|frustrat\w*|fed up|worst|terrible|awful|useless|waste of (?:money|time)|never again)\b/i,
  // Something is broken, or the money went the wrong way.
  /\b(broke after|stopped working|doesn'?t work|does not work|won'?t work|arrived (?:broken|damaged|cracked|wrong)|wrong item|charged (?:me )?twice|double charged|still charged|want (?:my|a) refund|refund me)\b/i,
];

/**
 * What the person wants from us.
 *
 * Order is the argument. Provocation and personal attack come first because a
 * hand-off is the stricter answer and those are bait however they are phrased.
 * An ASKED accusation is spared next — that ordering is the only thing
 * separating "is this a scam?" from "this is a scam", and getting it wrong
 * drops a real buyer's most reasonable question. Complaint then outranks
 * asking, because a grievance is usually also a question and "answer it" is
 * the wrong instruction for one.
 */
export function classifyStance(text: string): Stance {
  const t = (text || "").trim();
  if (!t) return "neutral";
  if (BAIT_ALWAYS.some((re) => re.test(t))) return "baiting";
  const asking = t.includes("?") || INTERROGATIVE.test(t);
  if (!asking && BAIT_ASSERTED.some((re) => re.test(t))) return "baiting";
  if (COMPLAINT.some((re) => re.test(t))) return "complaining";
  return asking ? "asking" : "neutral";
}

/** What to do with a message instead of drafting for it, when the answer is
 *  "not this". Only bait has one today; the shape is here because the console
 *  needs to know a hand-off was RAISED, not merely that a draft was skipped. */
export function handoffFor(stance: Stance): ActionKind | undefined {
  return stance === "baiting" ? "flag_for_human" : undefined;
}

export interface AdmissionResult {
  admitted: boolean;
  intent: ChatIntent;
  speechAct: SpeechAct;
  /** What they want from us — see `classifyStance`. */
  stance: Stance;
  /** Set when the message should reach a person instead of a draft. */
  handoff?: ActionKind;
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
  stance: Stance = classifyStance(text),
): AdmissionResult {
  const t = (text || "").trim();

  // Bait is refused before every other check, including the command exemption.
  // It is the one case where the gate's usual question — is this worth
  // answering — has the wrong shape: the message is worth a PERSON, and a
  // draft, however good, is the response being fished for. The hand-off is on
  // the result rather than implied by the refusal, because the console has to
  // show that somebody was asked to look, not merely that we stayed quiet.
  if (stance === "baiting") {
    return {
      admitted: false, intent, speechAct, stance,
      handoff: handoffFor(stance),
      reason: "bait, not a question — handed to a human",
    };
  }

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
      return { admitted: false, intent, speechAct, stance, reason: "a greeting, not a question" };
    }
    if (speechAct === "wish") {
      // Still a demand signal the action proposer wants — just not a reply.
      return { admitted: false, intent, speechAct, stance, reason: "wants the item, but asked nothing" };
    }
    if (intent === "hype") {
      return { admitted: false, intent, speechAct, stance, reason: "reaction, not a question" };
    }
  }
  if (t.length < 3) return { admitted: false, intent, speechAct, stance, reason: "too short to be a question" };
  if (t.length > 500) return { admitted: false, intent, speechAct, stance, reason: "too long for a live-chat reply" };

  // The speech act is decided FIRST, because it is the stronger signal about
  // whether a comment wants an answer at all — and because the topic axis gets
  // this backwards in both directions. "i'll take it" is pure hype by topic
  // cues and is the most actionable thing a buyer can say; "Offer from Lesbie"
  // is a discount request by topic cues and is someone talking to the host.
  //
  // A command is answerable whatever its topic.
  if (speechAct !== "command" && speechAct !== "query") {
    return { admitted: false, intent, speechAct, stance, reason: "a statement, not a question" };
  }

  if (!rateOk) return { admitted: false, intent, speechAct, stance, reason: "proposal rate cap reached" };

  return { admitted: true, intent, speechAct, stance };
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
