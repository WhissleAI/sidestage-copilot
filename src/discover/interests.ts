// What the operator sells around — derived from Knowledge, then owned by them.
//
// Discovery on every surface asks one question: *given what this operator
// sells, what is worth their attention right now, and why?* An interest is the
// unit that question is asked in, and everything else in this directory is
// downstream of it.
//
// Two halves, deliberately separated.
//
//   `deriveInterests` is PURE. Catalog items in, ranked terms out, no database,
//   no network, no account. That is what lets the derivation rules — which are
//   opinionated and will be argued with — be tested against a real catalog in
//   microseconds rather than against a seeded Postgres.
//
//   `InterestStore` owns the persistence, and it carries the one rule that is
//   not obvious: **a derived term the operator deletes stays deleted.** Not
//   "until the next import" — permanently, as a tombstone. An operator who
//   removes "Chrome" because it means the Topps set and not the browser, and
//   then finds it back tomorrow because a nightly import re-derived it, has
//   learned that the chips are decoration. So a removal writes a row rather
//   than deleting one, and derivation skips any slug that carries it.
//
// Never invent an interest. An account with no catalog has no derived terms and
// Discover says so, pointing at Knowledge — a grid of strangers selling things
// this operator does not touch is a phone book with a search box on it.

import type { Pool } from "../db/pg.js";
import type { CatalogItem } from "../shows/catalogImport.js";

/** One term, as the operator sees it. */
export interface Interest {
  /** Matching identity: lowercase, unaccented, single-spaced. */
  slug: string;
  /** Display form — whichever spelling the catalog or the operator used. */
  term: string;
  origin: "derived" | "own";
  pinned: boolean;
  /** Listings carrying it. Zero on a term the operator typed themselves. */
  weight: number;
}

// ── deriving ─────────────────────────────────────────────────────────────────

/**
 * Words that are never what somebody sells.
 *
 * Kept SHORT on purpose. Every entry here is a term an operator can no longer
 * discover around, so the list holds grammar and packaging noise and stops
 * there. "Vintage", "graded", "sealed" and "retro" are not on it: they are
 * exactly the words a collector searches, and a list that quietly swallowed
 * them would make the chips duller than the catalog.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "the", "or", "of", "for", "with", "without", "in", "on", "at", "to", "by",
  "from", "as", "is", "are", "was", "be", "it", "its", "this", "that", "these", "those",
  "your", "our", "my", "you", "we", "all", "any", "more", "most", "very", "only", "not",
  "new", "used", "item", "items", "lot", "lots", "set", "sets", "pack", "packs", "piece",
  "size", "sizes", "color", "colour", "colors", "colours", "free", "ship", "ships",
  "shipping", "sale", "sold", "buy", "bid", "price", "priced", "each", "per", "plus",
  "mint", "nwt", "nib", "oem", "genuine", "authentic", "original", "brand",
  // Bare colour words, and ONLY bare ones. Nobody sells "black"; plenty of
  // people sell a Black Label or a Chicago colorway, and those survive as
  // phrases. This is the one place the list goes beyond grammar, and it earns
  // it: "Black" was coming out as a top-three chip on a sneaker catalog where
  // the operator sells Jordans.
  "black", "white", "grey", "gray", "red", "blue", "green", "pink", "brown",
  "yellow", "orange", "purple", "multicolor", "multicolour",
]);

/** Fold a term to its matching identity. Accents, punctuation and case are not
 *  decisions about what something is: "Pokémon" and "pokemon" are one interest,
 *  and a card must not fall out of the list over a diacritic. */
export function slugify(raw: string): string {
  return (raw || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // Emoji, box-drawing, quotes, slashes and every other separator become one
    // space. Live-commerce titles are full of them.
    .replace(/[^\p{Letter}\p{Number}+&'-]+/gu, " ")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Is this token worth being a term on its own? */
function meaningful(tok: string): boolean {
  if (tok.length < 3) return false;              // single characters and "og", "rc"
  if (STOPWORDS.has(tok)) return false;
  if (/^\d+$/.test(tok)) return false;            // a year or a card number is not a thing you sell
  if (/^\d+(st|nd|rd|th)$/.test(tok)) return false;
  return true;
}

/** Everything one item says about itself, as text with a provenance. */
function phrasesOf(item: DerivationItem): { text: string; where: "title" | "category" }[] {
  const out: { text: string; where: "title" | "category" }[] = [];
  if (item.title) out.push({ text: item.title, where: "title" });
  // eBay's own structured fields. The import folds a listing's aspects into
  // these (ingest/ebay/import.ts), so "Brand: Topps" arrives here as `brand`,
  // and a category name arrives whenever the source had one.
  for (const v of [item.brand, item.model, item.categoryName, ...(item.aspects ?? [])]) {
    if (v && v.trim()) out.push({ text: v, where: "category" });
  }
  return out;
}

/** What derivation reads. A superset of `CatalogItem`'s useful half, plus the
 *  two fields an eBay-sourced catalog can carry and a hand-written one cannot. */
export interface DerivationItem {
  title?: string;
  brand?: string;
  model?: string;
  /** eBay's leaf category name, where the source recorded one. */
  categoryName?: string;
  /** Any other aspect values worth treating as whole phrases. */
  aspects?: string[];
}

export interface DerivedTerm {
  slug: string;
  term: string;
  /** Distinct LISTINGS carrying it — not occurrences. A title that says
   *  "Jordan" three times is one listing that sells Jordans. */
  weight: number;
}

/**
 * Candidate interests, ranked, from a catalog.
 *
 * Unigrams and bigrams off the titles, whole values off the structured fields.
 * Three rules do most of the work:
 *
 *  1. **Count listings, not words.** The question is "how much of my inventory
 *     is this", and a term that appears eleven times in one listing's title is
 *     answering a different one.
 *  2. **A phrase beats its parts.** "Air Jordan" and "Jordan" carry the same
 *     listings in a sneaker catalog, and the longer one is the one a person
 *     would type. The unigram is dropped when it never occurs outside the
 *     bigram; kept when it does, because then it genuinely means more.
 *  3. **Two listings, on a catalog big enough to have two.** One listing
 *     mentioning something is an anecdote, and a chip per listing is not a set
 *     of interests, it is the catalog again. A small catalog has no room for
 *     that rule and keeps everything.
 */
export function deriveInterests(items: DerivationItem[], opts: { limit?: number } = {}): DerivedTerm[] {
  const limit = opts.limit ?? 12;
  if (!items.length) return [];

  /** slug → listings carrying it, and the spellings seen. */
  const seen = new Map<string, { listings: Set<number>; spellings: Map<string, number>; words: number }>();
  const note = (slug: string, display: string, index: number) => {
    if (!slug) return;
    const words = slug.split(" ").length;
    const row = seen.get(slug) ?? { listings: new Set<number>(), spellings: new Map<string, number>(), words };
    row.listings.add(index);
    row.spellings.set(display, (row.spellings.get(display) ?? 0) + 1);
    seen.set(slug, row);
  };

  for (const [i, item] of items.entries()) {
    for (const { text, where } of phrasesOf(item)) {
      const slug = slugify(text);
      if (!slug) continue;
      const tokens = slug.split(" ");
      const display = text.trim().replace(/\s+/g, " ");

      if (where === "category") {
        // A structured value is already the name of a thing. "New Balance",
        // "Topps Chrome", "Trading Card Games" — splitting those into words
        // would turn a category into vocabulary.
        const clean = tokens.filter((t) => !STOPWORDS.has(t)).join(" ");
        if (clean && clean.length >= 3 && !/^\d+$/.test(clean)) note(clean, display, i);
        continue;
      }

      // Slug tokens and the operator's own spelling of each, side by side, so
      // a chip reads "Pokémon" and matches "pokemon". Losing the spelling here
      // would make every derived chip lowercase and unaccented, which is the
      // catalog written in a voice the seller does not use.
      const kept: { t: string; d: string; ok: boolean }[] = [];
      for (const word of display.split(/\s+/)) {
        const parts = slugify(word).split(" ").filter(Boolean);
        if (parts.length === 1) {
          // Strip the emoji and punctuation a live-commerce title wraps words
          // in — "🐲GREEN" is the word GREEN — without touching the inside.
          const bare = word.replace(/^[^\p{Letter}\p{Number}]+|[^\p{Letter}\p{Number}]+$/gu, "");
          kept.push({ t: parts[0]!, d: bare || parts[0]!, ok: meaningful(parts[0]!) });
        } else {
          for (const p of parts) kept.push({ t: p, d: p, ok: meaningful(p) });
        }
      }
      for (let j = 0; j + 1 < kept.length; j++) {
        const a = kept[j]!, b = kept[j + 1]!;
        if (a.ok && b.ok) note(`${a.t} ${b.t}`, `${a.d} ${b.d}`, i);
      }
      for (const { t, d, ok } of kept) if (ok) note(t, d, i);
    }
  }

  const minWeight = items.length >= 4 ? 2 : 1;
  const rows: DerivedTerm[] = [];
  for (const [slug, row] of seen) {
    const weight = row.listings.size;
    if (weight < minWeight) continue;
    // Rule 2, as subsumption: a word is the phrase's shadow when a phrase
    // containing it covers at least as many listings — "jordan" over four
    // listings all of which say "air jordan" adds nothing to "air jordan".
    // When the word covers MORE, it genuinely means more and keeps its chip.
    if (row.words === 1) {
      let shadowed = false;
      for (const [other, o] of seen) {
        if (o.words < 2 || o.listings.size < weight) continue;
        if (` ${other} `.includes(` ${slug} `)) { shadowed = true; break; }
      }
      if (shadowed) continue;
    }
    // The spelling the catalog used most, so a chip reads the way the
    // operator's own listings read — "Pokémon", not "pokemon".
    const term = [...row.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    rows.push({ slug, term, weight });
  }

  return rows
    .sort((a, b) =>
      b.weight - a.weight ||
      b.slug.split(" ").length - a.slug.split(" ").length ||
      a.slug.localeCompare(b.slug))
    .slice(0, limit);
}

/** `CatalogItem` as derivation wants to read it. */
export const itemForDerivation = (i: CatalogItem): DerivationItem => ({
  title: i.title,
  ...(i.brand ? { brand: i.brand } : {}),
  ...(i.model ? { model: i.model } : {}),
});

// ── owning ───────────────────────────────────────────────────────────────────

interface Row {
  slug: string; term: string; origin: string; pinned: boolean; deleted: boolean; weight: number;
}

/**
 * The account's own set, and the tombstones that keep a removal a removal.
 *
 * Every method is scoped by `accountId` in the statement itself rather than by
 * a caller remembering to filter — the same posture `Repo` takes toward
 * `show_id`, and for the same reason: one operator's interests must never be
 * able to reach another's Discover page.
 */
export class InterestStore {
  constructor(private readonly d: Pool) {}

  /** This account's live interests, best first. */
  async list(accountId: string): Promise<Interest[]> {
    const { rows } = await this.d.query<Row>(
      `SELECT slug, term, origin, pinned, deleted, weight
         FROM discover_interests
        WHERE account_id = $1 AND NOT deleted
        ORDER BY pinned DESC, weight DESC, term ASC`,
      [accountId],
    );
    return rows.map(toInterest);
  }

  /** Slugs this account has removed. Derivation must never resurrect them. */
  async tombstones(accountId: string): Promise<Set<string>> {
    const { rows } = await this.d.query<{ slug: string }>(
      "SELECT slug FROM discover_interests WHERE account_id = $1 AND deleted",
      [accountId],
    );
    return new Set(rows.map((r) => r.slug));
  }

  /**
   * Fold a fresh derivation into the account's set.
   *
   * Additive and weight-updating, never destructive: a term the operator typed
   * keeps its `origin` and its pin, a term they deleted stays deleted, and a
   * derived term whose weight moved is updated in place so the chip's
   * explanation stays true after an import.
   */
  async absorb(accountId: string, derived: DerivedTerm[]): Promise<void> {
    if (!derived.length) return;
    const dead = await this.tombstones(accountId);
    const live = derived.filter((d) => !dead.has(d.slug));
    if (!live.length) return;
    await this.d.query(
      `INSERT INTO discover_interests (account_id, slug, term, origin, weight)
       SELECT $1, s.slug, s.term, 'derived', s.weight
         FROM unnest($2::text[], $3::text[], $4::int[]) AS s(slug, term, weight)
       ON CONFLICT (account_id, slug) DO UPDATE
          SET weight = EXCLUDED.weight,
              -- A term the operator adopted stays theirs; only the count moves.
              term = CASE WHEN discover_interests.origin = 'own'
                          THEN discover_interests.term ELSE EXCLUDED.term END`,
      [accountId, live.map((d) => d.slug), live.map((d) => d.term), live.map((d) => d.weight)],
    );
  }

  /** Add or re-add a term the operator typed. Clears its tombstone: asking for
   *  it back by name is a decision, where a re-derivation is not. */
  async add(accountId: string, term: string, pinned = false): Promise<Interest | null> {
    const slug = slugify(term);
    if (!slug || slug.length < 2) return null;
    const { rows } = await this.d.query<Row>(
      `INSERT INTO discover_interests (account_id, slug, term, origin, pinned, deleted, weight)
       VALUES ($1, $2, $3, 'own', $4, FALSE, 0)
       ON CONFLICT (account_id, slug) DO UPDATE
          SET term = EXCLUDED.term, origin = 'own', pinned = EXCLUDED.pinned, deleted = FALSE
       RETURNING slug, term, origin, pinned, deleted, weight`,
      [accountId, slug, term.trim().slice(0, 60), pinned],
    );
    return rows[0] ? toInterest(rows[0]) : null;
  }

  /**
   * Remove a term. A TOMBSTONE, not a delete.
   *
   * The row survives so the next catalog import can see that this account has
   * already answered the question about this term. Removing the row instead
   * would make every import a small argument with the operator.
   */
  async remove(accountId: string, term: string): Promise<boolean> {
    const slug = slugify(term);
    const res = await this.d.query(
      `INSERT INTO discover_interests (account_id, slug, term, origin, deleted)
       VALUES ($1, $2, $3, 'derived', TRUE)
       ON CONFLICT (account_id, slug) DO UPDATE SET deleted = TRUE, pinned = FALSE`,
      [accountId, slug, term.trim().slice(0, 60)],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async pin(accountId: string, term: string, pinned: boolean): Promise<void> {
    await this.d.query(
      "UPDATE discover_interests SET pinned = $3 WHERE account_id = $1 AND slug = $2",
      [accountId, slugify(term), pinned],
    );
  }

  /**
   * Replace the operator's set with exactly this list.
   *
   * What `PUT /api/discover/interests` means. Anything they dropped becomes a
   * tombstone (so an import cannot undo the edit), anything they kept or added
   * becomes theirs. Done in one transaction-free pass of two statements because
   * the second is idempotent and a half-applied edit leaves the set readable.
   */
  async replace(accountId: string, terms: { term: string; pinned?: boolean }[]): Promise<Interest[]> {
    const wanted = new Map<string, { term: string; pinned: boolean }>();
    for (const t of terms) {
      const slug = slugify(t.term);
      if (!slug || slug.length < 2) continue;
      wanted.set(slug, { term: t.term.trim().slice(0, 60), pinned: Boolean(t.pinned) });
    }
    // Everything currently live that is not in the new list is a removal.
    await this.d.query(
      `UPDATE discover_interests SET deleted = TRUE, pinned = FALSE
        WHERE account_id = $1 AND NOT deleted AND NOT (slug = ANY($2::text[]))`,
      [accountId, [...wanted.keys()]],
    );
    if (wanted.size) {
      const slugs = [...wanted.keys()];
      await this.d.query(
        `INSERT INTO discover_interests (account_id, slug, term, origin, pinned, deleted, weight)
         SELECT $1, s.slug, s.term, 'own', s.pinned, FALSE, 0
           FROM unnest($2::text[], $3::text[], $4::boolean[]) AS s(slug, term, pinned)
         ON CONFLICT (account_id, slug) DO UPDATE
            SET term = EXCLUDED.term, pinned = EXCLUDED.pinned, deleted = FALSE`,
        [accountId, slugs, slugs.map((s) => wanted.get(s)!.term), slugs.map((s) => wanted.get(s)!.pinned)],
      );
    }
    return this.list(accountId);
  }
}

const toInterest = (r: Row): Interest => ({
  slug: r.slug,
  term: r.term,
  origin: r.origin === "own" ? "own" : "derived",
  pinned: r.pinned,
  weight: r.weight,
});
