// Composer: ask the agent for a claim-structured draft, and parse it defensively.
//
// The model is asked for JSON, not prose. When it complies we get claims we can
// check. When it does not — and any model sometimes does not — we must still end
// up with something the guardrails can evaluate, so `parse` degrades in stages:
// strict JSON, then a fenced/embedded object, then treat the whole output as an
// uncited answer. An uncited answer is not a failure mode we hide: it reaches the
// grounding guard with zero claims and gets flagged there.

import type { Claim } from "../domain/types.js";
import type { LlmPort } from "../llm/types.js";
import {
  buildContextBlock, buildRegenerateBlock, buildRepairBlock, buildUserMessage, type ComposeInputs,
} from "./prompts.js";

/** The tone guard caps a reply at 400 characters — roughly 110 tokens of prose,
 *  plus the claims array. 400 max_tokens was budgeting for output we would reject
 *  anyway, and generation time scales with the cap. Measured effect is in
 *  docs/EVALS.md. */
const REPLY_MAX_TOKENS = 220;

export interface Draft {
  answer: string;
  claims: Claim[];
  /** false when the model did not return usable JSON — surfaced, never hidden. */
  parsedOk: boolean;
  raw: string;
}

export class Composer {
  constructor(private llm: LlmPort) {}

  async draft(
    inputs: ComposeInputs,
    author: string,
    question: string,
    /** The reply the seller rejected, when this is a regenerate. */
    previous?: string,
    /**
     * Called with the reply as it generates.
     *
     * The model is asked for JSON, so a partial stream is partial JSON — not
     * something to show a seller verbatim. `partialAnswer` pulls whatever of the
     * `answer` string has arrived, which is the only part of the payload that is
     * human-readable mid-flight. When it returns nothing, nothing is shown; a
     * progress indicator beats a bracket.
     */
    onPartial?: (answerSoFar: string) => void,
  ): Promise<{ draft: Draft; contextBlock: string }> {
    const base = buildContextBlock(inputs);
    const contextBlock = previous ? buildRegenerateBlock(base, previous) : base;
    const msg = buildUserMessage(author, question);

    // Stream when someone is watching; take the plain door when nobody is, so a
    // bench run and a regenerate do not pay for narration they discard.
    const raw = onPartial
      ? await this.llm.chatTurnStream(msg, contextBlock, (_d, full) => {
          const partial = partialAnswer(full);
          if (partial) onPartial(partial);
        }, { maxTokens: REPLY_MAX_TOKENS })
      : await this.llm.chatTurn(msg, contextBlock, { maxTokens: REPLY_MAX_TOKENS });

    return { draft: parseDraft(raw), contextBlock };
  }

  async repair(
    contextBlock: string,
    author: string,
    question: string,
    failures: { guard: string; reason: string }[],
  ): Promise<Draft> {
    const raw = await this.llm.chatTurn(
      buildUserMessage(author, question),
      buildRepairBlock(contextBlock, failures),
      { maxTokens: REPLY_MAX_TOKENS },
    );
    return parseDraft(raw);
  }
}

/**
 * The `answer` string out of a half-written JSON object.
 *
 * The reply arrives as `{"answer":"…","claims":[…]}`, so until the closing quote
 * lands there is no parseable object — but the answer text itself is readable
 * from the first token. This reads it out of the partial buffer, unescaping the
 * few sequences that can appear mid-string, and returns "" when the buffer has
 * not reached the answer yet.
 */
export function partialAnswer(buf: string): string {
  const at = buf.indexOf('"answer"');
  if (at === -1) return "";
  const open = buf.indexOf('"', buf.indexOf(":", at) + 1);
  if (open === -1) return "";

  let out = "";
  for (let i = open + 1; i < buf.length; i++) {
    const c = buf[i];
    if (c === "\\") {
      const n = buf[i + 1];
      if (n === undefined) break;          // escape split across chunks
      out += n === "n" ? "\n" : n === "t" ? "\t" : n;
      i++;
      continue;
    }
    if (c === '"') break;                  // the answer closed
    out += c;
  }
  return out;
}

export function parseDraft(raw: string): Draft {
  const obj = extractJsonObject(raw);
  if (obj && typeof obj.answer === "string") {
    const claims: Claim[] = Array.isArray(obj.claims)
      ? (obj.claims as unknown[])
          .map((c) => c as { text?: unknown; factId?: unknown })
          .filter((c) => typeof c.text === "string" && typeof c.factId === "string")
          .map((c) => ({ text: String(c.text).trim(), factId: normalizeFactId(String(c.factId)), supported: false }))
      : [];
    return { answer: cleanAnswer(obj.answer), claims, parsedOk: true, raw };
  }
  // The model answered in prose. Keep the text — the grounding guard will catch
  // that it carries no citations.
  return { answer: cleanAnswer(stripFences(raw)), claims: [], parsedOk: false, raw };
}

/**
 * Facts are PRESENTED to the model as `[listing:x#price] ...`, and models
 * reliably copy that display format back into the citation — `"[listing:x#price]"`
 * rather than `"listing:x#price"`. The id then fails lookup and the grounding
 * guard blocks a perfectly good reply. Observed constantly against the live agent.
 * The prompt now asks for the bare id; this strips the brackets regardless,
 * because being strict about a formatting artefact helps nobody.
 */
export function normalizeFactId(raw: string): string {
  return raw.trim().replace(/^[[\s"'`]+/, "").replace(/[\]\s"'`]+$/, "").trim();
}

/** Fact ids belong in `claims`, never in the buyer-facing text. Models put them
 *  inline anyway — observed against the live agent, which emitted
 *  "Mookie Betts ($92) listing:lst_83de657499aa#price, ...". Strip them, and any
 *  punctuation left stranded, rather than shipping an id to a buyer. */
function stripFactIds(s: string): string {
  return s
    .replace(/[\[(]?\b(?:listing|policy|qa|market|catalog):[A-Za-z0-9_.:-]+(?:#[A-Za-z_]+)?[\])]?/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanAnswer(s: string): string {
  return stripFactIds(s).replace(/\s+/g, " ").replace(/^["'`]|["'`]$/g, "").trim();
}

function stripFences(s: string): string {
  return s.replace(/^\s*```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
}

/** Find the first balanced JSON object in the output. A regex `\{[\s\S]*\}` is
 *  greedy across multiple objects and trailing prose; brace counting is not. */
export function extractJsonObject(s: string): Record<string, unknown> | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
