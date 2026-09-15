// Persisting what a session actually was, and reporting on it afterwards.
//
// Chat and reply proposals used to live only in maps on the ShowRuntime, so a
// restart erased the entire record of what buyers asked and what the copilot
// answered. Listings and the audit chain survived; the conversation did not.
//
// Writes here are fire-and-forget on purpose. A buyer's question must never wait
// on a database round trip to reach the seller, and losing one row from a report
// is a smaller failure than adding latency to every reply.

//
// The report's vocabulary — one word per thing, used by the API, the console
// and the docs alike:
//
//   signals      what was measured from the show itself: the host's utterances
//                (with emotion and intent distributions), the frames the agent
//                read, the audio. Never a reply. See signals.ts.
//   proposals    replies drafted for the seller; verdicts are what the guards
//                said about them (allow · revise · block).
//   actions      writes to listings — proposed, committed, rolled back.
//   gaps         buyer questions the catalog could not ground.
//   conclusion   what the agent concluded at the end: summary, outcome, next
//                actions. See conclusion.ts.
//
// The five sections a seller reads, in order: Did it help (engagement) · What
// the host did (host) · Can I trust it (safety) · What the agent concluded
// (conclusion) · Fix before the next show (gaps + next actions).

import type { Pool } from "../db/pg.js";
import type { ChatMessage, ReplyProposal } from "../domain/types.js";
import { prdMetrics, type PrdMetrics } from "./prdMetrics.js";
import type { HostSummary, SessionSignals } from "./signals.js";
import type { Conclusion, ConclusionEvidence } from "./conclusion.js";
import type { PlatformSessionSummary } from "../llm/sessions.js";

/** Statuses that mean the seller acted on it. */
const DECIDED = new Set(["sent", "dismissed"]);

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

  /**
   * The last few minutes of chat, for a console that just connected.
   *
   * A show runs for hours and a console can be opened at any point in it — or
   * reopened after a reload. Without this the firehose column starts empty and
   * stays empty until the next buyer types, which reads as a broken feed rather
   * than a late arrival. Dropped messages come back too: the gate's refusals
   * are half of what the column is for.
   */
  async recentChat(limit = 60): Promise<ChatMessage[]> {
    const { rows } = await this.d.query<{
      id: string; author: string; text: string; at: string;
      intent: string | null; speech_act: string | null;
      admitted: boolean; drop_reason: string | null;
    }>(
      `SELECT id, author, text, at, intent, speech_act, admitted, drop_reason
         FROM chat_messages WHERE show_id = $1 ORDER BY at DESC LIMIT $2`,
      [this.showId, limit],
    );
    return rows
      .map((r) => ({
        id: r.id,
        author: r.author,
        text: r.text,
        at: r.at,
        intent: r.intent as ChatMessage["intent"],
        speechAct: r.speech_act as ChatMessage["speechAct"],
        admitted: r.admitted,
        ...(r.drop_reason ? { dropReason: r.drop_reason } : {}),
      }))
      .reverse();
  }

  recordProposal(p: ReplyProposal): void {
    // A draft in flight is not a record of anything; wait until it settles.
    if (p.status === "drafting") return;
    void this.d
      .query(
        `INSERT INTO reply_proposals (show_id, id, message_id, author, question, draft, sent_text,
           status, verdict, confidence, repaired, abstained, latency_ms, cache_hit, guards, evidence, intent, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18,$19,$20)
         ON CONFLICT (show_id, id) DO UPDATE SET
           draft = EXCLUDED.draft, sent_text = EXCLUDED.sent_text, status = EXCLUDED.status,
           verdict = EXCLUDED.verdict, confidence = EXCLUDED.confidence,
           guards = EXCLUDED.guards, evidence = EXCLUDED.evidence,
           -- Stamped the first time the seller acts and never moved after, so a
           -- later status change cannot rewrite how long they took to decide.
           decided_at = COALESCE(reply_proposals.decided_at, EXCLUDED.decided_at),
           edited = reply_proposals.edited OR EXCLUDED.edited`,
        [
          this.showId, p.id, p.message.id, p.message.author, p.message.text,
          p.draft ?? "", p.sentText ?? null, p.status, p.verdict, p.confidence,
          p.repaired, p.evidence.length === 0, p.spans?.totalMs ?? 0, p.spans?.cacheHit ?? false,
          JSON.stringify(p.guards ?? []), JSON.stringify(p.evidence ?? []),
          p.message.intent ?? null, p.message.at,
          // A seller has DECIDED when they send or dismiss. Anything else is
          // still sitting in the queue, and counting it as a slow decision
          // would make an ignored proposal look like a considered one.
          DECIDED.has(p.status) ? new Date().toISOString() : null,
          Boolean(p.sentText && p.sentText.trim() !== (p.draft ?? "").trim()),
        ],
      )
      .catch(() => {});
  }
}

// ── the report ──────────────────────────────────────────────────────────────

export interface ShowReport {
  showId: string;
  catalogId?: string | null;
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
    /**
     * Replies the OPERATOR marked wrong after they were sent.
     *
     * The PRD lists "wrong replies reaching a buyer" as not self-measurable,
     * which is true — a reply this system judged correct is exactly the one it
     * cannot mark wrong. This is the human's count, and it is a FLOOR: it
     * counts the ones somebody noticed. Every surface that renders it says so.
     */
    flaggedWrong: number;
    flagReasons: Record<string, number>;
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
  /** Every number docs/PRD.md §4 promises, computed. Carried on the report so a
   *  reviewer can diff the document against a real show rather than the code. */
  prd: PrdMetrics;
  /**
   * What the host did — from their own speech, not from chat.
   *
   * Distributions summed as probability mass over every utterance; null when
   * host audio was never captured, which the page must say rather than draw
   * an empty chart. The platform's own account of the same audio session sits
   * beside it when the gateway produced one: two measurements of one show,
   * shown as two.
   */
  host: HostSummary | null;
  platform: PlatformSessionSummary | null;
  /** What was kept to play back: counts, so the page knows whether to offer a timeline. */
  media: { utterances: number; frames: number; audioChunks: number; audioSeconds: number };
  /** What the agent concluded. Null when it could not answer; the page says so. */
  conclusion: Conclusion | null;
}

export async function buildReport(
  d: Pool,
  showId: string,
  extra: {
    auditChain: { ok: boolean; height: number; brokenAt?: number };
    /** The persisted signals, when the caller has them. Tests build reports without. */
    signals?: SessionSignals;
    /** The platform's account of the audio session, fetched by the caller. */
    platform?: () => Promise<PlatformSessionSummary | null>;
    /** The agent's conclusion, given the evidence the report assembled. */
    conclude?: (e: ConclusionEvidence) => Promise<Conclusion | null>;
  },
): Promise<ShowReport> {
  const show = (
    await d.query<{
      title: string; source: string; started_at: string; viewers: number; catalog_id: string | null;
      seller_handle: string | null;
    }>("SELECT title, source, started_at, viewers, catalog_id, seller_handle FROM shows WHERE id = $1", [showId])
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
      question: string; draft: string; flagged_wrong: boolean; flag_reason: string | null;
    }>(
      `SELECT status, verdict, confidence, abstained, repaired, latency_ms, cache_hit, guards, question, draft,
              flagged_wrong, flag_reason
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

  // Signals, when the caller keeps them. Each read is independent and none is
  // allowed to sink the report: a show with no audio still had a chat.
  const sig = extra.signals;
  const [host, utterances, frames, audio, platform] = await Promise.all([
    sig ? sig.hostSummary(showId).catch(() => null) : null,
    sig ? sig.utterances(showId).catch(() => []) : [],
    sig ? sig.frames(showId).catch(() => []) : [],
    sig ? sig.audio(showId).catch(() => []) : [],
    extra.platform ? extra.platform().catch(() => null) : null,
  ]);
  const media = {
    utterances: utterances.length,
    frames: frames.length,
    audioChunks: audio.length,
    audioSeconds: Math.round(audio.reduce((a, c) => a + c.durationMs, 0) / 1000),
  };
  const prd = await prdMetrics(d, showId);

  const report: ShowReport = {
    showId,
    title: show.title,
    source: show.source,
    // Which inventory this show ran on, so the gaps list has somewhere to write
    // an answer back to. Absent on reports generated before this existed.
    catalogId: show.catalog_id,
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
      // What a human caught that the system could not. A floor, never a total.
      flaggedWrong: props.filter((p) => p.flagged_wrong).length,
      flagReasons: props.reduce<Record<string, number>>((acc, p) => {
        if (!p.flagged_wrong) return acc;
        const k = p.flag_reason ?? "unspecified";
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
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
    prd,
    host,
    platform,
    media,
    conclusion: null,
  };

  // Last, and from the finished numbers: the conclusion is the agent reading
  // this report, not the report reading the agent.
  if (extra.conclude) {
    const every = <T extends { offsetMs: number }>(n: number, xs: T[]): T[] =>
      xs.filter((_, i) => i % Math.max(1, Math.ceil(xs.length / n)) === 0).slice(0, n);
    report.conclusion = await extra.conclude({
      title: show.title,
      host: show.seller_handle ?? "the host",
      durationMin: report.durationMin,
      engagement: {
        commentsSeen: report.engagement.commentsSeen,
        questionsAsked: report.engagement.questionsAsked,
        answered: report.engagement.answered,
        sent: report.engagement.sent,
        p95LatencyMs: report.engagement.p95LatencyMs,
      },
      safety: {
        blocked: report.safety.blocked,
        revised: report.safety.revised,
        abstained: report.safety.abstained,
        flaggedWrong: report.safety.flaggedWrong,
        byGuard: report.safety.byGuard,
      },
      actions: report.actions,
      inventory: report.inventory,
      gaps: unanswered.slice(0, 10),
      hostSignals: host,
      onScreen: every(8, frames).map((f) => ({ offsetMs: f.offsetMs, reading: f.reading })),
      said: every(12, utterances).map((u) => ({
        offsetMs: u.offsetMs, text: u.text,
        emotion: u.emotion?.topLabel ?? null, intent: u.intent?.topLabel ?? null,
      })),
      gmv: prd.gmv.lotsSold ? { grossCents: prd.gmv.grossCents, lotsSold: prd.gmv.lotsSold } : null,
      platformSummary: platform?.summary?.summary ?? null,
    });
  }
  return report;
}
