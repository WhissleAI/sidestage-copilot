// One definition per named figure, and nowhere else.
//
// "Answered rate" was four computations under one label. The report stored
// `sent ÷ questions asked`; the live console agreed; Analytics' headline
// computed `answered ÷ questions asked`; and the per-show table two rows below
// the headline passed the report's own figure straight through. Both were
// rendered against the same `target >85%`, so one session read 90% at the top
// of Analytics and 20% in its own row of the table underneath. "Block rate" had
// the same shape of problem with two denominators.
//
// The cause was not a bad call site. It was that a figure with a NAME had no
// single place that owned it, so every surface that needed one wrote the
// quotient it happened to have the numbers for. This module is that place: one
// exported function per named figure, taking the counts it divides, so the
// report, the console, the PRD block and the analytics aggregator cannot drift.
// Adding a fifth consumer means calling a function, not writing a division.
//
// ── unknown is null, never zero ────────────────────────────────────────────
//
// A rate with an empty denominator is not 0%, it is a measurement nobody made,
// and rendering it as zero is how "we answered nothing" and "nobody asked" ended
// up looking identical on a dashboard with a target beside them. Every function
// here returns `null` for that case and every consumer carries the null through.
//
// ── pooling ────────────────────────────────────────────────────────────────
//
// An aggregate over many sessions is the SAME function over summed counts —
// never the mean of per-session rates, which weights a two-proposal session the
// same as a two-hundred-proposal one. Analytics sums the numerators and the
// denominators off the stored reports and calls these, which is why its headline
// and a row in its own table now agree by construction.

/** Rates are stored and compared at three decimal places, so a figure written
 *  by one consumer is `===` to the same figure computed by another. */
const round3 = (n: number): number => Number(n.toFixed(3));

/**
 * Answered rate — docs/PRD.md §4.
 *
 * Replies the seller actually SENT, over the questions the gate admitted. Not
 * "drafts the copilot could stand behind": a draft nobody sent never reached
 * the buyer who asked, and the PRD's row is about the buyer.
 *
 * Null when no question was admitted.
 */
export function answeredRate(i: { sent: number; questionsAsked: number }): number | null {
  return i.questionsAsked > 0 ? round3(i.sent / i.questionsAsked) : null;
}

/**
 * Block rate — docs/PRD.md §4, target <2%.
 *
 * Drafts a guard refused, over the drafts that reached a verdict at all
 * (`answered + blocked`). An ABSTENTION is not in the denominator: the catalog
 * had nothing to say, so there was never a draft for a guard to stop, and
 * counting those made a session that abstained a lot look safer than it was.
 *
 * `answered` is the report's own definition — a proposal that neither abstained
 * nor was blocked — so this is computable from any stored report, including
 * every one written before this module existed. That is deliberate: a
 * definition the history cannot be re-read under is a definition that only
 * applies going forward.
 *
 * Null when nothing reached a verdict.
 */
export function blockRate(i: { blocked: number; answered: number }): number | null {
  const denom = i.answered + i.blocked;
  return denom > 0 ? round3(i.blocked / denom) : null;
}

/**
 * The share of proposals on one topic the copilot could stand behind.
 *
 * A DIFFERENT figure from `answeredRate`, over a different population, and it
 * keeps its own name to stop the two being read as the same thing: the topic
 * table counts proposals (a comment the gate dropped never got a topic), and it
 * asks whether the copilot had an answer, not whether the seller sent one.
 *
 * Null when nothing was proposed on the topic.
 */
export function answerableShare(i: { answered: number; proposals: number }): number | null {
  return i.proposals > 0 ? round3(i.answered / i.proposals) : null;
}

/** A plain share, for the rates that are one count over another and have no
 *  argument about the denominator. Null on an empty denominator, like the rest. */
export function share(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round3(numerator / denominator) : null;
}

/**
 * How long a session ran, in minutes.
 *
 * From the moment it STOPPED, not from the moment somebody asked for a report.
 * The two were the same expression — `Date.now()` at report time — which meant
 * a console left attached after a show was over inflated "hours on air", and the
 * PRD's headline GMV-per-hour was divided by that inflated figure. `ended_at`
 * is written when the session stops (migration 024); a session still live has
 * no end yet, and `now` is the honest stand-in for the one caller that asks
 * about a show in progress.
 */
export function durationMin(startedAt: string | Date, endedAt: string | Date | null): number {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 60_000));
}

/** The same span in hours, undivided — the denominator of every per-hour rate. */
export function durationHours(startedAt: string | Date, endedAt: string | Date | null): number {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, (end - start) / 3_600_000);
}
