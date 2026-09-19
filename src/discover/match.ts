// Which interests a thing matches, where, and therefore how far up it goes.
//
// The ranking is deliberately small and legible, because it is shown. A hit
// carries its `why` into the interface as the matched terms, so the operator
// can see the reason a card is in front of them and disagree with it by editing
// a chip. That rules out the usual answer — an embedding similarity, a blended
// score — not because it would rank worse but because it cannot be said out
// loud. "0.82" is not a reason.
//
// So: count DISTINCT interests matched, weight them by where the match landed,
// and break ties on the surface's own signal (an audience, when it gave us
// one). Title beats category beats body, which is just the observation that a
// show called "Pokémon Vintage Rips" is about Pokémon and a show filed under
// Trading Card Games might be.

import { slugify } from "./interests.js";
import type { DiscoverHit, MatchWhere, Why } from "./types.js";

/** How much a match is worth, by where it landed. */
const WHERE_WEIGHT: Record<MatchWhere, number> = {
  title: 4,
  host: 3,
  room: 3,
  category: 2,
  body: 1,
};

/** One field of a candidate, with the provenance a match in it would carry. */
export interface Field {
  text: string | null | undefined;
  where: MatchWhere;
}

/**
 * Does `slug` occur in `haystack` as a whole word (or whole phrase)?
 *
 * Substring matching is wrong here in a way that is easy to miss until it is
 * in front of a seller: "ps5" inside "ps500", "rae" inside "israel". Both
 * sides are already slugged — lowercase, unaccented, single-spaced — so a
 * space-delimited boundary check is exact and costs nothing.
 */
export function mentions(haystack: string, slug: string): boolean {
  if (!haystack || !slug) return false;
  const h = ` ${haystack} `;
  if (h.includes(` ${slug} `)) return true;
  // A plural, and only a plural: "sneakers" answers "sneaker". Anything looser
  // starts matching prefixes, which is how "card" claims "cardigan".
  return h.includes(` ${slug}s `) || (slug.endsWith("s") && h.includes(` ${slug.slice(0, -1)} `));
}

/**
 * Every interest this candidate matches, with where.
 *
 * One entry per (term, where) at most, best `where` first — a term in both the
 * title and the category is one reason, reported at its strongest, because a
 * card listing the same word twice reads as padding.
 */
export function whyFor(
  fields: Field[],
  interests: { slug: string; term: string }[],
): Why[] {
  const best = new Map<string, { term: string; where: MatchWhere }>();
  const slugged = fields.map((f) => ({ where: f.where, text: slugify(f.text ?? "") }));
  for (const i of interests) {
    for (const f of slugged) {
      if (!mentions(f.text, i.slug)) continue;
      const current = best.get(i.slug);
      if (!current || WHERE_WEIGHT[f.where] > WHERE_WEIGHT[current.where]) {
        best.set(i.slug, { term: i.term, where: f.where });
      }
    }
  }
  return [...best.values()].sort((a, b) => WHERE_WEIGHT[b.where] - WHERE_WEIGHT[a.where]);
}

/** What a hit is worth: distinct interests, each weighted by where it landed. */
export function scoreOf(why: Why[]): number {
  return why.reduce((n, w) => n + WHERE_WEIGHT[w.where], 0);
}

/**
 * The honesty rule, applied.
 *
 * Every hit carries at least one `why` — so anything that matched nothing is
 * dropped, not shown with an empty explanation. `all` is the single exception
 * and it exists for one question only ("show me everything live on this
 * surface"), which a caller has to ask for by name.
 */
export function rank(
  hits: DiscoverHit[],
  opts: { all: boolean; limit: number },
): DiscoverHit[] {
  const kept = opts.all ? hits : hits.filter((h) => h.why.length > 0);
  return kept
    .sort((a, b) =>
      scoreOf(b.why) - scoreOf(a.why) ||
      b.why.length - a.why.length ||
      // A surface that counts its audience gets to break the tie with it; one
      // that does not leaves every hit equal here rather than inventing a zero.
      (b.viewers ?? -1) - (a.viewers ?? -1) ||
      a.title.localeCompare(b.title))
    .slice(0, opts.limit);
}
