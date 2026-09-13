// The SideStage agent, as configuration.
//
// The agent carries IDENTITY and POLICY; this app carries STATE. The split is
// deliberate and is what makes the agent omni-channel: the persona, the voice
// guide, the never-say list and the tool-approval gate live on the agent, so a
// buyer who types in the show chat, opens the embed widget, or ends up on a
// voice call meets the same seller. Only the volatile part — this lot, this
// price, this version, right now — is injected per turn as `context`.

import type { Repo } from "../domain/repo.js";
import { formatMoney } from "../domain/money.js";
import { policy, toActionPolicy, toContentGuardrails } from "../guardrails/policy.js";

export const AGENT_NAME = "SideStage Seller Copilot";

export function systemPrompt(sellerHandle: string): string {
  const p = policy();
  return [
    `You are the live-chat copilot for ${sellerHandle}, a solo seller running live selling shows`,
    `for sneakers and streetwear. You draft the reply the seller sends to ONE buyer in the`,
    `show chat. You are not the seller's assistant in private — you write in their voice, to a`,
    `customer, in public.`,
    ``,
    `HOW YOU WRITE`,
    `- One or two sentences. Answer the actual question first, then at most one useful detail.`,
    `- Warm, fast and specific. Plain text only: no markdown, no bullets${p.allowEmoji ? "" : ", no emoji"}.`,
    `- Under ${p.maxReplyChars} characters.`,
    `- Use the buyer's name when they give it. Match the buyer's language.`,
    ``,
    `WHAT YOU MAY CLAIM`,
    `- Every factual statement must come from the grounding facts supplied with the turn, and`,
    `  must cite the fact's id. Facts about price, stock, condition, shipping, returns and`,
    `  authentication are supplied fresh on every turn — never answer from memory.`,
    `- If the supplied facts do not answer the question, say the host will cover it shortly.`,
    `  Guessing is worse than deferring: a wrong price on air costs the seller a sale and a refund.`,
    `- Never describe an item as an investment and never promise it will hold or gain value.`,
    `- Never promise a delivery date. Never direct a buyer to pay outside the marketplace.`,
    `- On-air discounts cap at ${p.maxDiscountPct}% off the listed price and never cross the item's floor price.`,
    ``,
    `OUTPUT`,
    `Return ONLY a JSON object: {"answer": "<reply>", "claims": [{"text": "<statement>", "factId": "<id>"}]}.`,
    `No prose outside the JSON.`,
  ].join("\n");
}

/** Fields sent on CREATE. */
export function createBody(sellerHandle: string) {
  return {
    name: AGENT_NAME,
    agent_type: "text_assistant",
    direction: "inbound",
    system_prompt: systemPrompt(sellerHandle),
    greeting: "Hey! Ask me anything about what's on the block.",
    language_mode: policy().languageMode,
    // Retrieval is done in this app, structurally, so the agent needs exactly one
    // tool as a fallback for anything the injected facts missed. Every extra tool
    // is another chance to spend the 2-second budget on a round trip we did not need.
    tools: [{ name: "search_knowledge_base", enabled: true }],
  };
}

/**
 * Fields sent on PATCH — the guardrail configuration.
 *
 * `content_guardrails` is enforced by the gateway's services/content_guard.py on
 * the live reply, in the text turn AND the voice processor. `action_policy` makes
 * the gateway HOLD a sensitive tool call and raise an approve/discard affordance
 * instead of firing it — human-in-the-loop built into the platform, not bolted on here.
 */
export function guardrailBody() {
  return {
    content_guardrails: toContentGuardrails(),
    action_policy: toActionPolicy(),
    language_mode: policy().languageMode,
  };
}

/** The catalog knowledge document. Stable facts only — anything volatile
 *  (price, quantity, pinned state) is injected per turn instead, because a KB
 *  document cannot be re-indexed fast enough to be trusted mid-show. */
export function catalogDoc(repo: Repo): string {
  const lines = ["# Catalog — stable item facts", "", "> Prices and quantities are NOT in this document.", "> They change during a show and are supplied with each turn.", ""];
  for (const l of repo.listings()) {
    lines.push(
      `## ${l.title}`,
      `- SKU: ${l.sku}`,
      `- Brand / model: ${l.brand} ${l.model}`,
      `- Colorway: ${l.colorway}`,
      `- Size: ${l.size}`,
      `- Condition grade: ${l.condition}`,
      `- Authentication: ${l.authenticated && l.certId ? `CheckCheck certificate ${l.certId}` : "not third-party authenticated"}`,
      `- Shipping profile: ${l.shippingProfile}`,
      `- Reference list price at show open: ${formatMoney(l.priceCents)} (indicative only — use the per-turn fact)`,
      ``,
      l.description,
      ``,
    );
  }
  return lines.join("\n");
}

/** The policy knowledge document. */
export function policyDoc(repo: Repo): string {
  const lines = ["# Store policies", ""];
  for (const p of repo.policies()) lines.push(`## ${p.title} (${p.topic})`, "", p.body, "");
  const qa = repo.qa();
  if (qa.length) {
    lines.push("# Frequently asked in chat", "");
    for (const q of qa) lines.push(`**${q.question}?** ${q.answer}`, "");
  }
  return lines.join("\n");
}
