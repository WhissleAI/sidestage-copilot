// The voice corpus: what this operator has actually written, and the one past
// answer worth showing the model before it writes the next one.
//
// Two rules hold the whole idea up, and they pull in opposite directions:
//
//   • A style reference is CITED, the way a fact is. The console says "written
//     the way you answered this in March" and links the past reply, because an
//     operator who cannot see which of their own sentences shaped the draft has
//     no way to tell a voice match from a hallucination that happens to sound
//     like them.
//   • A style reference is NEVER grounding. It is old text about a different
//     item on a different day. It says HOW to speak and nothing about what is
//     true now, so it is deliberately kept OUT of the grounding fact list the
//     model cites from: a claim carried in on a style reference would be a
//     claim with a provenance chip and no live source behind it, which is the
//     one failure the chips cannot catch.
//
// Similarity is the retriever's, not a second implementation. `styleRef` builds
// a BM25 index over the corpus and fuses it with the same char-trigram cosine
// and the same RRF constant `Retriever.fuse` uses — a corpus ranked by a second
// notion of "similar" would be one more thing that can silently disagree with
// the rest of retrieval.

import { createHash } from "node:crypto";
import type { Pool } from "../db/pg.js";
import type { Fact } from "../retrieval/facts.js";
import { Bm25Index } from "../retrieval/bm25.js";
import { RRF_K } from "../retrieval/retriever.js";
import { cosine, ngramVector, terms } from "../retrieval/text.js";

/** How much history one `learn` walks. A busy seller's account holds tens of
 *  thousands of sent replies and the newest few hundred already describe how
 *  they write; the rest is corpus size bought at no gain in resemblance. */
const LEARN_LIMIT = 400;
/** Shorter than this is "yep" and "thanks!" — true to the voice and useless as
 *  a model of it. */
const MIN_DOC_CHARS = 25;

/**
 * Floors below which there is no style reference at all.
 *
 * A style reference is only worth showing when the operator answered something
 * genuinely LIKE this before. Handing over the nearest of five unrelated
 * replies teaches the model the wrong rhythm with full confidence, and — worse
 * — puts "written the way you answered this in March" under a draft that has
 * nothing to do with March. Absent is a better answer than nearest.
 *
 * Two floors because the two legs catch different resemblances: BM25 catches
 * shared content words, the trigram cosine catches shared shape (a typo, a
 * run-together brand). Clearing either is evidence; clearing neither is not.
 *
 * The numbers are measured, not chosen. Over a three-document corpus of real
 * replies, a genuinely similar question scored BM25 2.25 / cosine 0.39-0.44 and
 * an unrelated one scored BM25 0 / cosine 0.03-0.18 — the gap is wide and these
 * sit in it.
 */
const STYLE_BM25_FLOOR = 2.0;
const STYLE_NGRAM_FLOOR = 0.25;

export interface VoiceDoc {
  docId: string;
  question: string;
  text: string;
  origin: "sent" | "pasted";
  showId: string | null;
  showTitle: string | null;
  at: string;
}

export interface LearnReport {
  /** How many documents the corpus holds for this account afterwards. */
  total: number;
  /** How many this call wrote — re-learning the same history writes the same
   *  rows, so a second press reports the same number, not double. */
  indexed: number;
  /** Which shows the operator's own words came out of. */
  shows: { showId: string; title: string; count: number }[];
  pasted: number;
}

/** A style reference as it reaches the draft and the console. */
export interface StyleRef {
  factId: string;
  text: string;
  /** "Your own words · March 2026" — what the console renders beside the draft. */
  label: string;
}

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "earlier" : d.toLocaleString("en-US", { month: "long", year: "numeric" });
};

/** One past answer as a fact.
 *
 *  Indexed on the QUESTION as well as the answer, because the thing being
 *  matched is "what was I asked that was like this", not "which of my answers
 *  contains these words" — a past reply about shipping resembles a shipping
 *  question through the question it answered, and often shares no vocabulary
 *  with it at all. */
export function voiceFact(doc: VoiceDoc): Fact {
  const indexable = `${doc.question} ${doc.text}`;
  return {
    factId: `persona:${doc.docId}`,
    source: "persona",
    corpus: "qa",
    label: `Your own words · ${when(doc.at)}`,
    text: doc.text,
    field: "qa",
    tokens: terms(indexable),
    vector: ngramVector(indexable),
  };
}

const digest = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 16);

export class VoiceCorpus {
  constructor(private d: Pool) {}

  /**
   * Index the operator's own past sends, plus anything they pasted.
   *
   * "Their own" is scoped by `shows.owner_account_id`, bound into the statement
   * the way `Repo` binds a show id — a voice corpus that leaked one seller's
   * replies into another's persona would not merely be a tenancy bug, it would
   * make the copilot write in a stranger's voice and cite it as the operator's.
   *
   * `sent` and `auto_sent` both count, and the reason is worth stating plainly:
   * the corpus is text the operator STOOD BEHIND, not text they typed. A draft
   * they read and sent unedited is a sentence they were willing to have said in
   * their name, which is exactly the standard a voice model wants. Restricting
   * it to edited sends would be more literal and would leave most accounts with
   * a corpus of four rows.
   */
  async learn(accountId: string, opts: { paste?: string[] } = {}): Promise<LearnReport> {
    const { rows } = await this.d.query<{
      show_id: string; title: string | null; id: string;
      question: string; sent_text: string; at: string;
    }>(
      `SELECT p.show_id, s.title, p.id, p.question, p.sent_text, p.at
         FROM reply_proposals p
         JOIN shows s ON s.id = p.show_id
        WHERE s.owner_account_id = $1
          AND p.status IN ('sent', 'auto_sent')
          AND p.sent_text IS NOT NULL
          AND length(btrim(p.sent_text)) >= $2
        ORDER BY p.at DESC
        LIMIT $3`,
      [accountId, MIN_DOC_CHARS, LEARN_LIMIT],
    );

    const docs: VoiceDoc[] = rows.map((r) => ({
      docId: `sent:${r.show_id}:${r.id}`,
      question: r.question ?? "",
      text: r.sent_text.trim(),
      origin: "sent",
      showId: r.show_id,
      showTitle: r.title,
      at: r.at,
    }));

    // Pasted text has no show and no question — it is the operator handing us a
    // sample of how they write, which is the only corpus a brand-new account
    // has. Keyed on its own digest so pasting the same paragraph twice is one
    // document.
    const pasted = (opts.paste ?? [])
      .map((t) => t.trim())
      .filter((t) => t.length >= MIN_DOC_CHARS);
    for (const text of pasted) {
      docs.push({
        docId: `paste:${digest(text)}`,
        question: "", text, origin: "pasted",
        showId: null, showTitle: null, at: new Date().toISOString(),
      });
    }

    for (const doc of docs) {
      await this.d.query(
        `INSERT INTO persona_voice (account_id, doc_id, question, text, origin, show_id, show_title, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (account_id, doc_id) DO UPDATE SET
           question = EXCLUDED.question, text = EXCLUDED.text, show_title = EXCLUDED.show_title`,
        [accountId, doc.docId, doc.question, doc.text, doc.origin, doc.showId, doc.showTitle, doc.at],
      );
    }
    this.perAccount.delete(accountId);

    const byShow = new Map<string, { showId: string; title: string; count: number }>();
    for (const r of rows) {
      const e = byShow.get(r.show_id) ?? { showId: r.show_id, title: r.title ?? r.show_id, count: 0 };
      e.count++;
      byShow.set(r.show_id, e);
    }
    const total = await this.d.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM persona_voice WHERE account_id = $1", [accountId],
    );
    return {
      total: total.rows[0]?.n ?? 0,
      indexed: docs.length,
      pasted: pasted.length,
      shows: [...byShow.values()].sort((a, b) => b.count - a.count),
    };
  }

  async docs(accountId: string, limit = LEARN_LIMIT): Promise<VoiceDoc[]> {
    const { rows } = await this.d.query<{
      doc_id: string; question: string; text: string; origin: string;
      show_id: string | null; show_title: string | null; at: string;
    }>(
      `SELECT doc_id, question, text, origin, show_id, show_title, at
         FROM persona_voice WHERE account_id = $1 ORDER BY at DESC LIMIT $2`,
      [accountId, limit],
    );
    return rows.map((r) => ({
      docId: r.doc_id,
      question: r.question,
      text: r.text,
      origin: r.origin === "pasted" ? "pasted" : "sent",
      showId: r.show_id,
      showTitle: r.show_title,
      at: new Date(r.at).toISOString(),
    }));
  }

  async clear(accountId: string): Promise<number> {
    this.perAccount.delete(accountId);
    const r = await this.d.query("DELETE FROM persona_voice WHERE account_id = $1", [accountId]);
    return r.rowCount ?? 0;
  }

  /** The corpus as facts, cached the same minute the persona is — the reply
   *  path asks on every draft and the corpus changes only when `learn` runs. */
  private perAccount = new Map<string, { facts: Fact[]; at: number }>();
  async facts(accountId: string): Promise<Fact[]> {
    const hit = this.perAccount.get(accountId);
    if (hit && Date.now() - hit.at < 60_000) return hit.facts;
    const facts = (await this.docs(accountId)).map(voiceFact);
    this.perAccount.set(accountId, { facts, at: Date.now() });
    return facts;
  }
}

/** A fact is a style reference only if it came out of the voice corpus. The
 *  test is on `source`, not on the id prefix: an id is a label, a source is
 *  what produced the row. */
export const isVoiceFact = (f: Fact): boolean => f.source === "persona" && f.corpus === "qa";

/**
 * The single past answer that most resembles the question in hand, or none.
 *
 * At most one, on purpose. Three references are a style average, and the
 * average of three of anyone's replies sounds like nobody.
 */
export function styleRef(question: string, facts: Fact[]): StyleRef | null {
  const pool = facts.filter(isVoiceFact);
  if (!pool.length || !question.trim()) return null;

  const bm25 = new Bm25Index(pool);
  const lexical = bm25.search(question);
  const q = ngramVector(question);
  const ngram = pool
    .map((f, index) => ({ index, score: cosine(q, f.vector) }))
    .filter((x) => x.score > 0.02)
    .sort((a, b) => b.score - a.score);

  // RRF over the two RANKINGS, exactly as `Retriever.fuse` does it: the legs
  // score on incomparable scales and only their order can be trusted.
  const fused = new Map<number, number>();
  for (const list of [lexical, ngram]) {
    list.forEach((hit, rank) => fused.set(hit.index, (fused.get(hit.index) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  const best = [...fused.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;

  const [index] = best;
  const lexScore = lexical.find((x) => x.index === index)?.score ?? 0;
  const ngScore = ngram.find((x) => x.index === index)?.score ?? 0;
  if (lexScore < STYLE_BM25_FLOOR && ngScore < STYLE_NGRAM_FLOOR) return null;

  const f = pool[index]!;
  return { factId: f.factId, text: f.text, label: f.label };
}
