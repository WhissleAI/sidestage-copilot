// What grounds an answer on a channel that sells nothing.
//
// On eBay Live the question "is this true?" has one answer: the catalog. A
// Twitch chat asks about three other things entirely, and each of them is
// written down by a human somewhere:
//
//   THE SCHEDULE — "when's the next one", asked forty times a stream, and the
//     host answers it forty times instead of playing.
//   THE SPONSOR — the segment that pays for the stream comes with a document
//     saying what must be said and what must never be claimed. Improvising
//     around it is not a bad reply, it is a breached contract.
//   THE CHANNEL'S RULES — what chat is allowed to be told. The host's rules,
//     not ours.
//
// The `CorpusKind` on each fact is what makes the existing guards work here
// without knowing Twitch exists: `sponsorGuard` looks for `sponsor`,
// `communityRuleGuard` looks for `community`, and the listing guards find no
// `listing` corpus on this surface and return n/a on their own.
//
// One decision worth defending. A sponsor's "do not claim X" list is emitted
// TWICE: once inside the sponsor brief, where it is the obligation in full, and
// once per prohibition as a `community` fact phrased as a rule. That is not
// duplication for its own sake — `sponsorGuard` only checks that a sponsored
// claim CITES an approved fact, so a draft that cites the brief correctly and
// then says the board is waterproof passes it. The prohibition has to reach
// `communityRuleGuard` to be enforced at all, and `community` is the corpus
// whose whole definition is "a constraint on the reply, never an answer in
// it". The label names the sponsor, so "says who" still answers correctly.
//
// Where these come from: an operator writes them, the way a catalog is written
// today (`fixtures/catalogs/*.json`). Feeding them into the retriever alongside
// listing facts is Wave C — this file's job is to produce the facts and to put
// the right kind on each one.

import type { Fact, FactField } from "../../retrieval/facts.js";
import type { CorpusKind } from "../../retrieval/corpus.js";
import type { EvidenceSource } from "../../domain/types.js";
import { ngramVector, terms } from "../../retrieval/text.js";

export interface ScheduleSegment {
  /** When, in the channel's own words: "Thursdays 7pm PT", or a date. The
   *  copilot quotes this back verbatim rather than computing a time — a
   *  timezone arithmetic bug in a chat reply is worse than the raw string. */
  when: string;
  title: string;
  game?: string;
  note?: string;
}

export interface SponsorObligation {
  /** Who is paying. Appears in the label, so it is answerable from the card. */
  sponsor: string;
  /** What is being sponsored. This is the word the guard matches a draft
   *  against, so it must be the name chat would actually use. */
  product: string;
  /** Said at least once during the segment. */
  mustSay: string[];
  /** Never said, in any words. Emitted as prohibitions — see the note above. */
  mustNotClaim: string[];
  /** Claims the sponsor has approved. A draft about the product cites one of
   *  these; anything else is improvisation `sponsorGuard` blocks. */
  approvedClaims: string[];
  runsUntil?: string;
}

export interface ChannelCorpus {
  channel: string;
  schedule?: ScheduleSegment[];
  sponsors?: SponsorObligation[];
  /** The channel's chat rules, as the broadcaster wrote them. */
  rules?: string[];
  /** Anything else the host has committed to in writing: a setup list, a FAQ,
   *  the specs of the thing they build on stream. */
  product?: { label: string; text: string }[];
}

/**
 * Turn one channel's written-down truth into facts.
 *
 * Ids are stable and readable, because a guard's refusal quotes one at the
 * operator and "sponsor:keychron-q1#claim2" has to be findable by hand.
 */
export function twitchFacts(c: ChannelCorpus): Fact[] {
  const channel = c.channel.replace(/^[#@]/, "").toLowerCase();
  const out: Fact[] = [];

  (c.schedule ?? []).forEach((s, n) => {
    const game = s.game ? ` (${s.game})` : "";
    const note = s.note ? ` ${s.note}` : "";
    out.push(
      fact({
        factId: `schedule:${channel}#${n + 1}`,
        corpus: "schedule",
        source: "catalog",
        label: `Schedule · ${s.when}`,
        text: `${s.when} — ${s.title}${game}.${note}`.trim(),
        field: "description",
      }),
    );
  });

  for (const s of c.sponsors ?? []) {
    const slug = slugify(s.product);
    // The label carries the product name on EVERY sponsor fact, because that is
    // where `sponsorGuard` looks for the subject of the sponsorship. A brief
    // labelled "Sponsor · segment 2" would leave the guard with nothing to
    // match a draft against and it would allow silently.
    const label = `Sponsor · ${s.product}`;
    const until = s.runsUntil ? ` Runs until ${s.runsUntil}.` : "";
    out.push(
      fact({
        factId: `sponsor:${slug}#brief`,
        corpus: "sponsor",
        source: "catalog",
        label,
        text:
          `${s.sponsor} sponsors this segment about the ${s.product}. ` +
          `Must be said: ${s.mustSay.join("; ") || "nothing specific"}. ` +
          `Must not be claimed: ${s.mustNotClaim.join("; ") || "nothing specific"}.${until}`,
        field: "description",
      }),
    );

    s.approvedClaims.forEach((claim, n) => {
      out.push(
        fact({
          factId: `sponsor:${slug}#claim${n + 1}`,
          corpus: "sponsor",
          source: "catalog",
          label,
          text: claim,
          field: "description",
        }),
      );
    });

    s.mustSay.forEach((line, n) => {
      out.push(
        fact({
          factId: `sponsor:${slug}#must${n + 1}`,
          corpus: "sponsor",
          source: "catalog",
          label,
          text: `The segment must say: ${line}`,
          field: "description",
        }),
      );
    });

    s.mustNotClaim.forEach((claim, n) => {
      out.push(
        fact({
          factId: `sponsor:${slug}#never${n + 1}`,
          corpus: "community",
          source: "policy",
          label: `${s.sponsor} sponsor terms`,
          // Quoted, because `communityRuleGuard` matches a quoted phrase in a
          // rule verbatim. An unquoted prohibition falls back to head-term
          // matching, which is looser than a sponsor's language deserves.
          text: `Do not claim "${claim}" about the ${s.product}.`,
          field: "prohibited",
        }),
      );
    });
  }

  (c.rules ?? []).forEach((rule, n) => {
    out.push(
      fact({
        factId: `community:${channel}#${n + 1}`,
        corpus: "community",
        source: "policy",
        label: `#${channel} chat rule ${n + 1}`,
        text: rule,
        field: "prohibited",
      }),
    );
  });

  (c.product ?? []).forEach((p, n) => {
    out.push(
      fact({
        factId: `product:${channel}#${n + 1}`,
        corpus: "product",
        source: "catalog",
        label: p.label,
        text: p.text,
        field: "description",
      }),
    );
  });

  return out;
}

/** The rules in force on this channel, for `GuardInput.community`. A caller
 *  must not pass the whole set: a community fact is a constraint, and handing
 *  the composer one as evidence is how a rule gets quoted back as an answer. */
export const rulesOf = (facts: Fact[]): Fact[] => facts.filter((f) => f.corpus === "community");

/** What may ground a claim — everything that is not a constraint. */
export const groundingOf = (facts: Fact[]): Fact[] => facts.filter((f) => f.corpus !== "community");

/**
 * Read an operator-authored channel file, keeping only what is actually there.
 *
 * Tolerant on purpose: a sponsor brief with no `mustNotClaim` is a brief that
 * forbids nothing, not a parse error, and refusing the whole file over one
 * missing array would take a channel's schedule offline too.
 */
export function parseChannelCorpus(raw: unknown): ChannelCorpus | null {
  const o = raw as Partial<ChannelCorpus> | null;
  if (!o || typeof o.channel !== "string" || !o.channel.trim()) return null;
  return {
    channel: o.channel.trim(),
    schedule: (o.schedule ?? []).filter((s) => s && s.when && s.title).map((s) => ({
      when: String(s.when), title: String(s.title),
      ...(s.game ? { game: String(s.game) } : {}),
      ...(s.note ? { note: String(s.note) } : {}),
    })),
    sponsors: (o.sponsors ?? []).filter((s) => s && s.product).map((s) => ({
      sponsor: String(s.sponsor || s.product),
      product: String(s.product),
      mustSay: strings(s.mustSay),
      mustNotClaim: strings(s.mustNotClaim),
      approvedClaims: strings(s.approvedClaims),
      ...(s.runsUntil ? { runsUntil: String(s.runsUntil) } : {}),
    })),
    rules: strings(o.rules),
    product: (o.product ?? []).filter((p) => p && p.label && p.text).map((p) => ({
      label: String(p.label), text: String(p.text),
    })),
  };
}

function fact(f: {
  factId: string; corpus: CorpusKind; source: EvidenceSource;
  label: string; text: string; field: FactField;
}): Fact {
  const indexable = `${f.label} ${f.text}`;
  return { ...f, tokens: terms(indexable), vector: ngramVector(indexable) };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sponsor";
