// Describe the frames a show kept, after the show.
//
// During the show a frame gets a twelve-word reading, because that reading is
// show context on a two-second reply budget. After the show the report's
// timeline wants more than "White Nike sneaker": which shoe, what size was on
// the card, what the host was doing with it. The same agent reads the same
// frame again with a fuller question, once, and the answer is stored beside
// the reading. Bounded: consecutive frames with the same short reading are
// one moment, and only the first is described; at most `max` per show.
import { readFileSync } from "node:fs";
import type { SessionSignals } from "./signals.js";

export interface FrameReader {
  readFrame(dataUrl: string, question: string, opts?: { maxTokens?: number }): Promise<string>;
}

export const DESCRIBE_QUESTION =
  "This is one frame from a live selling show, for the seller's post-show timeline. " +
  "In two short sentences and at most 45 words: name the item (brand, model, size, colour, " +
  "grade or condition where legible), quote any price, number or text visible on screen, and " +
  "say what the host is doing with it. Plain facts only, no description of lighting or " +
  "background. If no item is clearly visible, answer exactly: nothing clear.";

const inFlight = new Set<string>();

/** True while a describer is running for this show. */
export const describing = (showId: string): boolean => inFlight.has(showId);

export async function describeFrames(
  showId: string,
  signals: SessionSignals,
  reader: FrameReader,
  opts: { max?: number; concurrency?: number } = {},
): Promise<{ described: number; skipped: number }> {
  if (inFlight.has(showId)) return { described: 0, skipped: 0 };
  inFlight.add(showId);
  try {
    const all = await signals.frames(showId);
    // One description per moment: a run of frames that read the same is the
    // same lot on the table, and the first of them is the one worth the call.
    const todo: typeof all = [];
    let prev = "";
    for (const f of all) {
      const key = f.reading.trim().toLowerCase();
      if (key !== prev && f.description == null) todo.push(f);
      prev = key;
    }
    const picked = todo.slice(0, opts.max ?? 40);
    const conc = Math.max(1, opts.concurrency ?? 2);
    let described = 0;
    let i = 0;
    await Promise.all(
      Array.from({ length: conc }, async () => {
        while (i < picked.length) {
          const f = picked[i++]!;
          try {
            const ext = f.path.endsWith(".png") ? "png" : "jpeg";
            const dataUrl = `data:image/${ext};base64,${readFileSync(f.path).toString("base64")}`;
            const raw = await reader.readFrame(dataUrl, DESCRIBE_QUESTION, { maxTokens: 160 });
            const text = clean(raw);
            await signals.describe(showId, f.seq, text || "nothing clear");
            described++;
          } catch (e) {
            console.warn(`  frames: ${showId} #${f.seq} not described — ${(e as Error).message.slice(0, 120)}`);
          }
        }
      }),
    );
    return { described, skipped: all.length - picked.length };
  } finally {
    inFlight.delete(showId);
  }
}

/** The agent answers in its reply JSON shape sometimes; take the answer. */
function clean(raw: string): string {
  const t = raw.trim();
  const m = t.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const s = (m ? m[1]!.replace(/\\"/g, '"') : t).replace(/\s+/g, " ").trim();
  return s.length > 400 ? `${s.slice(0, 397)}…` : s;
}
