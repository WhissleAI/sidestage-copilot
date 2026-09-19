// Who is worth a follow-up, out of everyone who spoke during a show.
//
// ── the rule, and the show it was written against ──────────────────────────
//
// `ebay_47tK1SX0VsiHEXN1`, a real fragrance auction, ended with:
//
//     190  comments seen
//     126  of them pure hype ("W", "🔥", "LETS GOOO")
//      60  drafted replies, from 29 distinct buyers
//       0  sent — the seller never touched the queue
//       0  blocked, 0 abstained, 0 dismissed
//       0  actions committed
//
// Every one of those 29 people asked something answerable ("Burberry Her
// Elixir?", "Can you run YSL Libre Berry Crush?", "is it 100ml?") and walked
// away without an answer. The rule below turns that show into 29 follow-ups —
// one per buyer, not 60, because a person who asked twice is still one person
// and two messages from a stranger reads as a stranger who wants something.
//
// A buyer is a follow-up when all four are true:
//
//   1. The copilot COULD have answered them. Not abstained, not blocked, not
//      revised into nothing — an abstention means the catalog had no answer in
//      it, and drafting one later from the same catalog produces the same
//      nothing. Those belong in the report's gaps list, which already has them.
//   2. They never got the answer. The proposal was never sent or auto-sent.
//      Following up with a reply they already received is not a lead, it is a
//      second copy.
//   3. The seller did not settle it themselves — no `dismissed`, and no
//      committed action on a listing this answer was grounded in after they
//      asked. A markdown or a push that lands on the lot they asked about IS
//      the answer; sending it again by message is asking twice for one sale.
//   4. They asked something. Hype is dropped, at both the proposal's recorded
//      intent and — for rows written before intent was recorded — by running
//      the same classifier the live gate runs. 126 of 190 comments on that show
//      were hype, and a DM to somebody whose entire contribution was "🔥" is
//      the exact thing that makes a seller's account look automated.
//
// Everything here is pure: a `ShowRecord` in, a list out. The record is already
// the durable copy of what happened (src/shows/record.ts), so the selection can
// be argued with, re-run and tested without a show, a pipeline or a network.

import { classify } from "../../ingest/classify.js";
import type { RecordedAction, RecordedProposal, ShowRecord } from "../../shows/record.js";

/** One person, one question, ready to be drafted for. */
export interface FollowUp {
  /** The buyer's handle, exactly as the surface gave it. */
  buyer: string;
  /** The single question we will answer — see `better()` for which one wins. */
  question: string;
  /** The comment it came from, so the console can open the moment in the show. */
  messageId: string | null;
  /** What kind of question it was, for ordering the inbox. */
  intent: string;
  /** When they asked. */
  askedAt: string;
  /** How many answerable, unconverted questions this buyer left behind. One is
   *  the common case; more than one is a buyer who was really trying. */
  asked: number;
}

/** A reply that reached the buyer during the show. Nothing to follow up. */
const DELIVERED = new Set(["sent", "auto_sent"]);

/** A proposal the copilot could not stand behind. `drafting` never settled;
 *  `blocked` was refused by a guard and will be refused again. */
const UNANSWERABLE = new Set(["drafting", "blocked"]);

/**
 * How much a question is worth following up, when a buyer left several.
 *
 * Purchase intent, roughly ordered. "Whats the lowest on the Burberry" is a
 * person with their card out; "Will you look through your list" is a person
 * being friendly. Both are real, only one is worth a message three hours later.
 */
const INTENT_WORTH: Record<string, number> = {
  discount_request: 6,
  price_question: 5,
  availability: 5,
  sizing: 4,
  comparison: 4,
  authenticity: 3,
  shipping: 3,
  returns: 3,
  other: 1,
  hype: 0,
};

/** The intent this proposal was recorded with, or — for a row written before
 *  the column carried one — what the live gate would call it today. */
function intentOf(p: RecordedProposal): string {
  return p.intent ?? classify(p.question);
}

/** Which listings an answer was grounded in. Evidence ids are addressable by
 *  design (`listing:lst_aj1_chi_10#price`), so the listing a reply leaned on is
 *  readable off the record without storing it a second time. */
function listingsCited(p: RecordedProposal): string[] {
  const out: string[] = [];
  for (const e of p.evidence ?? []) {
    const id = (e as { factId?: unknown }).factId;
    if (typeof id !== "string") continue;
    const m = id.match(/^listing:([^#]+)/);
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * The seller's own answer to a question: a write that actually landed.
 *
 * Only `committed`. A proposed-and-never-approved markdown is the seller
 * NOT acting, which is the same state as not replying — and treating it as a
 * conversion would delete the follow-up for the buyer who prompted it.
 */
function committedOn(actions: RecordedAction[]): Map<string, string> {
  const earliest = new Map<string, string>();
  for (const a of actions) {
    if (a.status !== "committed" || !a.listingId) continue;
    const prev = earliest.get(a.listingId);
    if (!prev || a.createdAt < prev) earliest.set(a.listingId, a.createdAt);
  }
  return earliest;
}

/** Did the seller act on this question during the show? */
function actedOn(p: RecordedProposal, committed: Map<string, string>): boolean {
  for (const listingId of listingsCited(p)) {
    const at = committed.get(listingId);
    // After they asked, not before: a price that was already marked down when
    // the question arrived is the state they were asking about, not a reply.
    if (at && at >= p.at) return true;
  }
  return false;
}

/** Which of a buyer's two questions we answer. Worth first, then how well it
 *  could be grounded, then the last thing they said — because the last thing
 *  they said is where they left the conversation. */
function better(a: RecordedProposal, b: RecordedProposal): RecordedProposal {
  const worth = (p: RecordedProposal) => INTENT_WORTH[intentOf(p)] ?? 1;
  if (worth(a) !== worth(b)) return worth(a) > worth(b) ? a : b;
  const ground = (p: RecordedProposal) => (p.evidence ?? []).length;
  if (ground(a) !== ground(b)) return ground(a) > ground(b) ? a : b;
  return a.at >= b.at ? a : b;
}

/**
 * The people who asked and did not buy, one row each.
 *
 * Ordered by what the question was worth and then by when it was asked, so an
 * inbox opened after a three-hour show has the price questions at the top.
 */
export function selectFollowUps(record: ShowRecord): FollowUp[] {
  const committed = committedOn(record.actions ?? []);
  const best = new Map<string, { pick: RecordedProposal; asked: number }>();

  for (const p of record.proposals ?? []) {
    if (UNANSWERABLE.has(p.status)) continue;
    if (DELIVERED.has(p.status)) continue;
    if (p.status === "dismissed") continue;
    if (p.verdict === "block" || p.abstained) continue;
    if (!p.question.trim()) continue;
    if (intentOf(p) === "hype") continue;
    if (actedOn(p, committed)) continue;

    const buyer = p.author.trim();
    if (!buyer) continue;
    const held = best.get(buyer);
    best.set(buyer, {
      pick: held ? better(held.pick, p) : p,
      asked: (held?.asked ?? 0) + 1,
    });
  }

  return [...best.entries()]
    .map(([buyer, { pick, asked }]) => ({
      buyer,
      question: pick.question.trim(),
      messageId: pick.messageId,
      intent: intentOf(pick),
      askedAt: pick.at,
      asked,
    }))
    .sort((a, b) => {
      const worth = (f: FollowUp) => INTENT_WORTH[f.intent] ?? 1;
      return worth(b) - worth(a) || a.askedAt.localeCompare(b.askedAt);
    });
}
