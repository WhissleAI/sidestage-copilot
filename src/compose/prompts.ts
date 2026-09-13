// The per-turn context block injected into /api/agents/{id}/chat/turn.
//
// Two things make this different from "stuff the catalog in the prompt":
//
//  1. Facts are NUMBERED and ADDRESSABLE. The model must cite a factId for every
//     claim. That turns a downstream guardrail from "does this look right?" into
//     "does the cited fact say this?", which is a decidable question.
//  2. The block is composed UNDER the agent's own persona and knowledge base by
//     the gateway, and is never stored. The seller's configured voice still
//     leads; this only supplies what is true right now.

import type { Fact } from "../retrieval/facts.js";
import type { ShowContext, ShowState } from "../domain/types.js";
import type { ListingWithDescription } from "../domain/repo.js";
import { formatMoney } from "../domain/money.js";

/** Gap #3 caps the context field at 16k characters. Stay well under it. */
const MAX_CONTEXT_CHARS = 12_000;

export interface ComposeInputs {
  show: ShowState;
  /** From the catalog the operator chose at setup. */
  seller?: { handle: string; name: string; about: string; voice: string } | null;
  pinned: ListingWithDescription | null;
  context: ShowContext | null;
  facts: Fact[];
  abstain: boolean;
  /** Set when the item was inferred from the pinned lot rather than named. */
  viaAnaphora: boolean;
}

export function buildContextBlock(i: ComposeInputs): string {
  const lines: string[] = [];

  lines.push(
    "=== ROLE ===",
    `You are the live-chat copilot for ${i.seller?.name || i.show.sellerHandle}` +
      `${i.seller ? ` (${i.seller.handle})` : ""}, who is running the live selling`,
    `show "${i.show.title}" right now. You draft the reply the seller will send to ONE buyer.`,
    "",
  );

  if (i.seller) {
    lines.push(
      "=== THE SELLER ===",
      i.seller.about,
      `Their voice: ${i.seller.voice}`,
      "",
    );
  }

  lines.push(
    "=== HOW TO REPLY ===",
    "- One or two sentences. Answer the actual question first, then at most one useful detail.",
    "- Warm, fast, specific. Plain text: no markdown, no bullet points, no emoji.",
    "- Never invent a price, a quantity, a date, a certificate number or a policy.",
    "- Every factual statement must come from a GROUNDING FACT below and cite its id.",
    "- Put ids ONLY in the `claims` array. NEVER write a fact id inside `answer` —",
    "  the buyer sees `answer`, and an id in it looks like a system error.",
    "- If the facts do not answer the question, say the host will cover it shortly. Do not guess.",
    "",
  );

  lines.push("=== LIVE SHOW STATE ===");
  if (i.pinned) {
    lines.push(
      `Pinned lot: ${i.pinned.title} — size ${i.pinned.size}, ${i.pinned.condition}, ` +
        `${formatMoney(i.pinned.priceCents)}, ${i.pinned.qty} available (listing version ${i.pinned.version}).`,
    );
  } else {
    lines.push("Pinned lot: none right now.");
  }
  // What the host is SAYING right now, from the listen-only audio session. This
  // is the part neither the catalog nor the chat can supply.
  if (i.context) {
    lines.push(`The host is currently talking about: ${i.context.currentTopic}.`);
    if (i.context.recentPoints.length) lines.push(`What the host just said: ${i.context.recentPoints.join("; ")}.`);
    if (i.context.tone) lines.push(`Host tone, from voice metadata: ${i.context.tone}.`);
  }
  if (i.viaAnaphora) {
    lines.push(
      "The buyer did not name an item, so this is assumed to be about the pinned lot. If the",
      "question clearly is not about that lot, say so instead of answering about the wrong item.",
    );
  }
  lines.push("");

  lines.push(
    "=== GROUNDING FACTS ===",
    "Each line is [id] followed by the fact. Cite the id WITHOUT the square brackets.",
  );
  if (i.facts.length) {
    for (const f of i.facts) {
      const stamp = f.listingVersion !== undefined ? ` (listing version ${f.listingVersion})` : "";
      lines.push(`[${f.factId}]${stamp} ${f.text}`);
    }
  } else {
    lines.push("(none — nothing in the catalog or policy corpus matched this question)");
  }
  lines.push("");

  if (i.abstain) {
    lines.push(
      "=== ABSTAIN ===",
      "Retrieval found no confident grounding for this question. Do NOT attempt an answer.",
      'Reply that the host will get to it, and return an empty "claims" array.',
      "",
    );
  }

  lines.push(
    "=== OUTPUT CONTRACT ===",
    "Return ONLY a JSON object, no prose before or after, in exactly this shape:",
    '{"answer": "<the reply text>", "claims": [{"text": "<one factual statement from the answer>", "factId": "<the bare id, e.g. listing:abc#price>"}]}',
    "Every factual statement in `answer` needs one entry in `claims`. Pleasantries need none.",
  );

  const out = lines.join("\n");
  return out.length > MAX_CONTEXT_CHARS ? out.slice(0, MAX_CONTEXT_CHARS) : out;
}

/** The repair turn. The first draft failed a deterministic guard; tell the model
 *  exactly which check failed and what the truth is, and let it try once more. */
export function buildRepairBlock(base: string, failures: { guard: string; reason: string }[]): string {
  return (
    base +
    "\n\n=== YOUR PREVIOUS DRAFT WAS REJECTED ===\n" +
    failures.map((f) => `- ${f.guard}: ${f.reason}`).join("\n") +
    "\nRewrite the reply so every one of those is fixed. Use ONLY the grounding facts above —" +
    "\nthey are current. Return the same JSON shape."
  );
}

export function buildUserMessage(author: string, text: string): string {
  return `Buyer "${author}" asked: ${JSON.stringify(text)}\n\nWrite the seller's reply as the JSON object.`;
}
