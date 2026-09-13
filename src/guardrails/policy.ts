// The seller's guardrail policy — ONE configurable object, enforced in TWO places.
//
// This is the architectural point of the whole safety design (docs/TDD.md §4):
//
//   Layer A — IN THE WHISSLE AGENT (preventive, channel-portable, state-blind).
//     `content_guardrails` is pushed onto the agent and enforced by the gateway's
//     services/content_guard.py on the live reply — in `text_turn` AND in the
//     voice ContentGuardProcessor, so the identical rule holds whether the buyer
//     is typing in the show chat, talking to the embed widget, or on a call. It
//     fires even when this app is not in the loop. What it CANNOT do is know
//     that the pinned lot's price changed four seconds ago.
//
//   Layer B — IN THIS APP (detective, state-aware, deterministic).
//     src/guardrails/guards.ts checks the draft against LIVE catalog state:
//     listing version, current quantity, floor price, discount cap, and whether
//     each cited factId was actually in the evidence we handed the model. None
//     of that is expressible as a never-say phrase.
//
// Neither layer subsumes the other, so both read from this one object and cannot
// drift. `npm run seed:agent` is what pushes Layer A to the gateway.

import { readFileSync } from "node:fs";

export interface NeverSayRule {
  /** A literal substring (case-insensitive) or, with `regex: true`, a pattern. */
  pattern: string;
  regex?: boolean;
  /** Operator-facing explanation, shown on the guardrail pill and in the audit. */
  why: string;
  /** Permitted after all when the resolved listing carries an authentication
   *  certificate — "guaranteed authentic" is only a lie when it is not certified. */
  unlessCertified?: boolean;
}

export interface SellerGuardrailPolicy {
  /** Phrases the seller will never say. Pushed to the agent AND checked here. */
  neverSay: NeverSayRule[];
  /** Mask e-mail / phone / SSN / card spans in the live reply (agent-side). */
  redactPii: boolean;
  /** What the agent says instead when a never-say rule fires. */
  onViolation: string;
  /** Hard cap on an on-air discount, as a percentage of the listed price. */
  maxDiscountPct: number;
  /** Live-chat replies stay short. */
  maxReplyChars: number;
  allowMarkdown: boolean;
  allowEmoji: boolean;
  /** Over-promising language the condition notes cannot support. */
  hypePhrases: string[];
  /** Follow the buyer's language, or stay in one. */
  languageMode: "auto" | "fixed";
  /** Tools the agent must NOT fire without a human — pushed as
   *  `action_policy: {tool: "approve"}`, which makes the gateway hold the call
   *  and raise an approve/discard affordance instead of executing. */
  holdForApproval: string[];
}

export const DEFAULT_POLICY: SellerGuardrailPolicy = {
  redactPii: true,
  onViolation: "Let me get the host to answer that one directly.",
  maxDiscountPct: 15,
  maxReplyChars: 400,
  allowMarkdown: false,
  allowEmoji: false,
  languageMode: "auto",
  holdForApproval: ["send_email", "send_sms"],
  hypePhrases: [
    "trust me", "you won't regret", "you wont regret", "literally the best",
    "insane deal", "steal at this price", "once in a lifetime", "you need this",
    "sleeping on",
  ],
  neverSay: [
    { pattern: "investment", why: "describes the item as an investment" },
    { pattern: "appreciate in value", why: "promises the item will appreciate" },
    { pattern: "will go up in value", why: "promises the item will appreciate" },
    { pattern: "guaranteed return", why: "promises a financial return" },
    { pattern: "resale value is guaranteed", why: "promises a resale value" },
    { pattern: "guarantee[d]?\\s+(?:100%\\s+)?(?:authentic|legit|real)", regex: true, unlessCertified: true,
      why: "says 'guaranteed authentic'" },
    { pattern: "100%\\s*(?:authentic|legit|real|genuine)", regex: true, unlessCertified: true,
      why: "makes an absolute authenticity claim" },
    { pattern: "(?:cures?|heals?|prevents?|treats?)\\b", regex: true,
      why: "makes a health claim about footwear" },
    { pattern: "improves? your (?:health|posture|performance)", regex: true,
      why: "makes a performance claim about footwear" },
    { pattern: "venmo", why: "directs payment off the marketplace" },
    { pattern: "cash app", why: "directs payment off the marketplace" },
    { pattern: "cashapp", why: "directs payment off the marketplace" },
    { pattern: "zelle", why: "directs payment off the marketplace" },
    { pattern: "paypal friends", why: "directs payment off the marketplace" },
    { pattern: "pay me directly", why: "directs payment off the marketplace" },
    { pattern: "dm me to pay", why: "directs payment off the marketplace" },
    { pattern: "will (?:definitely |certainly )?arrive (?:by|on|before)", regex: true,
      why: "promises a delivery date the seller does not control" },
  ],
};

let cached: SellerGuardrailPolicy | null = null;

/** The active policy. `GUARDRAIL_POLICY_PATH` points at a JSON file that is
 *  shallow-merged over the defaults, so a seller can tighten or loosen the rules
 *  without a code change — and the same file drives the agent config. */
export function policy(): SellerGuardrailPolicy {
  if (cached) return cached;
  const path = process.env.GUARDRAIL_POLICY_PATH;
  if (!path) return (cached = DEFAULT_POLICY);
  try {
    const override = JSON.parse(readFileSync(path, "utf8")) as Partial<SellerGuardrailPolicy>;
    return (cached = { ...DEFAULT_POLICY, ...override });
  } catch (e) {
    console.warn(`[guardrails] could not read ${path}: ${(e as Error).message} — using defaults`);
    return (cached = DEFAULT_POLICY);
  }
}

/** Test seam. */
export function setPolicy(p: SellerGuardrailPolicy | null): void {
  cached = p;
}

/** Compile the never-say rules into matchers for the APP-side check. */
export function neverSayMatchers(p = policy()): { re: RegExp; rule: NeverSayRule }[] {
  return p.neverSay.map((rule) => ({
    re: rule.regex
      ? new RegExp(rule.pattern, "i")
      : new RegExp(`\\b${rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
    rule,
  }));
}

/**
 * Project the policy into the gateway's `content_guardrails` shape.
 *
 * Note the deliberate asymmetry: rules marked `unlessCertified` are NOT pushed
 * to the agent. The gateway's guard is a pure string match with no access to the
 * catalog, so pushing "100% authentic" there would blanket-block the phrase even
 * on a listing that genuinely carries a CheckCheck certificate. Those rules stay
 * in Layer B, where the listing's `authenticated` + `certId` are in hand. That
 * split — and the reason for it — is the honest version of "we have guardrails".
 */
export function toContentGuardrails(p = policy()): {
  enabled: boolean;
  never_say: string[];
  on_violation: string;
  redact_pii: boolean;
} {
  return {
    enabled: true,
    never_say: p.neverSay
      .filter((r) => !r.unlessCertified)
      .map((r) => (r.regex ? `/${r.pattern}/` : r.pattern)),
    on_violation: p.onViolation,
    redact_pii: p.redactPii,
  };
}

/** Project the policy into the gateway's per-tool `action_policy` shape. */
export function toActionPolicy(p = policy()): Record<string, string> {
  return Object.fromEntries(p.holdForApproval.map((t) => [t, "approve"]));
}
