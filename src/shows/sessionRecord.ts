// Persisting what a session actually was, and reporting on it afterwards.
//
// Chat and reply proposals used to live only in maps on the ShowRuntime, so a
// restart erased the entire record of what buyers asked and what the copilot
// answered. Listings and the audit chain survived; the conversation did not.
//
// Writes here are fire-and-forget on purpose. A buyer's question must never wait
// on a database round trip to reach the seller, and losing one row from a report
// is a smaller failure than adding latency to every reply.

import type { Pool } from "../db/pg.js";
import type { ChatMessage, ReplyProposal } from "../domain/types.js";

export class SessionRecord {
  constructor(private d: Pool, private showId: string) {}

  recordChat(m: ChatMessage): void {
    void this.d
      .query(
        `INSERT INTO chat_messages (show_id, id, author, text, at, intent, speech_act, admitted, drop_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (show_id, id) DO UPDATE SET
           admitted = EXCLUDED.admitted, drop_reason = EXCLUDED.drop_reason`,
        [this.showId, m.id, m.author, m.text, m.at, m.intent, m.speechAct ?? null,
         m.admitted, m.dropReason ?? null],
      )
      .catch(() => {});
  }

  recordProposal(p: ReplyProposal): void {
    // A draft in flight is not a record of anything; wait until it settles.
    if (p.status === "drafting") return;
    void this.d
      .query(
        `INSERT INTO reply_proposals (show_id, id, message_id, author, question, draft, sent_text,
           status, verdict, confidence, repaired, abstained, latency_ms, cache_hit, guards, evidence, intent, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18)
         ON CONFLICT (show_id, id) DO UPDATE SET
           draft = EXCLUDED.draft, sent_text = EXCLUDED.sent_text, status = EXCLUDED.status,
           verdict = EXCLUDED.verdict, confidence = EXCLUDED.confidence,
           guards = EXCLUDED.guards, evidence = EXCLUDED.evidence`,
        [
          this.showId, p.id, p.message.id, p.message.author, p.message.text,
          p.draft ?? "", p.sentText ?? null, p.status, p.verdict, p.confidence,
          p.repaired, p.evidence.length === 0, p.spans?.totalMs ?? 0, p.spans?.cacheHit ?? false,
          JSON.stringify(p.guards ?? []), JSON.stringify(p.evidence ?? []),
          p.message.intent ?? null, p.message.at,
        ],
      )
      .catch(() => {});
  }
}

// ── the report ──────────────────────────────────────────────────────────────

export interface ShowReport {
  showId: string;
  title: string;
  source: string;
  startedAt: string;
  endedAt: string;
  durationMin: number;
  /** Did it help. */
  engagement: {
    commentsSeen: number;
    questionsAsked: number;
    answered: number;
    sent: number;
    answeredRate: number;
    medianLatencyMs: number;
    p95LatencyMs: number;
    cacheHitRate: number;
  };
  /** Can I trust it. */
  safety: {
    blocked: number;
    revised: number;
    abstained: number;
    byGuard: Record<string, number>;
    auditChain: { ok: boolean; height: number; brokenAt?: number };
    examples: { question: string; draft: string; guard: string; reason: string }[];
  };
  /** What moved on the block. */
  inventory: {
    lotsObserved: number;
    lotsEnded: number;
    priceChanges: number;
    peakViewers: number;
  };
  /** What it did. */
  actions: { proposed: number; committed: number; rolledBack: number; failed: number };
  /**
   * What to fix before the next show.
   *
   * The most useful thing in the report, and the reason it is worth generating
   * at all: every question the copilot could NOT answer is a hole in the
   * catalog, and the list of them is the input to the next session's setup. A
   * report that only counted successes would tell a seller nothing they could
   * act on.
   */
  gaps: {
    unanswered: { question: string; asked: number; reason: string }[];
    droppedByGate: Record<string, number>;
  };
}

export async function buildReport(
  d: Pool,
  showId: string,
  extra: { auditChain: { ok: boolean; height: number; brokenAt?: number } },
): Promise<ShowReport> {
  const show = (
    await d.query<{
      title: string; source: string; started_at: string; viewers: number;
    }>("SELECT title, source, started_at, viewers FROM shows WHERE id = $1", [showId])
  ).rows[0];
  if (!show) throw new Error(`no show ${showId}`);

  const chat = (
    await d.query<{ admitted: boolean; drop_reason: string | null; speech_act: string | null; text: string }>(
      "SELECT admitted, drop_reason, speech_act, text FROM chat_messages WHERE show_id = $1",
      [showId],
    )
  ).rows;

  const props = (
    await d.query<{
      status: string; verdict: string; confidence: number; abstained: boolean; repaired: boolean;
      latency_ms: number; cache_hit: boolean; guards: { guard: string; verdict: string; reason?: string }[];
      question: string; draft: string;
    }>(
      `SELECT status, verdict, confidence, abstained, repaired, latency_ms, cache_hit, guards, question, draft
       FROM reply_proposals WHERE show_id = $1`,
      [showId],
    )
  ).rows;

  const lat = props.map((p) => p.latency_ms).filter((n) => n > 0).sort((a, b) => a - b);
  const pick = (q: number) => (lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]!) : 0);

  const byGuard: Record<string, number> = {};
  const examples: ShowReport["safety"]["examples"] = [];
  for (const p of props) {
    for (const g of p.guards ?? []) {
      if (g.verdict === "allow" || g.verdict === "n/a") continue;
      byGuard[g.guard] = (byGuard[g.guard] ?? 0) + 1;
      // A handful of real blocks is worth more than a count: it is what lets a
      // seller judge whether the guard was right.
      if (g.verdict === "block" && examples.length < 5) {
        examples.push({
          question: p.question, draft: p.draft.slice(0, 160),
          guard: g.guard, reason: (g.reason ?? "").slice(0, 200),
        });
      }
    }
  }

  const droppedByGate: Record<string, number> = {};
  for (const c of chat) {
    if (c.admitted || !c.drop_reason) continue;
    droppedByGate[c.drop_reason] = (droppedByGate[c.drop_reason] ?? 0) + 1;
  }

  // Unanswered = a real question that produced no sendable answer. Grouped by
  // text so "do you ship to canada" asked nine times reads as one gap, not nine.
  const unansweredMap = new Map<string, { asked: number; reason: string }>();
  for (const p of props) {
    const failed = p.abstained || p.verdict === "block" || Number(p.confidence) < 0.3;
    if (!failed) continue;
    const key = p.question.trim().toLowerCase().slice(0, 120);
    const prev = unansweredMap.get(key);
    const reason = p.abstained ? "nothing in the catalog matched" : `${p.verdict} by a guardrail`;
    unansweredMap.set(key, { asked: (prev?.asked ?? 0) + 1, reason: prev?.reason ?? reason });
  }
  const unanswered = [...unansweredMap.entries()]
    .map(([question, v]) => ({ question, ...v }))
    .sort((a, b) => b.asked - a.asked)
    .slice(0, 15);

  const listings = (
    await d.query<{ observed: number; ended: number; churn: number }>(
      `SELECT count(*) FILTER (WHERE external_ref IS NOT NULL)::int AS observed,
              count(*) FILTER (WHERE state = 'ended')::int AS ended,
              COALESCE(sum(version - 1), 0)::int AS churn
       FROM listings WHERE show_id = $1`,
      [showId],
    )
  ).rows[0]!;

  const acts = (
    await d.query<{ status: string; n: number }>(
      "SELECT status, count(*)::int AS n FROM actions WHERE show_id = $1 GROUP BY status",
      [showId],
    )
  ).rows;
  const actCount = (s: string) => acts.find((a) => a.status === s)?.n ?? 0;

  const started = new Date(show.started_at).getTime();
  const sent = props.filter((p) => p.status === "sent" || p.status === "auto_sent").length;
  const questions = chat.filter((c) => c.admitted).length;

  return {
    showId,
    title: show.title,
    source: show.source,
    startedAt: show.started_at,
    endedAt: new Date().toISOString(),
    durationMin: Math.max(0, Math.round((Date.now() - started) / 60_000)),
    engagement: {
      commentsSeen: chat.length,
      questionsAsked: questions,
      answered: props.filter((p) => !p.abstained && p.verdict !== "block").length,
      sent,
      answeredRate: questions ? Number((sent / questions).toFixed(3)) : 0,
      medianLatencyMs: pick(0.5),
      p95LatencyMs: pick(0.95),
      cacheHitRate: props.length
        ? Number((props.filter((p) => p.cache_hit).length / props.length).toFixed(3))
        : 0,
    },
    safety: {
      blocked: props.filter((p) => p.verdict === "block").length,
      revised: props.filter((p) => p.repaired).length,
      abstained: props.filter((p) => p.abstained).length,
      byGuard,
      auditChain: extra.auditChain,
      examples,
    },
    inventory: {
      lotsObserved: listings.observed,
      lotsEnded: listings.ended,
      priceChanges: listings.churn,
      peakViewers: show.viewers,
    },
    actions: {
      proposed: acts.reduce((a, x) => a + x.n, 0),
      committed: actCount("committed"),
      rolledBack: actCount("rolled_back"),
      failed: actCount("failed"),
    },
    gaps: { unanswered, droppedByGate },
  };
}
