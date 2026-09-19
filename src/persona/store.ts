// The persona: the operator, in their own words, per surface.
//
// The settings page already asks for a paragraph of voice, and for a live
// selling chat that is the right amount of ceremony — the buyer wants to know
// whether the size 10 is still there. The paragraph runs out on every surface
// where the register is the credibility rather than a finish on it: a subreddit
// reads brand-voice as an ad and never gets as far as checking whether it was
// true. So a persona adds the three things a paragraph cannot hold — boundaries
// the guards can enforce, a register PER surface, and a corpus of the
// operator's own past text (src/persona/voice.ts).
//
// The caching here is deliberately the same shape as `SettingsStore.forAccount`
// rather than a new one. That method already solved this exact problem: a value
// read on the reply hot path, edited rarely, and fatal to serve stale after an
// edit — so the write invalidates rather than the read expiring quickly.

import type { Pool } from "../db/pg.js";
import type { SurfaceId } from "../surfaces/types.js";

/** What the persona will never claim, never discuss, and always disclose.
 *  The first two become never-say rules; the third cannot be one, and
 *  `boundaries.ts` says why at length. */
export interface PersonaBoundaries {
  never_claim: string[];
  never_discuss: string[];
  must_disclose: string[];
}

/** How this operator sounds on ONE surface. The same person writes differently
 *  in r/mechmarket and in a live auction chat, and a single "voice" field asks
 *  them to pick one and be wrong on the other. */
export interface Register {
  length: "short" | "medium";
  /** 1 is how you text a friend; 5 is how you write to a landlord. */
  formality: number;
  emoji: boolean;
  notes: string;
}

export interface Persona {
  id: string;
  name: string;
  about: string;
  voice: string;
  boundaries: PersonaBoundaries;
  disclosure: string | null;
  registers: Partial<Record<SurfaceId, Register>>;
  /** Reserved — see the migration. Empty means the whole voice corpus. */
  corpusDocIds: string[];
  updatedAt: string | null;
}

/** Every route addresses this one. The `id` column exists so a second persona
 *  needs no migration, not because anything writes a second today. */
export const DEFAULT_PERSONA_ID = "default";

export const EMPTY_BOUNDARIES: PersonaBoundaries = {
  never_claim: [], never_discuss: [], must_disclose: [],
};

interface Row {
  id: string; name: string; about: string; voice: string;
  boundaries: Partial<PersonaBoundaries> | null;
  disclosure: string | null;
  registers: Record<string, Partial<Register>> | null;
  corpus_doc_ids: string[] | null;
  updated_at: Date | string;
}

const strings = (v: unknown, cap: number): string[] =>
  Array.isArray(v)
    ? v.map((x) => String(x).replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, cap)
    : [];

/** A register arrives from a form and is read by the prompt builder. Bound it
 *  here rather than where it is rendered: a formality of 11 would be printed at
 *  the model verbatim, and "how you write to a landlord, but more so" is not a
 *  register, it is a typo with a straight face. */
function toRegister(v: Partial<Register> | undefined): Register | null {
  if (!v || typeof v !== "object") return null;
  return {
    length: v.length === "medium" ? "medium" : "short",
    formality: Math.max(1, Math.min(5, Math.round(Number(v.formality) || 3))),
    emoji: Boolean(v.emoji),
    notes: String(v.notes ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
  };
}

function toPersona(r: Row): Persona {
  const registers: Partial<Record<SurfaceId, Register>> = {};
  for (const [surface, reg] of Object.entries(r.registers ?? {})) {
    const parsed = toRegister(reg);
    if (parsed) registers[surface as SurfaceId] = parsed;
  }
  return {
    id: r.id,
    name: r.name,
    about: r.about,
    voice: r.voice,
    boundaries: {
      never_claim: strings(r.boundaries?.never_claim, 50),
      never_discuss: strings(r.boundaries?.never_discuss, 50),
      must_disclose: strings(r.boundaries?.must_disclose, 10),
    },
    disclosure: r.disclosure,
    registers,
    corpusDocIds: r.corpus_doc_ids ?? [],
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

/** What a client may set. Anything else in the body is dropped rather than
 *  merged — the same rule `SettingsStore.sanitize` applies, for the same reason:
 *  this object is read by the prompt builder and by the guard policy, and a
 *  stale or hostile client must not be able to put a key into either. */
export function sanitizePersona(input: unknown): Partial<Persona> {
  if (!input || typeof input !== "object") return {};
  const b = input as Record<string, unknown>;
  const out: Partial<Persona> = {};
  if (typeof b.name === "string") out.name = b.name.replace(/\s+/g, " ").trim().slice(0, 120);
  if (typeof b.about === "string") out.about = b.about.trim().slice(0, 2000);
  if (typeof b.voice === "string") out.voice = b.voice.trim().slice(0, 2000);
  if (typeof b.disclosure === "string") out.disclosure = b.disclosure.trim().slice(0, 300) || null;
  else if (b.disclosure === null) out.disclosure = null;
  if (b.boundaries && typeof b.boundaries === "object") {
    const x = b.boundaries as Record<string, unknown>;
    out.boundaries = {
      never_claim: strings(x.never_claim, 50).map((s) => s.slice(0, 200)),
      never_discuss: strings(x.never_discuss, 50).map((s) => s.slice(0, 200)),
      must_disclose: strings(x.must_disclose, 10).map((s) => s.slice(0, 200)),
    };
  }
  if (b.registers && typeof b.registers === "object") {
    const regs: Partial<Record<SurfaceId, Register>> = {};
    for (const [surface, v] of Object.entries(b.registers as Record<string, unknown>)) {
      const parsed = toRegister(v as Partial<Register>);
      if (parsed) regs[surface as SurfaceId] = parsed;
    }
    out.registers = regs;
  }
  return out;
}

export class PersonaStore {
  constructor(private d: Pool) {}

  async load(accountId: string, id = DEFAULT_PERSONA_ID): Promise<Persona | null> {
    const r = await this.d.query<Row>(
      `SELECT id, name, about, voice, boundaries, disclosure, registers, corpus_doc_ids, updated_at
         FROM personas WHERE account_id = $1 AND id = $2`,
      [accountId, id],
    );
    return r.rows[0] ? toPersona(r.rows[0]) : null;
  }

  /**
   * Write the fields the caller named, and only those.
   *
   * A PUT that omits `boundaries` is an edit to the about text, not a decision
   * to drop every never-say rule the operator wrote — and the guard policy is
   * downstream of this object, so a partial body that cleared it would quietly
   * un-arm a guardrail. COALESCE keeps what is there.
   */
  async upsert(accountId: string, patch: Partial<Persona>, id = DEFAULT_PERSONA_ID): Promise<Persona> {
    this.perAccount.delete(accountId);
    const r = await this.d.query<Row>(
      `INSERT INTO personas (account_id, id, name, about, voice, boundaries, disclosure, registers, updated_at)
       VALUES ($1, $2, COALESCE($3, ''), COALESCE($4, ''), COALESCE($5, ''),
               COALESCE($6::jsonb, '{}'::jsonb), $7, COALESCE($8::jsonb, '{}'::jsonb), now())
       ON CONFLICT (account_id, id) DO UPDATE SET
         name = COALESCE($3, personas.name),
         about = COALESCE($4, personas.about),
         voice = COALESCE($5, personas.voice),
         boundaries = COALESCE($6::jsonb, personas.boundaries),
         disclosure = COALESCE($7, personas.disclosure),
         registers = COALESCE($8::jsonb, personas.registers),
         updated_at = now()
       RETURNING id, name, about, voice, boundaries, disclosure, registers, corpus_doc_ids, updated_at`,
      [
        accountId, id,
        patch.name ?? null, patch.about ?? null, patch.voice ?? null,
        patch.boundaries ? JSON.stringify(patch.boundaries) : null,
        patch.disclosure ?? null,
        patch.registers ? JSON.stringify(patch.registers) : null,
      ],
    );
    return toPersona(r.rows[0]!);
  }

  async remove(accountId: string, id = DEFAULT_PERSONA_ID): Promise<boolean> {
    this.perAccount.delete(accountId);
    const r = await this.d.query("DELETE FROM personas WHERE account_id = $1 AND id = $2", [accountId, id]);
    return (r.rowCount ?? 0) > 0;
  }

  /** One account's persona, cached a minute; `upsert` invalidates. Null is
   *  cached too: most accounts have no persona and the reply path asks on every
   *  draft, so "no" has to be as cheap as "yes". */
  private perAccount = new Map<string, { p: Persona | null; at: number }>();
  async forAccount(accountId: string): Promise<Persona | null> {
    const hit = this.perAccount.get(accountId);
    if (hit && Date.now() - hit.at < 60_000) return hit.p;
    const p = await this.load(accountId);
    this.perAccount.set(accountId, { p, at: Date.now() });
    return p;
  }

  /** Test seam and the answer to an edit landing from another process. */
  invalidate(accountId: string): void {
    this.perAccount.delete(accountId);
  }
}
