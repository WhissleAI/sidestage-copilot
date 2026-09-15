// The whole record of one show, read back from the tables that kept it.
//
// The report is a statement — counts and rates, written once. This is the
// evidence behind it: every comment, every proposal with its verdicts, every
// action, every audit entry. The console had it while the show ran; once the
// runtime was gone nothing could read it, so the report's "96 answered" could
// not be opened to see the 96. The export is the same object with the report
// and the timeline attached — everything the product knows about a show, in
// one file a seller can hand to someone who was not there.

import type { Pool } from "../db/pg.js";

export interface RecordedProposal {
  id: string;
  messageId: string | null;
  at: string;
  decidedAt: string | null;
  author: string;
  question: string;
  intent: string | null;
  draft: string;
  sentText: string | null;
  status: string;
  verdict: string;
  confidence: number;
  abstained: boolean;
  repaired: boolean;
  edited: boolean;
  latencyMs: number;
  cacheHit: boolean;
  guards: { guard: string; verdict: string; reason?: string }[];
  evidence: unknown[];
  flaggedWrong: boolean;
  flagReason: string | null;
}

export interface RecordedAction {
  id: string;
  kind: string;
  createdAt: string;
  status: string;
  listingId: string | null;
  listingTitle: string | null;
  summary: string;
  rationale: string | null;
  preflight: unknown;
  error: string | null;
  idempotencyKey: string;
}

export interface RecordedAudit {
  seq: number;
  at: string;
  kind: string;
  actorType: string;
  actorId: string | null;
  summary: string;
  hash: string;
  prevHash: string | null;
  detail: unknown;
}

export interface RecordedChat {
  id: string;
  at: string;
  author: string;
  text: string;
  intent: string | null;
  speechAct: string | null;
  admitted: boolean;
  dropReason: string | null;
}

export interface ShowRecord {
  showId: string;
  chat: RecordedChat[];
  proposals: RecordedProposal[];
  actions: RecordedAction[];
  audit: RecordedAudit[];
}

export async function showRecord(d: Pool, showId: string): Promise<ShowRecord> {
  const [chat, props, acts, audit] = await Promise.all([
    d.query<{
      id: string; at: string; author: string; text: string; intent: string | null;
      speech_act: string | null; admitted: boolean; drop_reason: string | null;
    }>(
      `SELECT id, at, author, text, intent, speech_act, admitted, drop_reason
         FROM chat_messages WHERE show_id = $1 ORDER BY at`,
      [showId],
    ),
    d.query<{
      id: string; message_id: string | null; at: string; decided_at: string | null; author: string;
      question: string; intent: string | null; draft: string; sent_text: string | null; status: string;
      verdict: string; confidence: number; abstained: boolean; repaired: boolean; edited: boolean;
      latency_ms: number; cache_hit: boolean; guards: RecordedProposal["guards"]; evidence: unknown[];
      flagged_wrong: boolean; flag_reason: string | null;
    }>(
      `SELECT id, message_id, at, decided_at, author, question, intent, draft, sent_text, status, verdict,
              confidence, abstained, repaired, edited, latency_ms, cache_hit, guards, evidence,
              flagged_wrong, flag_reason
         FROM reply_proposals WHERE show_id = $1 ORDER BY at`,
      [showId],
    ),
    d.query<{
      id: string; kind: string; created_at: string; status: string; listing_id: string | null;
      listing_title: string | null; summary: string; rationale: string | null; preflight: unknown;
      error: string | null; idempotency_key: string;
    }>(
      `SELECT id, kind, created_at, status, listing_id, listing_title, summary, rationale, preflight,
              error, idempotency_key
         FROM actions WHERE show_id = $1 ORDER BY created_at`,
      [showId],
    ),
    d.query<{
      seq: number; at: string; kind: string; actor_type: string; actor_id: string | null;
      summary: string; hash: string; prev_hash: string | null; detail: unknown;
    }>(
      `SELECT seq, at, kind, actor_type, actor_id, summary, hash, prev_hash, detail
         FROM audit WHERE show_id = $1 ORDER BY seq`,
      [showId],
    ),
  ]);

  return {
    showId,
    chat: chat.rows.map((c) => ({
      id: c.id, at: c.at, author: c.author, text: c.text, intent: c.intent,
      speechAct: c.speech_act, admitted: c.admitted, dropReason: c.drop_reason,
    })),
    proposals: props.rows.map((p) => ({
      id: p.id, messageId: p.message_id, at: p.at, decidedAt: p.decided_at, author: p.author,
      question: p.question, intent: p.intent, draft: p.draft, sentText: p.sent_text, status: p.status,
      verdict: p.verdict, confidence: Number(p.confidence), abstained: p.abstained, repaired: p.repaired,
      edited: p.edited, latencyMs: p.latency_ms, cacheHit: p.cache_hit, guards: p.guards ?? [],
      evidence: p.evidence ?? [], flaggedWrong: p.flagged_wrong, flagReason: p.flag_reason,
    })),
    actions: acts.rows.map((a) => ({
      id: a.id, kind: a.kind, createdAt: a.created_at, status: a.status, listingId: a.listing_id,
      listingTitle: a.listing_title, summary: a.summary, rationale: a.rationale, preflight: a.preflight,
      error: a.error, idempotencyKey: a.idempotency_key,
    })),
    audit: audit.rows.map((e) => ({
      seq: e.seq, at: e.at, kind: e.kind, actorType: e.actor_type, actorId: e.actor_id,
      summary: e.summary, hash: e.hash, prevHash: e.prev_hash, detail: e.detail,
    })),
  };
}
