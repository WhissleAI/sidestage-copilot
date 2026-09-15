// What the agent concluded, at the end of the show.
//
// The report's other sections are counted: replies sent, guards tripped, lots
// ended. This one is WRITTEN — by the same agent that worked the show, reading
// the same persisted record the counts came from, and asked one question: what
// should the seller do before the next show. Two rules keep it honest:
//
//   · It reads only what was persisted. The agent is handed the evidence below
//     and nothing else, so every next action can be traced to a number or a
//     transcript line on the same page. An agent free to recall the show from
//     memory would recall a show that did not happen.
//   · It is structured, not prose. A paragraph cannot be sorted, deduplicated
//     against the gaps list, or turned into a checklist; a list of typed
//     actions can.
//
// Vocabulary, shared with sessionRecord.ts and the console:
//
//   conclusion   this object — summary, outcome, key points, next actions.
//   next action  one thing to do before the next show, with the evidence for
//                it. Kinds: catalog · pricing · inventory · hosting · policy ·
//                setup. "hosting" is the one only a perception product can
//                write: it comes from how the host spoke, not what buyers typed.

import type { LlmPort } from "../llm/types.js";
import type { HostSummary } from "./signals.js";

export type NextActionKind = "catalog" | "pricing" | "inventory" | "hosting" | "policy" | "setup";
const KINDS = new Set<NextActionKind>(["catalog", "pricing", "inventory", "hosting", "policy", "setup"]);

export type Outcome = "strong" | "steady" | "rough" | "quiet";
const OUTCOMES = new Set<Outcome>(["strong", "steady", "rough", "quiet"]);

export interface NextAction {
  kind: NextActionKind;
  title: string;
  /** The evidence, in the agent's words, pointing at a number or a line. */
  why: string;
}

export interface Conclusion {
  /** Three or four sentences, written for the seller. */
  summary: string;
  outcome: Outcome;
  keyPoints: string[];
  nextActions: NextAction[];
  /** How this was produced, so the page can say so. */
  by: "agent";
  at: string;
}

/** Everything the agent is allowed to know. Built by the report from persisted rows. */
export interface ConclusionEvidence {
  title: string;
  host: string;
  durationMin: number;
  engagement: { commentsSeen: number; questionsAsked: number; answered: number; sent: number; p95LatencyMs: number };
  safety: { blocked: number; revised: number; abstained: number; flaggedWrong: number; byGuard: Record<string, number> };
  actions: { proposed: number; committed: number; rolledBack: number; failed: number };
  inventory: { lotsObserved: number; lotsEnded: number; priceChanges: number; peakViewers: number };
  gaps: { question: string; asked: number; reason: string }[];
  hostSignals: HostSummary | null;
  /** A handful of what the camera showed, oldest first. */
  onScreen: { offsetMs: number; reading: string }[];
  /** A handful of what the host said, oldest first, with the top label. */
  said: { offsetMs: number; text: string; emotion: string | null; intent: string | null }[];
  gmv: { grossCents: number; lotsSold: number } | null;
  /** The platform's own end-of-session summary, when it produced one. */
  platformSummary: string | null;
}

const SYSTEM = `You are the copilot that just worked a live selling show. Write the seller's post-show conclusion.

Rules:
- Use ONLY the evidence given. Every claim must point at a number, a line the host said, or something the camera showed. Do not invent lots, prices or buyers.
- Write for the seller, in the second person, plainly. No praise, no hedging.
- "outcome" is one of: strong (questions answered, lots moved), steady (worked as expected), rough (blocks, rollbacks, unanswered questions or wrong replies), quiet (too little happened to judge).
- "nextActions" are things to do BEFORE THE NEXT SHOW. 2 to 6 of them, most valuable first. Each has a kind:
    catalog   — a fact the catalog lacked (from the gaps)
    pricing   — a floor, markdown or comp to revisit
    inventory — stock, lots, what to bring
    hosting   — how the host spoke or paced, from the host signals (intent, emotion, speech rate, flips)
    policy    — a guard that fired, a policy to state
    setup     — audio, camera, connection, agent readiness
- Reply with ONE JSON object and nothing else:
{"summary": string, "outcome": string, "keyPoints": string[], "nextActions": [{"kind": string, "title": string, "why": string}]}`;

function money(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

function evidenceText(e: ConclusionEvidence): string {
  const lines: string[] = [];
  lines.push(`SHOW: "${e.title}" hosted by ${e.host}, ${e.durationMin} min on air, peak ${e.inventory.peakViewers} viewers.`);
  lines.push(
    `ENGAGEMENT: ${e.engagement.commentsSeen} comments seen, ${e.engagement.questionsAsked} questions, ` +
    `${e.engagement.answered} answered, ${e.engagement.sent} sent, p95 time-to-answer ${e.engagement.p95LatencyMs} ms.`,
  );
  lines.push(
    `SAFETY: ${e.safety.blocked} blocked, ${e.safety.revised} revised, ${e.safety.abstained} abstained, ` +
    `${e.safety.flaggedWrong} marked wrong by the seller. Guards: ${
      Object.entries(e.safety.byGuard).map(([g, n]) => `${g}×${n}`).join(", ") || "none fired"
    }.`,
  );
  lines.push(
    `ACTIONS: ${e.actions.proposed} proposed, ${e.actions.committed} committed, ${e.actions.rolledBack} rolled back, ${e.actions.failed} failed.`,
  );
  lines.push(
    `INVENTORY: ${e.inventory.lotsObserved} lots observed, ${e.inventory.lotsEnded} ended, ${e.inventory.priceChanges} price changes.` +
    (e.gmv ? ` GMV ${money(e.gmv.grossCents)} across ${e.gmv.lotsSold} sold lots.` : " GMV not measured."),
  );
  if (e.gaps.length) {
    lines.push("GAPS (questions with no grounded answer):");
    for (const g of e.gaps.slice(0, 10)) lines.push(`  - "${g.question}" asked ${g.asked}× — ${g.reason}`);
  } else lines.push("GAPS: none.");
  if (e.hostSignals) {
    const h = e.hostSignals;
    const pct = (xs: { label: string; share: number }[]) =>
      xs.slice(0, 4).map((x) => `${x.label} ${Math.round(x.share * 100)}%`).join(", ") || "none";
    lines.push(
      `HOST SIGNALS (measured from the host's speech, ${h.utterances} utterances over ${h.speakingSpanS}s): ` +
      `intent ${pct(h.intent)}; emotion ${pct(h.emotion)}; ` +
      `median speech rate ${h.medianSpeechRate ?? "unknown"} wpm; ${h.emotionFlips} emotion flips.`,
    );
  } else lines.push("HOST SIGNALS: none — host audio was not captured.");
  if (e.said.length) {
    lines.push("HOST SAID (sample):");
    for (const s of e.said) {
      lines.push(`  [${Math.round(s.offsetMs / 1000)}s] "${s.text}"${s.emotion ? ` (${s.emotion}` : ""}${s.intent ? `${s.emotion ? ", " : " ("}${s.intent}` : ""}${s.emotion || s.intent ? ")" : ""}`);
    }
  }
  if (e.onScreen.length) {
    lines.push("ON SCREEN (what the camera showed, read by you during the show):");
    for (const f of e.onScreen) lines.push(`  [${Math.round(f.offsetMs / 1000)}s] ${f.reading}`);
  } else lines.push("ON SCREEN: no frames were read.");
  if (e.platformSummary) lines.push(`PLATFORM SUMMARY OF THE AUDIO SESSION: ${e.platformSummary}`);
  return lines.join("\n");
}

/** Pull the first JSON object out of a reply that may be wrapped in prose or fences. */
export function parseConclusion(raw: string, at = new Date().toISOString()): Conclusion | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const summary = typeof j.summary === "string" ? j.summary.trim() : "";
  if (!summary) return null;
  const outcome = OUTCOMES.has(j.outcome as Outcome) ? (j.outcome as Outcome) : "steady";
  const keyPoints = Array.isArray(j.keyPoints)
    ? j.keyPoints.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 8)
    : [];
  const nextActions: NextAction[] = [];
  if (Array.isArray(j.nextActions)) {
    for (const a of j.nextActions as Record<string, unknown>[]) {
      if (!a || typeof a !== "object") continue;
      const title = typeof a.title === "string" ? a.title.trim() : "";
      if (!title) continue;
      const kind = KINDS.has(a.kind as NextActionKind) ? (a.kind as NextActionKind) : "setup";
      nextActions.push({ kind, title, why: typeof a.why === "string" ? a.why.trim() : "" });
      if (nextActions.length >= 6) break;
    }
  }
  return { summary, outcome, keyPoints, nextActions, by: "agent", at };
}

/** Ask the show's agent. Null when it cannot answer — the report says so. */
export async function concludeShow(llm: LlmPort, e: ConclusionEvidence): Promise<Conclusion | null> {
  try {
    const raw = await llm.utilityTurn(SYSTEM, evidenceText(e), { maxTokens: 900 });
    return parseConclusion(raw);
  } catch {
    return null;
  }
}
