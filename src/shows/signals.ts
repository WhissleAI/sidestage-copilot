// The show's signals — what was heard and what was seen — persisted.
//
// One vocabulary, used everywhere this data appears:
//
//   signal      something measured from the show itself: an utterance, a frame,
//               a stretch of audio. Never a reply, never an action.
//   utterance   one finalised segment of host speech, with the metadata the
//               voice head measured alongside it.
//   reading     what the agent said was on screen when it looked at a frame.
//   timeline    all of the above on one clock, milliseconds from show start.
//
// Bytes go to disk under data/shows/<show>/{audio,frames}/; Postgres holds the
// index. A frame nobody interpreted is not kept — it is a JPEG, not a signal.

import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Pool } from "../db/pg.js";
import type { SignalDistribution, TranscriptSegment } from "../domain/types.js";

const ROOT = resolve(process.env.SHOW_MEDIA_DIR || "./data/shows");

export interface FrameRow {
  seq: number;
  at: string;
  offsetMs: number;
  path: string;
  bytes: number;
  reading: string;
  /** The fuller post-show reading (src/shows/frameDescriber.ts); null until written. */
  description: string | null;
}

export interface AudioRow {
  seq: number;
  at: string;
  offsetMs: number;
  durationMs: number;
  path: string;
  bytes: number;
  mime: string;
}

export interface Utterance {
  seq: number;
  at: string;
  offsetMs: number;
  text: string;
  emotion: SignalDistribution | null;
  intent: SignalDistribution | null;
  speechRate: number | null;
  levels: number[] | null;
}

/**
 * What the host did, over the whole show, as distributions.
 *
 * Probability MASS is summed, not top labels counted. Counting labels would
 * turn a run of 0.34-confidence "excited" into "the host was excited 80% of
 * the time"; summing mass says 34% of it, which is what was measured. The
 * difference is the whole point of storing distributions.
 */
export interface HostSummary {
  utterances: number;
  /** Seconds of host speech the transcript covers, from first to last utterance. */
  speakingSpanS: number;
  intent: { label: string; share: number }[];
  emotion: { label: string; share: number }[];
  /** Words per minute, median over utterances that reported one. */
  medianSpeechRate: number | null;
  /** Utterances whose top emotion differed from the previous one. A high
   *  number on a short show is a host being pulled around by chat. */
  emotionFlips: number;
  /** Loudest and quietest ten-second stretches, as offsets — where to jump. */
  loudestAtMs: number | null;
  quietestAtMs: number | null;
}

function mass(dists: (SignalDistribution | null)[]): { label: string; share: number }[] {
  const total = new Map<string, number>();
  let n = 0;
  for (const d of dists) {
    if (!d?.topK?.length) continue;
    n += 1;
    for (const { label, p } of d.topK) total.set(label, (total.get(label) ?? 0) + p);
  }
  if (!n) return [];
  return [...total.entries()]
    .map(([label, m]) => ({ label, share: m / n }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 6);
}

export class SessionSignals {
  constructor(private d: Pool) {}

  private dir(showId: string, kind: "audio" | "frames"): string {
    const p = join(ROOT, showId, kind);
    mkdirSync(p, { recursive: true });
    return p;
  }

  private async startedAt(showId: string): Promise<number> {
    const r = await this.d.query<{ started_at: string }>(
      "SELECT started_at FROM shows WHERE id = $1",
      [showId],
    );
    return r.rows[0] ? new Date(r.rows[0].started_at).getTime() : Date.now();
  }

  /** Fire-and-forget, like chat: a buyer's question must not wait on a write. */
  recordUtterance(seg: TranscriptSegment): void {
    void this.d
      .query(
        `INSERT INTO show_transcript (show_id, at, text, emotion, intent, speech_rate, levels)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
        [
          seg.showId, seg.at, seg.text,
          seg.emotion ? JSON.stringify(seg.emotion) : null,
          seg.intent ? JSON.stringify(seg.intent) : null,
          seg.speechRate, seg.levels ?? null,
        ],
      )
      .catch(() => {});
  }

  /** The frame the agent read, kept beside what it read. */
  async recordFrame(showId: string, dataUrl: string, reading: string): Promise<FrameRow | null> {
    const m = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/i);
    if (!m) return null;
    const ext = m[1] === "image/png" ? "png" : "jpg";
    const buf = Buffer.from(m[2]!, "base64");
    const at = new Date();
    const file = join(this.dir(showId, "frames"), `${at.getTime()}.${ext}`);
    writeFileSync(file, buf);
    const r = await this.d.query<{ seq: number }>(
      `INSERT INTO show_frames (show_id, at, path, bytes, reading)
       VALUES ($1,$2,$3,$4,$5) RETURNING seq`,
      [showId, at.toISOString(), file, buf.length, reading],
    );
    return {
      seq: r.rows[0]!.seq, at: at.toISOString(),
      offsetMs: at.getTime() - (await this.startedAt(showId)),
      path: file, bytes: buf.length, reading, description: null,
    };
  }

  /** One chunk of the host's audio. `seq` comes from the bridge, so a retried
   *  upload replaces rather than duplicates. */
  /** The post-show description of one frame. */
  async describe(showId: string, seq: number, description: string): Promise<void> {
    await this.d.query("UPDATE show_frames SET description = $3 WHERE show_id = $1 AND seq = $2", [showId, seq, description]);
  }

  /**
   * One chunk of the host's audio. The sequence number is assigned HERE, not by
   * the bridge: a bridge page reopened mid-show restarts its own count at 0,
   * and keying on that overwrote the first minutes of a show with the next
   * ones. `clientKey` (bridge run + its chunk number) is what makes a retry
   * replace its own row instead of appending a duplicate.
   */
  async recordAudio(
    showId: string,
    clientKey: string | null,
    buf: Buffer,
    opts: { durationMs: number; mime: string },
  ): Promise<AudioRow> {
    const at = new Date();
    const offsetMs = Math.max(0, at.getTime() - opts.durationMs - (await this.startedAt(showId)));
    const existing = clientKey
      ? await this.d.query<{ seq: number }>("SELECT seq FROM show_audio WHERE show_id = $1 AND client_key = $2", [showId, clientKey])
      : null;
    let seq: number;
    if (existing?.rowCount) {
      seq = existing.rows[0]!.seq;
    } else {
      const next = await this.d.query<{ seq: number }>("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM show_audio WHERE show_id = $1", [showId]);
      seq = Number(next.rows[0]!.seq);
    }
    const file = join(this.dir(showId, "audio"), `${String(seq).padStart(6, "0")}.webm`);
    writeFileSync(file, buf);
    await this.d.query(
      `INSERT INTO show_audio (show_id, seq, at, offset_ms, duration_ms, path, bytes, mime, client_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (show_id, seq) DO UPDATE SET
         at = EXCLUDED.at, offset_ms = EXCLUDED.offset_ms, duration_ms = EXCLUDED.duration_ms,
         path = EXCLUDED.path, bytes = EXCLUDED.bytes, mime = EXCLUDED.mime, client_key = EXCLUDED.client_key`,
      [showId, seq, at.toISOString(), offsetMs, opts.durationMs, file, buf.length, opts.mime, clientKey],
    );
    return { seq, at: at.toISOString(), offsetMs, durationMs: opts.durationMs, path: file, bytes: buf.length, mime: opts.mime };
  }

  async utterances(showId: string): Promise<Utterance[]> {
    const started = await this.startedAt(showId);
    const r = await this.d.query<{
      seq: number; at: string; text: string; emotion: SignalDistribution | null;
      intent: SignalDistribution | null; speech_rate: number | null; levels: number[] | null;
    }>(
      `SELECT seq, at, text, emotion, intent, speech_rate, levels
         FROM show_transcript WHERE show_id = $1 ORDER BY at`,
      [showId],
    );
    return r.rows.map((x) => ({
      seq: x.seq, at: x.at, offsetMs: new Date(x.at).getTime() - started, text: x.text,
      emotion: x.emotion, intent: x.intent, speechRate: x.speech_rate, levels: x.levels,
    }));
  }

  async frames(showId: string): Promise<FrameRow[]> {
    const started = await this.startedAt(showId);
    const r = await this.d.query<{ seq: number; at: string; path: string; bytes: number; reading: string; description: string | null }>(
      "SELECT seq, at, path, bytes, reading, description FROM show_frames WHERE show_id = $1 ORDER BY at",
      [showId],
    );
    return r.rows.map((x) => ({ ...x, offsetMs: new Date(x.at).getTime() - started }));
  }

  async audio(showId: string): Promise<AudioRow[]> {
    const r = await this.d.query<{
      seq: number; at: string; offset_ms: number; duration_ms: number; path: string; bytes: number; mime: string;
    }>(
      "SELECT seq, at, offset_ms, duration_ms, path, bytes, mime FROM show_audio WHERE show_id = $1 ORDER BY seq",
      [showId],
    );
    return r.rows.map((x) => ({
      seq: x.seq, at: x.at, offsetMs: x.offset_ms, durationMs: x.duration_ms,
      path: x.path, bytes: x.bytes, mime: x.mime,
    }));
  }

  async frame(showId: string, seq: number): Promise<FrameRow | null> {
    const all = await this.frames(showId);
    return all.find((f) => f.seq === seq) ?? null;
  }

  async audioChunk(showId: string, seq: number): Promise<AudioRow | null> {
    const all = await this.audio(showId);
    return all.find((a) => a.seq === seq) ?? null;
  }

  async hostSummary(showId: string): Promise<HostSummary | null> {
    const u = await this.utterances(showId);
    if (!u.length) return null;

    const rates = u.map((x) => x.speechRate).filter((x): x is number => typeof x === "number" && x > 0);
    const sorted = [...rates].sort((a, b) => a - b);
    const medianRate = sorted.length
      ? sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]!
        : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
      : null;

    let flips = 0;
    let prev: string | null = null;
    for (const x of u) {
      const top = x.emotion?.topLabel ?? null;
      if (top && prev && top !== prev) flips += 1;
      if (top) prev = top;
    }

    // Loudness per utterance from its own envelope; extremes as offsets.
    let loudest: { v: number; at: number } | null = null;
    let quietest: { v: number; at: number } | null = null;
    for (const x of u) {
      if (!x.levels?.length) continue;
      const v = x.levels.reduce((a, b) => a + b, 0) / x.levels.length;
      if (!loudest || v > loudest.v) loudest = { v, at: x.offsetMs };
      if (!quietest || v < quietest.v) quietest = { v, at: x.offsetMs };
    }

    return {
      utterances: u.length,
      speakingSpanS: Math.max(0, Math.round((u[u.length - 1]!.offsetMs - u[0]!.offsetMs) / 1000)),
      intent: mass(u.map((x) => x.intent)),
      emotion: mass(u.map((x) => x.emotion)),
      medianSpeechRate: medianRate,
      emotionFlips: flips,
      loudestAtMs: loudest?.at ?? null,
      quietestAtMs: quietest?.at ?? null,
    };
  }

  /** Delete every byte on disk for a show. Called when the session is deleted. */
  purge(showId: string): void {
    const p = join(ROOT, showId);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
}
